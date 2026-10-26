import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { Severity } from "./config.js";

export interface PackumentVersion {
  name?: string;
  version: string;
  deprecated?: string;
  dist: {
    tarball: string;
    integrity?: string;
    shasum?: string;
  };
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
  time?: Record<string, string>;
}

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: Severity | string;
  vulnerable_versions: string;
  cwe?: string[];
  cvss?: { score: number; vectorString: string | null };
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Thin client for the upstream registry. */
export class Upstream {
  readonly base: string;

  constructor(readonly url: URL) {
    this.base = url.href.replace(/\/+$/, "");
  }

  /** Absolute upstream URL for a registry path such as `/lodash/-/lodash-4.17.23.tgz`. */
  resolve(pathWithQuery: string): string {
    return `${this.base}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
  }

  /** Fetches the full package document, including per-version deprecation notices. */
  async fetchPackument(name: string): Promise<Packument> {
    const res = await fetch(this.resolve(`/${encodePackageName(name)}`), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new UpstreamError(`upstream returned ${res.status} for package info of ${name}`, res.status);
    return (await res.json()) as Packument;
  }

  /** Fetches the security advisories that affect exactly `name@version`. */
  async fetchAdvisories(name: string, version: string): Promise<Advisory[]> {
    const res = await fetch(this.resolve("/-/npm/v1/security/advisories/bulk"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ [name]: [version] }),
    });
    if (!res.ok) throw new UpstreamError(`upstream returned ${res.status} for advisories of ${name}`, res.status);
    const data = (await res.json()) as Record<string, Advisory[] | undefined>;
    return data[name] ?? [];
  }

  async fetchTarball(pathname: string): Promise<Response> {
    return fetch(this.resolve(pathname), { headers: { accept: "application/octet-stream" } });
  }

  /** Forwards an arbitrary client request unchanged, apart from hop-by-hop headers. */
  async forward(req: IncomingMessage): Promise<Response> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key)) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    return fetch(this.resolve(req.url ?? "/"), {
      method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      redirect: "manual",
      // Required by fetch when streaming a request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  }
}

/** Headers that must not be forwarded between client, proxy and upstream. */
export const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // fetch negotiates and transparently decodes its own compression.
  "accept-encoding",
  "content-encoding",
  "content-length",
]);

export function encodePackageName(name: string): string {
  return name.replace("/", "%2F");
}
