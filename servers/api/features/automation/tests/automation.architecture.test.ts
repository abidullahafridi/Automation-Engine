import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const featureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Approved scoped-gateway files. Adding a file here is a deliberate, reviewed decision.
 * Adjust the pattern if your inbox/outbox files use different names.
 */
const gatewayFile = /^(automation\.mongo-repository|run\.repository|run\.history\.repository|run\.recovery\.idempotency|inbox\.repository|outbox\.[a-z-]+|trigger\.matcher|quota\.repository|audit\.repository|schedule\.repository)\.ts$/;
const scopeEnforcingFiles = [
  "automation.mongo-repository.ts",
  "run.repository.ts",
  "run.history.repository.ts",
  "run.recovery.idempotency.ts",
  "trigger.matcher.ts",
  "quota.repository.ts",
  "audit.repository.ts",
  "schedule.repository.ts"
] as const;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export const touchesDatabaseDirectly = (source: string): boolean =>
  /\.collection\s*[<(]/.test(source) ||
  /from\s+["'](?:mongodb|mongoose)["']/.test(source) ||
  /from\s+["'][./]*integrations\//.test(source);

const sources = (): readonly Readonly<{ name: string; text: string }>[] =>
  readdirSync(featureDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => Object.freeze({
      name: entry.name,
      text: stripComments(readFileSync(path.join(featureDirectory, entry.name), "utf8"))
    }));

void test("TC-0405 detector is not vacuous", () => {
  assert.equal(touchesDatabaseDirectly('database.collection("runs").find({})'), true);
  assert.equal(touchesDatabaseDirectly('database.collection<Run>("runs")'), true);
  assert.equal(touchesDatabaseDirectly('import { MongoClient } from "mongodb";'), true);
  assert.equal(touchesDatabaseDirectly("const x = repository.findById(scope, id);"), false);
});

void test("TC-0405 direct collection access outside the approved gateway is blocked", () => {
  const violations = sources()
    .filter((file) => touchesDatabaseDirectly(file.text) && !gatewayFile.test(file.name))
    .map((file) => file.name);
  assert.deepEqual(violations, []);
});

void test("TC-0405 scoped gateways enforce resolver-minted scope", () => {
  const all = sources();
  for (const name of scopeEnforcingFiles) {
    const file = all.find((item) => item.name === name);
    assert.ok(file, `${name} must exist`);
    assert.match(file.text, /ownsScope\(/, `${name} must call ownsScope before database access`);
  }
});