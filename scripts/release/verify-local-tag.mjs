import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "../..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  invariant(
    result.status === 0,
    `git ${args.join(" ")} failed: ${String(result.stderr).trim()}`,
  );
  return String(result.stdout).trim();
}

export function verifyLocalTag(tag, { requireClean = true } = {}) {
  const version = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/desktop/package.json"), "utf8"),
  ).version;
  const expectedTag = `agencyai-desktop-v${version}`;
  invariant(tag === expectedTag, `Expected exact release tag ${expectedTag}`);
  invariant(
    git(["cat-file", "-t", `refs/tags/${tag}`]) === "tag",
    "AgencyAI desktop releases require an annotated tag",
  );
  const tagCommit = git(["rev-list", "-n", "1", `refs/tags/${tag}`]);
  const headCommit = git(["rev-parse", "HEAD"]);
  invariant(
    tagCommit === headCommit,
    "Release tag does not identify the checked-out commit",
  );
  if (requireClean) {
    invariant(
      git(["status", "--short", "--untracked-files=all"]) === "",
      "Release tag verification requires a clean worktree",
    );
  }
  return { ok: true, tag, version, commit: headCommit };
}

if (process.argv[1] === scriptPath) {
  try {
    process.stdout.write(
      `${JSON.stringify(verifyLocalTag(process.argv[2]), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
