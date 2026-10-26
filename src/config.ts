import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const configSchema = z.object({
  /** Registry every unknown request is delegated to. */
  upstream: z.url().default("https://registry.npmjs.org"),
  /** Interface the proxy listens on. */
  host: z.string().min(1).default("127.0.0.1"),
  /** Port for `serve`. `install` always picks a random free port. */
  port: z.int().min(0).max(65535).default(4873),
  /** Root of the tarball cache. Layout: <cacheDir>/<upstream host>/<package>/<name>-<version>.tgz */
  cacheDir: z.string().min(1).default(path.join(os.homedir(), ".npm-proxy", "cache")),
  deny: z
    .object({
      /** Refuse versions that carry a deprecation notice. */
      deprecated: z.boolean().default(true),
      /** Refuse versions with a known security advisory. */
      insecure: z.boolean().default(true),
      /** Lowest advisory severity that counts as insecure. */
      minSeverity: z.enum(SEVERITIES).default("low"),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export const CONFIG_FILE_NAMES = ["npm-proxy.yaml", "npm-proxy.yml", ".npm-proxy.yaml", ".npm-proxy.yml"];

export class ConfigError extends Error {}

/** Returns the first configuration file that exists in `cwd`, if any. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit file; an error is raised when it does not exist. */
  file?: string;
  /** Values that win over the file, typically CLI flags. `undefined` entries are ignored. */
  overrides?: Partial<ConfigInput>;
}

export interface LoadedConfig {
  config: Config;
  /** The file the configuration was read from, or undefined when only defaults apply. */
  file?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const file = options.file ? path.resolve(cwd, options.file) : findConfigFile(cwd);

  let raw: unknown = {};
  if (file) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new ConfigError(`cannot read configuration file ${file}: ${(error as Error).message}`);
    }
    try {
      raw = parseYaml(text) ?? {};
    } catch (error) {
      throw new ConfigError(`invalid YAML in ${file}: ${(error as Error).message}`);
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`${file} must contain a YAML mapping at the top level`);
    }
  }

  const merged = { ...(raw as Record<string, unknown>), ...definedEntries(options.overrides ?? {}) };
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const where = file ? ` in ${file}` : "";
    throw new ConfigError(`invalid configuration${where}:\n${z.prettifyError(result.error)}`);
  }

  const config = { ...result.data, cacheDir: expandHome(result.data.cacheDir) };
  return file ? { config, file } : { config };
}

function definedEntries<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
