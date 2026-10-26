import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "./config.js";
import { silentLogger } from "./log.js";
import { createProxyServer, parseTarballPath, rewriteTarballUrls, type ProxyServer } from "./server.js";

/** A fake upstream registry with one package: demo@1.0.0 (deprecated), 1.0.1 (clean), 1.0.2 (insecure). */
const tarballs: Record<string, Buffer> = {
  "1.0.0": Buffer.from("tarball 1.0.0"),
  "1.0.1": Buffer.from("tarball 1.0.1"),
  "1.0.2": Buffer.from("tarball 1.0.2"),
};
const integrity = (buf: Buffer) => `sha512-${crypto.createHash("sha512").update(buf).digest("base64")}`;
const requests: string[] = [];
let upstreamUrl = "";
let proxy: ProxyServer;
let proxyUrl = "";
let cacheDir = "";

const upstream = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const url = req.url ?? "/";
  if (url === "/demo") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: "demo",
        "dist-tags": { latest: "1.0.2" },
        versions: Object.fromEntries(
          Object.entries(tarballs).map(([v, buf]) => [
            v,
            {
              version: v,
              ...(v === "1.0.0" ? { deprecated: "please upgrade" } : {}),
              dist: { tarball: `${upstreamUrl}/demo/-/demo-${v}.tgz`, integrity: integrity(buf) },
            },
          ]),
        ),
      }),
    );
    return;
  }
  if (url === "/-/npm/v1/security/advisories/bulk" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const asked = JSON.parse(body) as Record<string, string[]>;
      const hit = asked.demo?.includes("1.0.2");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(hit ? { demo: [{ id: 1, url: "https://example.test/adv", title: "demo is exploitable", severity: "high", vulnerable_versions: "1.0.2" }] } : {}));
    });
    return;
  }
  const tarball = /^\/demo\/-\/demo-(.+)\.tgz$/.exec(url);
  if (tarball && tarballs[tarball[1]!]) {
    res.setHeader("content-type", "application/octet-stream");
    res.end(tarballs[tarball[1]!]);
    return;
  }
  if (url === "/-/ping") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pong: true, method: req.method }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-proxy-cache-"));
  const config: Config = { upstream: upstreamUrl, host: "127.0.0.1", port: 0, cacheDir, deny: { deprecated: true, insecure: true, minSeverity: "low" } };
  proxy = createProxyServer(config, { logger: silentLogger });
  proxyUrl = (await proxy.start(0)).url;
});

after(async () => {
  await proxy.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

test("parseTarballPath handles plain, scoped and encoded names", () => {
  assert.deepEqual(parseTarballPath("/lodash/-/lodash-4.17.23.tgz"), { name: "lodash", version: "4.17.23" });
  assert.deepEqual(parseTarballPath("/@types/node/-/node-22.0.0.tgz?x=1"), { name: "@types/node", version: "22.0.0" });
  assert.deepEqual(parseTarballPath("/@types%2Fnode/-/node-22.0.0.tgz"), { name: "@types/node", version: "22.0.0" });
  assert.equal(parseTarballPath("/lodash"), undefined);
  assert.equal(parseTarballPath("/lodash/-/other-1.0.0.tgz"), undefined);
});

test("rewriteTarballUrls points dist.tarball at the proxy", () => {
  const out = JSON.parse(rewriteTarballUrls(JSON.stringify({ versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" } } } }), "http://127.0.0.1:1"));
  assert.equal(out.versions["1.0.0"].dist.tarball, "http://127.0.0.1:1/a/-/a-1.0.0.tgz");
  assert.equal(rewriteTarballUrls("not json", "http://x"), "not json");
});

test("package documents are proxied with rewritten tarball URLs", async () => {
  const res = await fetch(`${proxyUrl}/demo`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { versions: Record<string, { dist: { tarball: string } }> };
  assert.equal(doc.versions["1.0.1"]!.dist.tarball, `${proxyUrl}/demo/-/demo-1.0.1.tgz`);
});

test("a clean tarball is downloaded once and then served from the cache", async () => {
  requests.length = 0;
  const first = await fetch(`${proxyUrl}/demo/-/demo-1.0.1.tgz`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-npm-proxy-cache"), "miss");
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), tarballs["1.0.1"]);
  assert.ok(requests.includes("GET /demo"), "fetched package info on first download");
  assert.ok(requests.includes("POST /-/npm/v1/security/advisories/bulk"), "fetched advisories on first download");

  const cached = path.join(cacheDir, "127.0.0.1:" + new URL(upstreamUrl).port, "demo", "demo-1.0.1.tgz");
  await waitFor(() => fs.existsSync(cached));
  assert.deepEqual(fs.readFileSync(cached), tarballs["1.0.1"]);

  requests.length = 0;
  const second = await fetch(`${proxyUrl}/demo/-/demo-1.0.1.tgz`);
  assert.equal(second.headers.get("x-npm-proxy-cache"), "hit");
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), tarballs["1.0.1"]);
  assert.deepEqual(requests, [], "cache hit does not touch upstream");
});

test("a deprecated version is refused and not cached", async () => {
  const res = await fetch(`${proxyUrl}/demo/-/demo-1.0.0.tgz`);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; reasons: string[]; recommendation: string };
  assert.match(body.error, /deprecated/);
  assert.match(body.reasons[0]!, /please upgrade/);
  assert.match(body.recommendation, /demo@1\.0\.2/);
  assert.equal(fs.existsSync(path.join(cacheDir, "127.0.0.1:" + new URL(upstreamUrl).port, "demo", "demo-1.0.0.tgz")), false);
});

test("an insecure version is refused", async () => {
  const res = await fetch(`${proxyUrl}/demo/-/demo-1.0.2.tgz`);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; reasons: string[] };
  assert.match(body.error, /insecure/);
  assert.match(body.reasons[0]!, /high severity: demo is exploitable/);
});

test("unknown requests are delegated to upstream, including POST bodies", async () => {
  const res = await fetch(`${proxyUrl}/-/ping`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: true, method: "POST" });
  const missing = await fetch(`${proxyUrl}/nope`);
  assert.equal(missing.status, 404);
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
