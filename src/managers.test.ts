import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildInstallCommand, detectManager } from "./managers.js";

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-proxy-managers-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test("detects managers from lock files", () => {
  assert.equal(detectManager(project({ "package-lock.json": "{}" })).manager, "npm");
  assert.equal(detectManager(project({ "yarn.lock": "" })).manager, "yarn");
  assert.equal(detectManager(project({ "pnpm-lock.yaml": "" })).manager, "pnpm");
  assert.equal(detectManager(project({ "bun.lock": "" })).manager, "bun");
  assert.equal(detectManager(project({ "bun.lockb": "" })).manager, "bun");
  assert.equal(detectManager(project({ "deno.lock": "{}" })).manager, "deno");
});

test("falls back to the packageManager field, then npm", () => {
  assert.equal(detectManager(project({ "package.json": '{"packageManager":"pnpm@10.0.0"}' })).manager, "pnpm");
  assert.equal(detectManager(project({})).manager, "npm");
});

test("builds commands with the registry as argument or environment", () => {
  const registry = "http://127.0.0.1:54321";
  assert.deepEqual(buildInstallCommand("npm", registry, ["--no-audit"]).args, ["install", `--registry=${registry}`, "--no-audit"]);
  assert.deepEqual(buildInstallCommand("pnpm", registry).args, ["install", `--registry=${registry}`]);
  assert.deepEqual(buildInstallCommand("bun", registry).args, ["install", `--registry=${registry}`]);
  const yarn = buildInstallCommand("yarn", registry);
  assert.deepEqual(yarn.args, ["install"]);
  assert.equal(yarn.env.YARN_NPM_REGISTRY_SERVER, registry);
  assert.equal(yarn.env.YARN_UNSAFE_HTTP_WHITELIST, "127.0.0.1");
  const deno = buildInstallCommand("deno", registry);
  assert.deepEqual(deno.args, ["install"]);
  assert.equal(deno.env.NPM_CONFIG_REGISTRY, registry);
});
