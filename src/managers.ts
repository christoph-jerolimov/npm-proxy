import fs from "node:fs";
import path from "node:path";

export const MANAGERS = ["npm", "yarn", "pnpm", "bun", "deno"] as const;
export type Manager = (typeof MANAGERS)[number];

/** Lock files in detection order; the first match wins. */
const LOCK_FILES: Array<[string, Manager]> = [
  ["deno.lock", "deno"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

export interface Detection {
  manager: Manager;
  reason: string;
}

export function detectManager(cwd: string): Detection {
  for (const [file, manager] of LOCK_FILES) {
    if (fs.existsSync(path.join(cwd, file))) return { manager, reason: `found ${file}` };
  }
  const fromField = packageManagerField(cwd);
  if (fromField) return { manager: fromField, reason: "packageManager field in package.json" };
  return { manager: "npm", reason: "no lock file found, defaulting to npm" };
}

function packageManagerField(cwd: string): Manager | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { packageManager?: string };
    const name = pkg.packageManager?.split("@")[0];
    return MANAGERS.includes(name as Manager) ? (name as Manager) : undefined;
  } catch {
    return undefined;
  }
}

export interface InstallCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Builds the install invocation for a manager, pointing it at `registry`
 * through a command line argument where the manager has one and through
 * environment variables otherwise.
 */
export function buildInstallCommand(manager: Manager, registry: string, extraArgs: string[] = []): InstallCommand {
  const host = new URL(registry).hostname;
  const env: Record<string, string> = {
    // npm, pnpm and Yarn Classic read this npm-style setting.
    npm_config_registry: registry,
    // Deno and Bun read the upper-case spelling.
    NPM_CONFIG_REGISTRY: registry,
    // Yarn Classic.
    YARN_REGISTRY: registry,
    // Yarn Berry, which also refuses plain http unless the host is whitelisted.
    YARN_NPM_REGISTRY_SERVER: registry,
    YARN_UNSAFE_HTTP_WHITELIST: host,
  };

  switch (manager) {
    case "npm":
      return { command: "npm", args: ["install", `--registry=${registry}`, ...extraArgs], env };
    case "pnpm":
      return { command: "pnpm", args: ["install", `--registry=${registry}`, ...extraArgs], env };
    case "bun":
      return { command: "bun", args: ["install", `--registry=${registry}`, ...extraArgs], env };
    case "yarn":
      return { command: "yarn", args: ["install", ...extraArgs], env };
    case "deno":
      return { command: "deno", args: ["install", ...extraArgs], env };
  }
}
