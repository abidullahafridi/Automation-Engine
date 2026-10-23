import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureManagedTruffleHog,
  managedToolErrorCode,
  parseTruffleHogVersion,
  resolveTruffleHogArtifact
} from "./managed-trufflehog.mjs";

const fixture = async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-trufflehog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const response = (body) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => Buffer.from(body)
});

test("resolves supported release artifacts and parses versions", () => {
  assert.equal(resolveTruffleHogArtifact({ version: "3.97.5", platform: "win32", architecture: "x64" }).assetName,
    "trufflehog_3.97.5_windows_amd64.tar.gz");
  assert.equal(parseTruffleHogVersion("trufflehog 3.97.5"), "3.97.5");
  assert.equal(parseTruffleHogVersion("not-a-version"), undefined);
});

test("bootstraps a checksum-verified managed executable", async (context) => {
  const root = await fixture(context);
  const archive = Buffer.from("fixture archive");
  const checksum = createHash("sha256").update(archive).digest("hex");
  const downloads = [];
  const tool = await ensureManagedTruffleHog({
    workspaceRoot: root,
    requiredVersion: "3.97.5",
    platform: "linux",
    architecture: "x64",
    fetchImpl: async (url) => {
      downloads.push(url);
      return url.endsWith("checksums.txt")
        ? response(`${checksum}  trufflehog_3.97.5_linux_amd64.tar.gz\n`)
        : response(archive);
    },
    extractor: async ({ destination, executableName }) => writeFile(path.join(destination, executableName), "binary"),
    commandRunner: async ({ args }) => {
      assert.deepEqual(args, ["--version"]);
      return { exitCode: 0, stdout: "trufflehog 3.97.5", stderr: "", durationMs: 1 };
    }
  });

  assert.equal(downloads.length, 2);
  assert.equal(tool.version, "3.97.5");
  assert.match(tool.command, /\.repo-cache[\\/]tools[\\/]trufflehog/);
});

test("reports the tar diagnostic when verified artifact extraction fails", async (context) => {
  const root = await fixture(context);
  const archive = Buffer.from("fixture archive");
  const checksum = createHash("sha256").update(archive).digest("hex");

  await assert.rejects(
    ensureManagedTruffleHog({
      workspaceRoot: root,
      requiredVersion: "3.97.5",
      platform: "linux",
      architecture: "x64",
      fetchImpl: async (url) => url.endsWith("checksums.txt")
        ? response(`${checksum}  trufflehog_3.97.5_linux_amd64.tar.gz\n`)
        : response(archive),
      commandRunner: async ({ command, args }) => {
        assert.equal(command, "tar");
        assert.equal(args[0], "-xzf");
        assert.equal(args[2], "--directory");
        return { exitCode: 2, stdout: "", stderr: "access denied", durationMs: 1 };
      }
    }),
    (error) => managedToolErrorCode(error) === "invalid_tool"
      && error instanceof Error
      && error.message.includes("tar exited with code 2): access denied")
  );
});

test("rejects an artifact that fails checksum verification", async (context) => {
  const root = await fixture(context);
  await assert.rejects(
    ensureManagedTruffleHog({
      workspaceRoot: root,
      requiredVersion: "3.97.5",
      platform: "linux",
      architecture: "x64",
      fetchImpl: async (url) => url.endsWith("checksums.txt")
        ? response(`${"0".repeat(64)}  trufflehog_3.97.5_linux_amd64.tar.gz\n`)
        : response("tampered"),
      extractor: async () => undefined,
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })
    }),
    (error) => managedToolErrorCode(error) === "invalid_tool"
  );
});

test("rejects cached executables with incorrect or malformed versions", async (context) => {
  const root = await fixture(context);
  const artifact = resolveTruffleHogArtifact({ version: "3.97.5", platform: "linux", architecture: "x64" });
  const installation = path.join(root, ".repo-cache", "tools", "trufflehog", "3.97.5", artifact.platformKey);
  await mkdir(installation, { recursive: true });
  const binary = Buffer.from("binary");
  await writeFile(path.join(installation, artifact.executableName), binary);
  await writeFile(path.join(installation, "receipt.json"), `${JSON.stringify({
    version: "3.97.5",
    asset: artifact.assetName,
    sha256: "0".repeat(64),
    binarySha256: createHash("sha256").update(binary).digest("hex")
  })}\n`);

  for (const output of ["trufflehog 3.96.0", "malformed"]) {
    await assert.rejects(
      ensureManagedTruffleHog({
        workspaceRoot: root,
        requiredVersion: "3.97.5",
        platform: "linux",
        architecture: "x64",
        commandRunner: async () => ({ exitCode: 0, stdout: output, stderr: "", durationMs: 1 })
      }),
      (error) => managedToolErrorCode(error) === "invalid_tool"
    );
  }
});

test("rejects a modified cached executable", async (context) => {
  const root = await fixture(context);
  const artifact = resolveTruffleHogArtifact({ version: "3.97.5", platform: "linux", architecture: "x64" });
  const installation = path.join(root, ".repo-cache", "tools", "trufflehog", "3.97.5", artifact.platformKey);
  await mkdir(installation, { recursive: true });
  await writeFile(path.join(installation, artifact.executableName), "modified binary");
  await writeFile(path.join(installation, "receipt.json"), `${JSON.stringify({
    version: "3.97.5",
    asset: artifact.assetName,
    sha256: "0".repeat(64),
    binarySha256: "1".repeat(64)
  })}\n`);

  await assert.rejects(
    ensureManagedTruffleHog({
      workspaceRoot: root,
      requiredVersion: "3.97.5",
      platform: "linux",
      architecture: "x64",
      commandRunner: async () => ({ exitCode: 0, stdout: "trufflehog 3.97.5", stderr: "", durationMs: 1 })
    }),
    (error) => managedToolErrorCode(error) === "invalid_tool"
  );
});

test("classifies an unavailable release as a missing managed tool", async (context) => {
  const root = await fixture(context);
  await assert.rejects(
    ensureManagedTruffleHog({
      workspaceRoot: root,
      requiredVersion: "3.97.5",
      platform: "linux",
      architecture: "x64",
      fetchImpl: async () => { throw new Error("offline"); },
      extractor: async () => undefined,
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })
    }),
    (error) => managedToolErrorCode(error) === "tool_missing"
  );
});
