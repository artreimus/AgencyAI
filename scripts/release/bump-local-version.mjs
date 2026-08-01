import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const packageFiles = Object.freeze([
  "apps/app/package.json",
  "apps/desktop/package.json",
  "apps/orchestrator/package.json",
  "apps/server/package.json",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateLocalVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/, "");
  invariant(
    /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "AgencyAI local version must be a prerelease-safe 0.x semantic version",
  );
  return version;
}

export function bumpLocalVersion(version) {
  const nextVersion = validateLocalVersion(version);
  for (const relativePath of packageFiles) {
    const filePath = resolve(repoRoot, relativePath);
    const manifest = JSON.parse(readFileSync(filePath, "utf8"));
    manifest.version = nextVersion;
    if (relativePath === "apps/orchestrator/package.json") {
      invariant(
        manifest.dependencies?.["openwork-server"] === "workspace:*",
        "Orchestrator must resolve openwork-server only from this workspace",
      );
    }
    writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  let result = spawnSync(
    pnpm,
    ["install", "--lockfile-only", "--offline"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0 && !result.error) {
    result = spawnSync(
      pnpm,
      ["install", "--lockfile-only"],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }
  if (result.error) throw result.error;
  invariant(result.status === 0, "pnpm failed to refresh the lockfile");
  return { version: nextVersion, files: packageFiles };
}

if (process.argv[1] === scriptPath) {
  try {
    process.stdout.write(
      `${JSON.stringify(bumpLocalVersion(process.argv[2]), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
