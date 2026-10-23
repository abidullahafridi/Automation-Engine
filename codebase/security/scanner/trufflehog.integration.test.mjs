import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureManagedTruffleHog } from "../../tools/managed-trufflehog.mjs";
import { runTruffleHogScan } from "./trufflehog.mjs";

test("managed TruffleHog detects and safely normalizes a generated credential fixture", { timeout: 120_000 }, async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "trufflehog-integration-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  await writeFile(path.join(fixtureRoot, "generated-private-key.pem"), privateKey, { mode: 0o600 });
  await writeFile(path.join(fixtureRoot, ".trufflehog-exclude-paths.txt"), "a^\n", "utf8");

  const tool = await ensureManagedTruffleHog({ workspaceRoot: process.cwd(), requiredVersion: "3.97.5" });
  const scan = await runTruffleHogScan({
    workspaceRoot: fixtureRoot,
    policy: {
      version: "3.97.5",
      configuration: ".trufflehog-exclude-paths.txt",
      resultClasses: ["verified", "unknown", "unverified"]
    },
    toolProvider: async () => tool
  });

  assert.equal(scan.result.scanStatus, "findings");
  assert.equal(scan.result.exitCode, 183);
  assert.ok(scan.result.findingCount > 0);
  assert.equal(JSON.stringify(scan).includes(privateKey.slice(32, 72)), false);
});
