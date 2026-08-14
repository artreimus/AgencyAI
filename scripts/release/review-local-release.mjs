import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");
const versionedPackages = Object.freeze([
  "apps/app/package.json",
  "apps/desktop/package.json",
  "apps/orchestrator/package.json",
  "apps/server/package.json",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  invariant(
    result.status === 0,
    `${command} ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
  );
  return String(result.stdout).trim();
}

export function reviewLocalRelease({ requireClean = true } = {}) {
  const versions = Object.fromEntries(
    versionedPackages.map((file) => [
      file,
      JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")).version,
    ]),
  );
  invariant(
    new Set(Object.values(versions)).size === 1,
    `AgencyAI package versions disagree: ${JSON.stringify(versions)}`,
  );
  const version = Object.values(versions)[0];
  invariant(
    /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "Invalid AgencyAI version",
  );
  const orchestrator = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/orchestrator/package.json"), "utf8"),
  );
  invariant(
    orchestrator.dependencies?.["openwork-server"] === "workspace:*",
    "Orchestrator must resolve openwork-server only from this workspace",
  );
  const lockfile = readFileSync(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
  const orchestratorLock = lockfile.match(
    /\n  apps\/orchestrator:\n([\s\S]*?)(?=\n  \S)/,
  )?.[1] ?? "";
  invariant(
    /openwork-server:\n\s+specifier: workspace:\*\n\s+version: link:\.\.\/server/.test(
      orchestratorLock,
    ),
    "Lockfile must link the orchestrator to the local AgencyAI server",
  );
  if (requireClean) {
    invariant(
      run("git", ["status", "--short", "--untracked-files=all"]) === "",
      "Release review requires a clean worktree",
    );
  }
  const profile = JSON.parse(
    readFileSync(
      resolve(repoRoot, "packages/product-config/profiles/local-mvp.json"),
      "utf8",
    ),
  );
  invariant(profile.profile === "local-mvp", "Release profile is not local-mvp");
  invariant(
    profile.features.automaticUpdates === false,
    "Automatic updates must remain disabled",
  );
  invariant(profile.brand.protocol === null, "Public protocol must remain disabled");
  const distribution = JSON.parse(
    readFileSync(resolve(repoRoot, "opencode-distribution.json"), "utf8"),
  );
  invariant(
    distribution.sourceRepository
      === "https://github.com/artreimus/AgencyAI-OpenCode",
    "OpenCode fork provenance mismatch",
  );
  return {
    ok: true,
    version,
    sourceCommit: run("git", ["rev-parse", "HEAD"]),
    profile: profile.profile,
    openCodeCommit: distribution.forkCommit,
  };
}

if (process.argv[1] === scriptPath) {
  try {
    process.stdout.write(`${JSON.stringify(reviewLocalRelease(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
