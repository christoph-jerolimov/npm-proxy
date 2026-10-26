import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * On-disk cache below `<root>/<upstream host>/`.
 *
 *   <package>/<name>-<version>.tgz   successfully downloaded tarballs
 *   <package>/packument.json          full package document from upstream
 *   <package>/advisories.json         security advisories, keyed by version
 *
 * Scoped packages nest naturally: `@scope/name` becomes `@scope/name/`.
 */
export class Cache {
  readonly base: string;

  constructor(root: string, upstream: URL) {
    this.base = path.join(root, upstream.host);
  }

  packageDir(name: string): string {
    return path.join(this.base, ...name.split("/"));
  }

  tarballPath(name: string, version: string): string {
    return path.join(this.packageDir(name), `${basename(name)}-${version}.tgz`);
  }

  packumentPath(name: string): string {
    return path.join(this.packageDir(name), "packument.json");
  }

  advisoriesPath(name: string): string {
    return path.join(this.packageDir(name), "advisories.json");
  }

  async readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // A corrupt file is treated like a missing one; it will be rewritten.
      return undefined;
    }
  }

  async writeJson(file: string, data: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
  }

  async stat(file: string): Promise<fs.Stats | undefined> {
    try {
      return await fsp.stat(file);
    } catch {
      return undefined;
    }
  }

  /**
   * Prepares a temporary file for a tarball download. Call `commit()` once the
   * download finished successfully to move it into place, or `abort()` to drop it.
   */
  async createTarballWriter(name: string, version: string): Promise<TarballWriter> {
    const finalPath = this.tarballPath(name, version);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
    const stream = fs.createWriteStream(tmpPath);
    return {
      stream,
      tmpPath,
      finalPath,
      async commit() {
        await fsp.rename(tmpPath, finalPath);
      },
      async abort() {
        await fsp.rm(tmpPath, { force: true });
      },
    };
  }
}

export interface TarballWriter {
  stream: fs.WriteStream;
  tmpPath: string;
  finalPath: string;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export function basename(name: string): string {
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}
