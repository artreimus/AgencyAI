import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [resolve(repoRoot, "scripts/check-source-closure.mjs")]);
run(pnpmCommand, ["--filter", "@openwork/product-config", "build"]);
run(pnpmCommand, ["--filter", "@openwork/desktop", "build"]);
