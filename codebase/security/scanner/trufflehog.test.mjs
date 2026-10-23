import test from "node:test";
import assert from "node:assert/strict";
import { runTruffleHogScan } from "./trufflehog.mjs";

const policy = Object.freeze({
  version: "3.97.5",
  configuration: ".trufflehog-exclude-paths.txt",
  resultClasses: ["verified", "unknown", "unverified"]
});
const toolProvider = async () => ({ command: "managed-trufflehog", version: "3.97.5" });

const finding = ({ verified = false, verificationError = "", raw = "synthetic-sensitive-value", file = "fixture.txt" } = {}) => JSON.stringify({
  DetectorName: "FixtureDetector",
  Verified: verified,
  VerificationError: verificationError,
  Raw: raw,
  RawV2: raw,
  SourceMetadata: { Data: { Filesystem: { file, line: 2 } } }
});

test("executes the managed filesystem scan with the repository policy", async () => {
  const scan = await runTruffleHogScan({
    workspaceRoot: process.cwd(),
    policy,
    toolProvider,
    commandRunner: async ({ command, args }) => {
      assert.equal(command, "managed-trufflehog");
      assert.deepEqual(args.slice(0, 2), ["filesystem", "."]);
      assert.ok(args.includes("--fail"));
      assert.ok(args.includes("--results=verified,unknown,unverified"));
      assert.ok(args.includes(".trufflehog-exclude-paths.txt"));
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 6 };
    }
  });
  assert.equal(scan.result.scanStatus, "clean");
  assert.equal(scan.result.version, "3.97.5");
  assert.deepEqual(scan.issues, []);
});

test("normalizes multiple findings and removes raw credentials", async () => {
  const rawSecret = "synthetic-sensitive-value";
  const scan = await runTruffleHogScan({
    workspaceRoot: process.cwd(),
    policy,
    toolProvider,
    commandRunner: async () => ({
      exitCode: 183,
      stdout: `${finding({ verified: true, raw: rawSecret })}\n${finding({ verificationError: "offline", raw: rawSecret, file: "other.txt" })}\n`,
      stderr: rawSecret,
      durationMs: 7
    })
  });

  assert.equal(scan.result.scanStatus, "findings");
  assert.equal(scan.result.findingCount, 2);
  assert.deepEqual(scan.issues.map(({ verificationStatus }) => verificationStatus), ["verified", "unknown"]);
  assert.equal(JSON.stringify(scan).includes(rawSecret), false);
});

test("maps scanner errors and finding exit codes without leaking stderr", async () => {
  const rawSecret = "do-not-expose-this-value";
  const scannerError = await runTruffleHogScan({
    workspaceRoot: process.cwd(),
    policy,
    toolProvider,
    commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: rawSecret, durationMs: 3 })
  });
  assert.equal(scannerError.result.scanStatus, "scanner_error");
  assert.equal(JSON.stringify(scannerError).includes(rawSecret), false);

  const noRecords = await runTruffleHogScan({
    workspaceRoot: process.cwd(),
    policy,
    toolProvider,
    commandRunner: async () => ({ exitCode: 183, stdout: "", stderr: "", durationMs: 3 })
  });
  assert.equal(noRecords.result.scanStatus, "invalid_output");
});

test("fails closed on malformed JSON output", async () => {
  const scan = await runTruffleHogScan({
    workspaceRoot: process.cwd(),
    policy,
    toolProvider,
    commandRunner: async () => ({ exitCode: 183, stdout: "{not-json", stderr: "", durationMs: 2 })
  });
  assert.equal(scan.result.scanStatus, "invalid_output");
  assert.equal(scan.issues[0].rule, "security-output-invalid");
  assert.equal(JSON.stringify(scan).includes("{not-json"), false);
});

test("distinguishes unavailable and invalid managed tools", async () => {
  for (const [code, expected] of [["tool_missing", "tool_missing"], ["invalid_tool", "invalid_tool"]]) {
    const scan = await runTruffleHogScan({
      workspaceRoot: process.cwd(),
      policy,
      toolProvider: async () => { throw new Error("safe diagnostic", { cause: { code } }); }
    });
    assert.equal(scan.result.scanStatus, expected);
  }
});

test("fails closed on invalid repository scanner policy", async () => {
  const scan = await runTruffleHogScan({ workspaceRoot: process.cwd(), policy: {} });
  assert.equal(scan.result.scanStatus, "invalid_tool");
  assert.equal(scan.issues[0].rule, "security-tool-invalid");
});
