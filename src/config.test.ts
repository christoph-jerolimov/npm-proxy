import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npm-proxy-config-"));
}

test("defaults apply when no file exists", () => {
  const { config, file } = loadConfig({ cwd: tmpdir() });
  assert.equal(file, undefined);
  assert.equal(config.upstream, "https://registry.npmjs.org");
  assert.equal(config.port, 4873);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.cacheDir, path.join(os.homedir(), ".npm-proxy", "cache"));
  assert.deepEqual(config.deny, { deprecated: true, insecure: true, minSeverity: "low" });
});

test("reads npm-proxy.yaml from the current folder and expands ~", () => {
  const cwd = tmpdir();
  fs.writeFileSync(
    path.join(cwd, "npm-proxy.yaml"),
    ["upstream: https://registry.example.test/npm/", "port: 9000", "cacheDir: ~/cache-test", "deny:", "  minSeverity: high"].join("\n"),
  );
  const { config, file } = loadConfig({ cwd });
  assert.equal(file, path.join(cwd, "npm-proxy.yaml"));
  assert.equal(config.upstream, "https://registry.example.test/npm/");
  assert.equal(config.port, 9000);
  assert.equal(config.cacheDir, path.join(os.homedir(), "cache-test"));
  assert.deepEqual(config.deny, { deprecated: true, insecure: true, minSeverity: "high" });
});

test("overrides win over the file and undefined overrides are ignored", () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, "npm-proxy.yaml"), "port: 9000\n");
  const { config } = loadConfig({ cwd, overrides: { port: 1234, upstream: undefined } });
  assert.equal(config.port, 1234);
  assert.equal(config.upstream, "https://registry.npmjs.org");
});

test("rejects invalid values with a readable error", () => {
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, "npm-proxy.yaml"), "upstream: not-a-url\nport: 70000\n");
  assert.throws(() => loadConfig({ cwd }), (error: unknown) => error instanceof ConfigError && /upstream/.test(error.message) && /port/.test(error.message));
});

test("rejects a missing explicit file", () => {
  assert.throws(() => loadConfig({ cwd: tmpdir(), file: "nope.yaml" }), ConfigError);
});
