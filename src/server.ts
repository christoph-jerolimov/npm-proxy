import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Cache } from "./cache.js";
import type { Config } from "./config.js";
import { consoleLogger, paintStatus, paintTag, type Logger } from "./log.js";
import { evaluate } from "./policy.js";
import { HOP_BY_HOP, Upstream, UpstreamError, type Advisory, type Packument } from "./registry.js";

export interface ProxyServerOptions {
  logger?: Logger;
}

export interface ProxyAddress {
  host: string;
  port: number;
  url: string;
}

export interface ProxyServer {
  /** Starts listening. `port` and `host` default to the configuration; use port 0 for a random port. */
  start(port?: number, host?: string): Promise<ProxyAddress>;
  stop(): Promise<void>;
  address(): ProxyAddress;
}

type Tag = "HIT" | "MISS" | "DENY" | "PROXY" | "ERROR";

export function createProxyServer(config: Config, options: ProxyServerOptions = {}): ProxyServer {
  const log = options.logger ?? consoleLogger;
  const upstream = new Upstream(new URL(config.upstream));
  const cache = new Cache(config.cacheDir, upstream.url);
  let address: ProxyAddress | undefined;

  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    let tag: Tag = "PROXY";
    const setTag = (t: Tag) => {
      tag = t;
    };

    res.once("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.http(`${paintTag(tag)} ${req.method ?? "GET"} ${req.url ?? "/"} ${paintStatus(res.statusCode)} ${ms.toFixed(1)}ms`);
    });

    handle(req, res, setTag).catch((error: unknown) => {
      setTag("ERROR");
      const message = error instanceof Error ? error.message : String(error);
      log.error(`${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) sendJson(res, 502, { error: `npm-proxy: ${message}` });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, setTag: (t: Tag) => void): Promise<void> {
    const tarball = req.method === "GET" ? parseTarballPath(req.url ?? "/") : undefined;
    if (tarball) return serveTarball(req, res, tarball.name, tarball.version, setTag);
    return forward(req, res, setTag);
  }

  async function serveTarball(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    version: string,
    setTag: (t: Tag) => void,
  ): Promise<void> {
    const packument = await loadPackument(name, version);
    if (!packument) {
      // Not a package we can reason about (or upstream has no such version): let upstream answer.
      return forward(req, res, setTag);
    }
    const advisories = await loadAdvisories(name, version);
    const verdict = evaluate(name, version, packument, advisories, config.deny);

    if (!verdict.allow) {
      setTag("DENY");
      log.deny([`${name}@${version} (${verdict.codes.join(", ")})`, ...verdict.reasons, `recommendation: ${verdict.recommendation}`]);
      sendJson(res, 403, {
        error: `npm-proxy refused ${name}@${version}: ${verdict.codes.join(", ")}`,
        reasons: verdict.reasons,
        recommendation: verdict.recommendation,
      });
      return;
    }

    const file = cache.tarballPath(name, version);
    const stat = await cache.stat(file);
    if (stat) {
      setTag("HIT");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": stat.size,
        "x-npm-proxy-cache": "hit",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    setTag("MISS");
    const upstreamRes = await upstream.fetchTarball(req.url ?? "/");
    if (!upstreamRes.ok || !upstreamRes.body) {
      setTag("ERROR");
      log.warn(`upstream returned ${upstreamRes.status} for ${name}@${version}; not caching`);
      res.writeHead(upstreamRes.status, filterHeaders(upstreamRes.headers));
      if (upstreamRes.body) Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
      else res.end();
      return;
    }

    const writer = await cache.createTarballWriter(name, version);
    const expected = packument.versions[version]?.dist;
    const hash = crypto.createHash(expected?.integrity?.startsWith("sha512-") ? "sha512" : "sha1");
    const body = Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream);
    let failed = false;

    const fail = (reason: string) => {
      if (failed) return;
      failed = true;
      log.warn(`download of ${name}@${version} failed (${reason}); not caching`);
      writer.stream.destroy();
      void writer.abort();
    };

    body.on("data", (chunk: Buffer) => hash.update(chunk));
    body.on("error", (error) => {
      fail(error.message);
      res.destroy(error);
    });
    writer.stream.on("error", (error) => fail(error.message));
    writer.stream.on("finish", () => {
      if (failed) return;
      const mismatch = integrityMismatch(hash, expected);
      if (mismatch) {
        fail(mismatch);
        return;
      }
      writer.commit().catch((error: Error) => fail(error.message));
    });
    // If the client goes away keep downloading so the cache still gets populated.
    res.on("close", () => {
      if (!res.writableFinished) body.unpipe(res);
    });

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      ...(upstreamRes.headers.get("content-length") ? { "content-length": upstreamRes.headers.get("content-length")! } : {}),
      "x-npm-proxy-cache": "miss",
    });
    body.pipe(writer.stream);
    body.pipe(res);
  }

  /** Returns the cached package document, refreshing it from upstream when the version is unknown. */
  async function loadPackument(name: string, version: string): Promise<Packument | undefined> {
    const file = cache.packumentPath(name);
    let packument = await cache.readJson<Packument>(file);
    if (packument?.versions?.[version]) return packument;

    log.info(`fetching package info for ${name} (${packument ? `version ${version} unknown` : "first download"})`);
    try {
      packument = await upstream.fetchPackument(name);
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) return undefined;
      throw error;
    }
    await cache.writeJson(file, packument);
    return packument.versions?.[version] ? packument : undefined;
  }

  /** Returns the advisories for `name@version`, fetching and caching them on first sight. */
  async function loadAdvisories(name: string, version: string): Promise<Advisory[]> {
    const file = cache.advisoriesPath(name);
    const known = (await cache.readJson<Record<string, Advisory[]>>(file)) ?? {};
    if (known[version]) return known[version];

    try {
      const advisories = await upstream.fetchAdvisories(name, version);
      known[version] = advisories;
      await cache.writeJson(file, known);
      return advisories;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`could not fetch security advisories for ${name}@${version}: ${message}; continuing without them`);
      return [];
    }
  }

  /** Delegates any other request to upstream, rewriting tarball URLs in package documents to point at the proxy. */
  async function forward(req: IncomingMessage, res: ServerResponse, setTag: (t: Tag) => void): Promise<void> {
    setTag("PROXY");
    const upstreamRes = await upstream.forward(req);
    const headers = filterHeaders(upstreamRes.headers);

    if (req.method === "GET" && isPackageDocument(req.url ?? "/", upstreamRes)) {
      const text = await upstreamRes.text();
      const rewritten = rewriteTarballUrls(text, selfOrigin(req));
      res.writeHead(upstreamRes.status, { ...headers, "content-length": Buffer.byteLength(rewritten) });
      res.end(rewritten);
      return;
    }

    res.writeHead(upstreamRes.status, headers);
    if (upstreamRes.body && req.method !== "HEAD") {
      Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
    } else {
      res.end();
    }
  }

  function selfOrigin(req: IncomingMessage): string {
    const host = req.headers.host ?? `${address?.host ?? config.host}:${address?.port ?? config.port}`;
    return `http://${host}`;
  }

  return {
    async start(port = config.port, host = config.host) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const info = server.address();
      if (!info || typeof info === "string") throw new Error("server has no TCP address");
      const shownHost = info.family === "IPv6" && !host.includes(":") ? host : info.address;
      address = { host: shownHost, port: info.port, url: `http://${formatHost(shownHost)}:${info.port}` };
      return address;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    address() {
      if (!address) throw new Error("server is not listening");
      return address;
    },
  };
}

/** Matches `/<name>/-/<name>-<version>.tgz`, including scoped and URL-encoded names. */
export function parseTarballPath(url: string): { name: string; version: string } | undefined {
  const pathname = decodeURIComponent(url.split("?")[0] ?? "");
  const match = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/([^/]+)\.tgz$/.exec(pathname);
  if (!match) return undefined;
  const [, name = "", file = ""] = match;
  const base = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  if (!file.startsWith(`${base}-`)) return undefined;
  const version = file.slice(base.length + 1);
  return version ? { name, version } : undefined;
}

function isPackageDocument(url: string, res: Response): boolean {
  const pathname = url.split("?")[0] ?? "/";
  if (pathname.startsWith("/-/")) return false;
  const type = res.headers.get("content-type") ?? "";
  return res.ok && type.includes("json");
}

/** Points every `dist.tarball` in a package document at the proxy so downloads come back through it. */
export function rewriteTarballUrls(json: string, origin: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return json;
  }
  if (!doc || typeof doc !== "object") return json;

  const rewriteDist = (entry: unknown) => {
    const dist = (entry as { dist?: { tarball?: unknown } } | undefined)?.dist;
    if (dist && typeof dist.tarball === "string") {
      try {
        const u = new URL(dist.tarball);
        dist.tarball = `${origin}${u.pathname}`;
      } catch {
        /* leave unparsable URLs alone */
      }
    }
  };

  const versions = (doc as { versions?: Record<string, unknown> }).versions;
  if (versions && typeof versions === "object") {
    for (const entry of Object.values(versions)) rewriteDist(entry);
  } else {
    // A single version document, e.g. GET /lodash/4.17.23.
    rewriteDist(doc);
  }
  return JSON.stringify(doc);
}

function filterHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) out[key] = value;
  });
  return out;
}

function integrityMismatch(hash: crypto.Hash, dist: Packument["versions"][string]["dist"] | undefined): string | undefined {
  if (!dist) return undefined;
  if (dist.integrity?.startsWith("sha512-")) {
    const actual = `sha512-${hash.digest("base64")}`;
    return actual === dist.integrity ? undefined : `integrity mismatch: expected ${dist.integrity}, got ${actual}`;
  }
  if (dist.shasum) {
    const actual = hash.digest("hex");
    return actual === dist.shasum ? undefined : `shasum mismatch: expected ${dist.shasum}, got ${actual}`;
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
