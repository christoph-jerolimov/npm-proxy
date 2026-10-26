import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { consoleLogger } from "../log.js";
import { buildInstallCommand, detectManager, type Manager } from "../managers.js";
import { createProxyServer } from "../server.js";

export interface InstallOptions {
  cwd?: string;
  /** Overrides lock file detection. */
  manager?: Manager;
  /** Extra arguments appended to the package manager's install command. */
  args?: string[];
}

/**
 * Starts the proxy on a random port, runs the project's package manager
 * against it with inherited stdio, and stops the proxy when it exits.
 * Resolves with the package manager's exit code.
 */
export async function runInstall(config: Config, options: InstallOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const detection = options.manager
    ? { manager: options.manager, reason: "selected with --manager" }
    : detectManager(cwd);

  const server = createProxyServer(config);
  const address = await server.start(0);
  const command = buildInstallCommand(detection.manager, address.url, options.args);

  consoleLogger.info(`proxy listening on ${address.url} (upstream ${config.upstream})`);
  consoleLogger.info(`running ${[command.command, ...command.args].join(" ")} (${detection.reason})`);

  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd,
        stdio: "inherit",
        env: { ...process.env, ...command.env },
        shell: process.platform === "win32",
      });

      const relay = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      process.on("SIGINT", relay);
      process.on("SIGTERM", relay);
      const cleanup = () => {
        process.off("SIGINT", relay);
        process.off("SIGTERM", relay);
      };

      child.once("error", (error) => {
        cleanup();
        reject(new Error(`could not start ${command.command}: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        cleanup();
        if (signal) consoleLogger.warn(`${command.command} was terminated by ${signal}`);
        resolve(code ?? 1);
      });
    });
  } finally {
    await server.stop();
    consoleLogger.info("proxy stopped");
  }
}
