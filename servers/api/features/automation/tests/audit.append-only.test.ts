import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const featureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = (name: string): string =>
  stripComments(readFileSync(path.join(featureDirectory, name), "utf8"));

const mutatingOperations =
  /\b(updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|bulkWrite|drop|dropIndex|dropIndexes|rename)\b/;
const mutatingOperators = /\$(set|unset|inc|push|pull|rename|setOnInsert)\b/;

void test("TC-0427 audit repository is insert-only and has no expiry", () => {
  const source = read("audit.repository.ts");
  assert.match(source, /insertOne\(/);
  assert.match(source, /ownsScope\(/);
  assert.equal(mutatingOperations.test(source), false);
  assert.equal(mutatingOperators.test(source), false);
  assert.equal(source.includes("expireAfterSeconds"), false);
});

void test("TC-0427 only the audit repository touches the audit collection or the driver", () => {
  const offenders = readdirSync(featureDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "audit.repository.ts")
    .filter((entry) => {
      const source = read(entry.name);
      return source.includes("automation_audit");
    })
    .map((entry) => entry.name);
  assert.deepEqual(offenders, []);

  for (const name of ["audit.log.ts", "audit.record.ts", "audit.recorder.ts", "audit.adapters.ts"]) {
    const source = read(name);
    assert.equal(/from\s+["'](?:mongodb|mongoose)["']/.test(source), false, `${name} must not import the driver`);
    assert.equal(/from\s+["'][./]*integrations\//.test(source), false, `${name} must not import integrations`);
  }
});