import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runToolCommand } from "./command-runner.mjs";

const releaseRoot = "https://github.com/trufflesecurity/trufflehog/releases/download";

const toolError = (code, message) => new Error(message, { cause: { code } });

export const managedToolErrorCode = (error) => error instanceof Error
  && error.cause && typeof error.cause === "object" && "code" in error.cause
  ? error.cause.code
  : undefined;

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const resolveTruffleHogArtifact = ({ version, platform = process.platform, architecture = process.arch }) => {
  const operatingSystems = { darwin: "darwin", linux: "linux", win32: "windows" };
  const architectures = { arm64: "arm64", x64: "amd64" };
  const operatingSystem = operatingSystems[platform];
  const releaseArchitecture = architectures[architecture];
  if (!operatingSystem || !releaseArchitecture) {
    throw toolError("invalid_tool", `TruffleHog ${version} does not support ${platform}/${architecture} in repository tooling.`);
  }
  return {
    assetName: `trufflehog_${version}_${operatingSystem}_${releaseArchitecture}.tar.gz`,
    checksumsName: `trufflehog_${version}_checksums.txt`,
    executableName: platform === "win32" ? "trufflehog.exe" : "trufflehog",
    platformKey: `${operatingSystem}-${releaseArchitecture}`
  };
};

export const parseTruffleHogVersion = (output) => output.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];

const download = async (url, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, { headers: { "user-agent": "nutshyll-control-plane" } });
  } catch {
    throw toolError("tool_missing", "The managed TruffleHog release could not be downloaded.");
  }
  if (!response.ok) {
    throw toolError("tool_missing", `The managed TruffleHog release returned HTTP ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const expectedChecksum = (manifest, assetName) => {
  const line = manifest.split(/\r?\n/).find((candidate) => candidate.trim().endsWith(`  ${assetName}`)
    || candidate.trim().endsWith(` *${assetName}`));
  const checksum = line?.trim().split(/\s+/)[0];
  if (!checksum || !/^[a-f\d]{64}$/i.test(checksum)) {
    throw toolError("invalid_tool", `The official checksum manifest does not contain ${assetName}.`);
  }
  return checksum.toLowerCase();
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const verifyInstallationReceipt = async ({ receiptPath, binaryPath, requiredVersion, artifact }) => {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    throw toolError("invalid_tool", "The cached TruffleHog installation receipt is invalid.");
  }
  const binaryChecksum = sha256(await readFile(binaryPath));
  if (receipt.version !== requiredVersion
    || receipt.asset !== artifact.assetName
    || !/^[a-f\d]{64}$/i.test(receipt.sha256 ?? "")
    || receipt.binarySha256 !== binaryChecksum) {
    throw toolError("invalid_tool", "The cached TruffleHog executable failed installation integrity verification.");
  }
};

const extractTarball = async ({ archivePath, destination, executableName, commandRunner }) => {
  const execution = await commandRunner({
    command: "tar",
    args: ["-xzf", archivePath, "--directory", destination, executableName],
    cwd: destination
  });
  if (execution.exitCode !== 0) {
    const diagnostic = execution.stderr.trim().slice(0, 1000);
    const details = diagnostic
      ? ` (tar exited with code ${execution.exitCode}): ${diagnostic}`
      : ` (tar exited with code ${execution.exitCode}).`;
    throw toolError("invalid_tool", `The verified TruffleHog artifact could not be extracted${details}`);
  }
};

const bootstrap = async ({
  workspaceRoot,
  requiredVersion,
  artifact,
  installationRoot,
  binaryPath,
  commandRunner,
  fetchImpl,
  extractor
}) => {
  const cacheRoot = path.resolve(workspaceRoot, ".repo-cache", "tools", "trufflehog");
  await mkdir(cacheRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(cacheRoot, `install-${requiredVersion}-`));
  try {
    const versionRoot = `${releaseRoot}/v${requiredVersion}`;
    const [archive, checksums] = await Promise.all([
      download(`${versionRoot}/${artifact.assetName}`, fetchImpl),
      download(`${versionRoot}/${artifact.checksumsName}`, fetchImpl)
    ]);
    const expected = expectedChecksum(checksums.toString("utf8"), artifact.assetName);
    const actual = sha256(archive);
    if (actual !== expected) {
      throw toolError("invalid_tool", "The downloaded TruffleHog artifact failed SHA-256 verification.");
    }

    const archivePath = path.join(stagingRoot, artifact.assetName);
    await writeFile(archivePath, archive);
    await extractor({ archivePath, destination: stagingRoot, executableName: artifact.executableName, commandRunner });
    const extractedBinary = path.join(stagingRoot, artifact.executableName);
    if (!(await exists(extractedBinary))) {
      throw toolError("invalid_tool", "The verified TruffleHog artifact did not contain its executable.");
    }

    await mkdir(installationRoot, { recursive: true });
    await copyFile(extractedBinary, binaryPath);
    if (process.platform !== "win32") await chmod(binaryPath, 0o755);
    const binarySha256 = sha256(await readFile(binaryPath));
    await writeFile(path.join(installationRoot, "receipt.json"), `${JSON.stringify({
      version: requiredVersion,
      asset: artifact.assetName,
      sha256: expected,
      binarySha256
    }, null, 2)}\n`, "utf8");
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

export const ensureManagedTruffleHog = async ({
  workspaceRoot,
  requiredVersion,
  commandRunner = runToolCommand,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  architecture = process.arch,
  extractor = extractTarball
}) => {
  const artifact = resolveTruffleHogArtifact({ version: requiredVersion, platform, architecture });
  const installationRoot = path.resolve(
    workspaceRoot,
    ".repo-cache",
    "tools",
    "trufflehog",
    requiredVersion,
    artifact.platformKey
  );
  const binaryPath = path.join(installationRoot, artifact.executableName);
  const receiptPath = path.join(installationRoot, "receipt.json");

  if (!(await exists(binaryPath))) {
    await bootstrap({
      workspaceRoot,
      requiredVersion,
      artifact,
      installationRoot,
      binaryPath,
      commandRunner,
      fetchImpl,
      extractor
    });
  } else if (!(await exists(receiptPath))) {
    throw toolError("invalid_tool", "The cached TruffleHog executable has no verified installation receipt.");
  }
  await verifyInstallationReceipt({ receiptPath, binaryPath, requiredVersion, artifact });

  let versionExecution;
  try {
    versionExecution = await commandRunner({ command: binaryPath, args: ["--version"], cwd: workspaceRoot });
  } catch {
    throw toolError("tool_missing", "The managed TruffleHog executable could not start.");
  }
  const actualVersion = parseTruffleHogVersion(`${versionExecution.stdout}\n${versionExecution.stderr}`);
  if (versionExecution.exitCode !== 0 || !actualVersion || actualVersion !== requiredVersion) {
    throw toolError("invalid_tool", `The managed TruffleHog executable does not satisfy required version ${requiredVersion}.`);
  }

  return { command: binaryPath, version: actualVersion };
};
