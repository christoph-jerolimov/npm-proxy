#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { runInstall } from "./commands/install.js";
import { runServe } from "./commands/serve.js";
import { ConfigError, loadConfig, type ConfigInput } from "./config.js";
import { consoleLogger } from "./log.js";
import { MANAGERS, type Manager } from "./managers.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

interface GlobalOptions {
  config?: string;
  upstream?: string;
  cacheDir?: string;
}

const program = new Command()
  .name("npm-proxy")
  .description("Caching npm registry proxy that refuses deprecated and insecure packages.")
  .version(version)
  .option("-c, --config <file>", "configuration file (default: npm-proxy.yaml in the current folder)")
  .option("--upstream <url>", "upstream registry, overrides the configuration file")
  .option("--cache-dir <dir>", "cache directory, overrides the configuration file")
  .enablePositionalOptions();

function load(extra: Partial<ConfigInput> = {}) {
  const globals = program.opts<GlobalOptions>();
  return loadConfig({
    file: globals.config,
    overrides: { upstream: globals.upstream, cacheDir: globals.cacheDir, ...extra },
  });
}

program
  .command("serve")
  .description("start the proxy and keep it running until Ctrl+C")
  .option("-p, --port <port>", "port to listen on", parsePort)
  .option("-H, --host <host>", "interface to listen on")
  .action(async (opts: { port?: number; host?: string }) => {
    const { config, file } = load({ port: opts.port, host: opts.host });
    await runServe(config, file);
  });

program
  .command("install")
  .description("start the proxy on a random port, run the project's package manager against it, then stop it")
  .argument("[args...]", "extra arguments passed to the package manager")
  .option("-m, --manager <name>", `package manager to run (${MANAGERS.join(", ")}); default: detected from lock files`, parseManager)
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (args: string[], opts: { manager?: Manager }) => {
    const { config } = load();
    process.exitCode = await runInstall(config, { manager: opts.manager, args });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof ConfigError) {
    consoleLogger.error(error.message);
    process.exitCode = 2;
    return;
  }
  consoleLogger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  return port;
}

function parseManager(value: string): Manager {
  if (!MANAGERS.includes(value as Manager)) throw new InvalidArgumentError(`expected one of ${MANAGERS.join(", ")}`);
  return value as Manager;
}
