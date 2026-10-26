import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./policy.js";
import type { Advisory, Packument } from "./registry.js";

const packument: Packument = {
  name: "demo",
  "dist-tags": { latest: "1.0.2" },
  versions: {
    "1.0.0": { version: "1.0.0", deprecated: "use 1.0.2 instead", dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz" } },
    "1.0.1": { version: "1.0.1", dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.0.1.tgz" } },
    "1.0.2": { version: "1.0.2", dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.0.2.tgz" } },
  },
};

const high: Advisory = { id: 1, url: "https://github.com/advisories/GHSA-x", title: "bad thing", severity: "high", vulnerable_versions: "<1.0.2" };
const low: Advisory = { ...high, id: 2, title: "minor thing", severity: "low" };
const deny = { deprecated: true, insecure: true, minSeverity: "low" as const };

test("allows a clean version", () => {
  assert.deepEqual(evaluate("demo", "1.0.1", packument, [], deny), { allow: true });
});

test("denies a deprecated version and recommends latest", () => {
  const verdict = evaluate("demo", "1.0.0", packument, [], deny);
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.deepEqual(verdict.codes, ["deprecated"]);
  assert.match(verdict.reasons[0]!, /use 1\.0\.2 instead/);
  assert.match(verdict.recommendation, /demo@1\.0\.2/);
});

test("denies an insecure version at or above minSeverity", () => {
  const verdict = evaluate("demo", "1.0.1", packument, [high, low], deny);
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.deepEqual(verdict.codes, ["insecure"]);
  assert.equal(verdict.reasons.length, 2);
  assert.match(verdict.reasons[0]!, /^high severity/);
});

test("ignores advisories below minSeverity", () => {
  assert.deepEqual(evaluate("demo", "1.0.1", packument, [low], { ...deny, minSeverity: "high" }), { allow: true });
});

test("respects disabled checks", () => {
  assert.deepEqual(evaluate("demo", "1.0.0", packument, [high], { deprecated: false, insecure: false, minSeverity: "low" }), { allow: true });
});

test("reports both reasons and explains when latest is insecure too", () => {
  const verdict = evaluate("demo", "1.0.2", packument, [high], deny);
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.match(verdict.recommendation, /latest release and still affected/);
});
