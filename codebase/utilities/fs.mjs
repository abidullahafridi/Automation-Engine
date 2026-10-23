import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const pathExists = async (targetPath) => {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

export const readJsonFile = async (filePath) => {
  const text = await readFile(filePath, "utf8");

  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
};

export const listDirectories = async (directoryPath) => {
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
};

export const walkFiles = async (root, { ignoredDirectories = new Set() } = {}) => {
  if (!(await pathExists(root))) {
    return [];
  }

  const rootStatus = await stat(root);
  if (rootStatus.isFile()) {
    return [root];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name)
          ? []
          : walkFiles(entryPath, { ignoredDirectories });
      }

      return entry.isFile() ? [entryPath] : [];
    })
  );

  return children.flat().sort((left, right) => left.localeCompare(right));
};

export const writeJsonFile = async (filePath, value) => {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
};

export const toPosixPath = (value) => value.split(path.sep).join("/");

export const toWorkspaceRelativePath = (workspaceRoot, targetPath) =>
  toPosixPath(path.relative(workspaceRoot, targetPath));
