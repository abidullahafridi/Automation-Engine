import { spawn } from "node:child_process";

const windowsCommands = new Set(["pnpm"]);

export const runToolCommand = ({ command, args, cwd, env = process.env }) => new Promise((resolve, reject) => {
  const started = Date.now();
  const requiresWindowsShell = process.platform === "win32" && windowsCommands.has(command);
  const child = spawn(command, args, {
    cwd,
    env,
    shell: requiresWindowsShell,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (exitCode, signal) => resolve({
    exitCode: exitCode ?? 1,
    signal,
    stdout,
    stderr,
    durationMs: Date.now() - started
  }));
});
