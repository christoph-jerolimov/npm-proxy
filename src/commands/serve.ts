import type { Config } from "../config.js";
import { consoleLogger } from "../log.js";
import { createProxyServer } from "../server.js";

export async function runServe(config: Config, configFile?: string): Promise<void> {
  const server = createProxyServer(config);
  const address = await server.start();

  consoleLogger.info(`npm-proxy listening on ${address.url}`);
  consoleLogger.info(`upstream registry: ${config.upstream}`);
  consoleLogger.info(`cache directory:   ${config.cacheDir}`);
  consoleLogger.info(`configuration:     ${configFile ?? "defaults (no npm-proxy.yaml found)"}`);
  consoleLogger.info(`deny deprecated=${config.deny.deprecated} insecure=${config.deny.insecure} (minSeverity ${config.deny.minSeverity}); press Ctrl+C to stop`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      consoleLogger.info(`received ${signal}, shutting down`);
      server.stop().then(resolve, (error: Error) => {
        consoleLogger.error(`error while stopping: ${error.message}`);
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
