import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArguments, scanSourceClosure } from "./check-source-closure.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const guardPath = fileURLToPath(new URL("./check-source-closure.mjs", import.meta.url));
const restrictedSegment = String.fromCharCode(101, 101);
const restrictedScope = ["@openwork", restrictedSegment].join("-");
const restrictedPackage = ["openwork", restrictedSegment].join("-");
const upstreamSlug = [
  ["different", "ai"].join("-"),
  ["open", "work"].join(""),
].join("/");
const allowlistName = ["source", "closure", "documentary", "allowlist"].join("-") + ".json";

async function writeFixtureFile(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function createFixture(files = {}, entries = []) {
  const root = await mkdtemp(path.join(tmpdir(), "agencyai-source-closure-"));
  await writeFixtureFile(
    root,
    `scripts/${allowlistName}`,
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFixtureFile(root, relativePath, content);
  }
  return root;
}

function codes(findings) {
  return findings.map((item) => item.code);
}

function findingsFor(findings, file) {
  return findings.filter((item) => item.file === file);
}

test("parses repeatable staged directories and rejects empty option values", () => {
  const options = parseArguments([
    "--root=/tmp/source-root",
    "--staged-dir",
    "/tmp/staged-one",
    "--staged-dir=/tmp/staged-two",
    "--json",
  ]);
  assert.equal(options.root, "/tmp/source-root");
  assert.deepEqual(options.stagedDirectories, ["/tmp/staged-one", "/tmp/staged-two"]);
  assert.equal(options.json, true);
  assert.throws(() => parseArguments(["--staged-dir="]), /requires a value/);
  assert.throws(() => parseArguments(["--root="]), /requires a value/);
});

test("rejects literal, joined, and resolved restricted source paths without substring false positives", async () => {
  const letter = restrictedSegment.slice(0, 1);
  const root = await createFixture({
    "src/literal.mjs": `const target = path.join(root, "${restrictedSegment}", "apps");\n`,
    "src/split.mjs": [
      `const segment = ["${letter}", "${letter}"].join("");`,
      "const target = resolve(root, segment, \"apps\");",
      "",
    ].join("\n"),
    "src/allowed.mjs": [
      `const treePath = "tree/feature";`,
      `const hyphenated = "${restrictedSegment}-first";`,
      `const locale = "${restrictedSegment}";`,
      "",
    ].join("\n"),
  });

  const findings = await scanSourceClosure({ root });
  assert.equal(findingsFor(findings, "src/literal.mjs").length, 1);
  assert.equal(findingsFor(findings, "src/split.mjs").length, 1);
  assert.deepEqual(findingsFor(findings, "src/allowed.mjs"), []);
  assert.ok(findings.every((item) => item.code === "EE_EXECUTABLE_REFERENCE"));
});

test("rejects bare restricted paths only in path-bearing contexts", async () => {
  const root = await createFixture({
    "package.json": `${JSON.stringify({
      scripts: { private: `cd ${restrictedSegment} && node build.mjs` },
    }, null, 2)}\n`,
    "pnpm-workspace.yaml": `packages:\n  - ${restrictedSegment}\n`,
    "Dockerfile": `COPY ${restrictedSegment} private-source\n`,
    "src/resolve.mjs": `const source = path.resolve("${restrictedSegment}");\n`,
    "src/chdir.mjs": `process.chdir("${restrictedSegment}");\n`,
    "src/locale.mjs": `const locale = "${restrictedSegment}";\n`,
  });

  const findings = await scanSourceClosure({ root });
  assert.ok(findingsFor(findings, "package.json").some(
    (item) => item.code === "EE_PACKAGE_REFERENCE",
  ));
  assert.ok(findingsFor(findings, "pnpm-workspace.yaml").some(
    (item) => item.code === "EE_WORKSPACE_REFERENCE",
  ));
  assert.ok(findingsFor(findings, "Dockerfile").some(
    (item) => item.code === "EE_EXECUTABLE_REFERENCE",
  ));
  assert.ok(findingsFor(findings, "src/resolve.mjs").some(
    (item) => item.code === "EE_EXECUTABLE_REFERENCE",
  ));
  assert.ok(findingsFor(findings, "src/chdir.mjs").some(
    (item) => item.code === "EE_EXECUTABLE_REFERENCE",
  ));
  assert.deepEqual(findingsFor(findings, "src/locale.mjs"), []);
});

test("classifies workspace, lockfile, manifest script, and package references", async () => {
  const root = await createFixture({
    "pnpm-workspace.yaml": `packages:\n  - "${restrictedSegment}/apps/*"\n`,
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "importers:",
      `  ${restrictedSegment}/apps/control:`,
      `    resolution: {directory: ${restrictedSegment}/packages/shared}`,
      "",
    ].join("\n"),
    "package.json": `${JSON.stringify({
      scripts: { private: `pnpm --filter ${restrictedScope}/control build` },
      dependencies: { [restrictedPackage]: "workspace:*" },
    }, null, 2)}\n`,
  });

  const findings = await scanSourceClosure({ root });
  assert.ok(codes(findings).includes("EE_WORKSPACE_REFERENCE"));
  assert.ok(codes(findings).includes("EE_LOCK_REFERENCE"));
  assert.ok(codes(findings).includes("EE_PACKAGE_REFERENCE"));
  assert.ok(findingsFor(findings, "package.json").length >= 2);
});

test("detects the root tree, tracked paths, and a root symlink", async (context) => {
  await context.test("directory and tracked index entries", async () => {
    const root = await createFixture({
      [`${restrictedSegment}/apps/control/index.mjs`]: "export {};\n",
    });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });

    const findings = await scanSourceClosure({ root });
    assert.ok(codes(findings).includes("EE_ROOT_PRESENT"));
    assert.ok(codes(findings).includes("EE_TRACKED_PATH"));
  });

  await context.test("symlink", async () => {
    const root = await createFixture({ "private-source/index.mjs": "export {};\n" });
    await symlink(path.join(root, "private-source"), path.join(root, restrictedSegment));

    const findings = await scanSourceClosure({ root });
    assert.ok(findings.some(
      (item) => item.code === "EE_ROOT_PRESENT" && item.value === "symlink",
    ));
  });
});

test("scans staged output paths, content, and symlink targets", async () => {
  const root = await createFixture({ "src/index.mjs": "export {};\n" });
  const staged = await mkdtemp(path.join(tmpdir(), "agencyai-staged-"));
  await writeFixtureFile(
    staged,
    `resources/${restrictedSegment.toUpperCase()}/private.js`,
    "export const privateValue = true;\n",
  );
  await writeFixtureFile(
    staged,
    "resources/copied-config.mjs",
    `export const copied = "${restrictedSegment}/packages/shared";\n`,
  );
  await writeFixtureFile(
    staged,
    "node_modules/copied-package/index.js",
    `module.exports = "${restrictedSegment}/packages/shared";\n`,
  );
  await symlink(
    path.join("..", restrictedSegment, "private.js"),
    path.join(staged, "resources", "private-link"),
  );

  const findings = await scanSourceClosure({ root, stagedDirectories: [staged] });
  assert.ok(codes(findings).includes("EE_STAGED_PATH"));
  assert.ok(codes(findings).includes("EE_STAGED_CONTENT"));
  assert.ok(codes(findings).includes("EE_STAGED_SYMLINK"));
  assert.ok(findings.some(
    (item) => item.file === "@staged/0/node_modules/copied-package/index.js",
  ));
});

test("staged JavaScript ignores minified division identifiers but still scans string paths", async () => {
  const root = await createFixture({ "src/index.mjs": "export {};\n" });
  const staged = await mkdtemp(path.join(tmpdir(), "agencyai-staged-"));
  await writeFixtureFile(
    staged,
    "assets/minified.js",
    [
      "const image = `generated",
      String.fromCharCode(96) + ",",
      `const ${restrictedSegment}=4;const value=1+${restrictedSegment}/2;`,
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    staged,
    "assets/copied.js",
    `export const copied = "${restrictedSegment}/packages/shared";\n`,
  );

  const findings = await scanSourceClosure({ root, stagedDirectories: [staged] });
  assert.equal(
    findings.some((item) => item.file === "@staged/0/assets/minified.js"),
    false,
  );
  assert.ok(findings.some(
    (item) =>
      item.code === "EE_STAGED_CONTENT" &&
      item.file === "@staged/0/assets/copied.js",
  ));
});

test("rejects direct, split, workflow, and archive acquisition of upstream source", async () => {
  const owner = upstreamSlug.split("/")[0];
  const repository = upstreamSlug.split("/")[1];
  const root = await createFixture({
    "scripts/direct.sh": `git clone https://github.com/${upstreamSlug}.git\n`,
    "scripts/split.mjs": [
      `const source = ["${owner}", "${repository}"].join("/");`,
      "spawn(\"git\", [\"clone\", source]);",
      "",
    ].join("\n"),
    ".github/workflows/source.yml": [
      "steps:",
      "  - uses: actions/checkout@v4",
      "    with:",
      `      repository: ${upstreamSlug}`,
      "",
    ].join("\n"),
    "scripts/archive.sh": `curl -L https://github.com/${upstreamSlug}/archive/refs/heads/dev.tar.gz\n`,
    "scripts/multiline.sh": [
      "git clone \\",
      `  https://github.com/${upstreamSlug}`,
      "",
    ].join("\n"),
    "docs/plain.md": `Reference: https://github.com/${upstreamSlug}\n`,
    "package.json": `${JSON.stringify({
      repository: { type: "git", url: `git+https://github.com/${upstreamSlug}.git` },
      homepage: `https://github.com/${upstreamSlug}/tree/dev`,
    }, null, 2)}\n`,
  });

  const findings = await scanSourceClosure({ root });
  const acquisitionFindings = findings.filter((item) => item.code === "UPSTREAM_SOURCE_ACQUISITION");
  assert.equal(acquisitionFindings.length, 5);
  assert.deepEqual(findingsFor(findings, "docs/plain.md"), []);
  assert.deepEqual(findingsFor(findings, "package.json"), []);
});

test("allows only exact reviewed documentary paths and rejects config exemptions", async () => {
  const root = await createFixture(
    {
      "docs/reviewed.md": `The removed /${restrictedSegment} source used a separate license.\n`,
      "docs/unreviewed.md": `The removed /${restrictedSegment} source used a separate license.\n`,
      "scripts/exempt.mjs": `const source = "${restrictedSegment}/apps/control";\n`,
      ".opencode/skills/private/SKILL.md": "Executable agent instructions.\n",
    },
    [
      {
        path: "docs/reviewed.md",
        reason: "Retains reviewed source-boundary provenance for downstream readers.",
      },
      {
        path: "scripts/exempt.mjs",
        reason: "Attempts to exempt executable configuration and must be rejected.",
      },
      {
        path: ".opencode/skills/private/SKILL.md",
        reason: "Attempts to exempt executable agent instructions and must be rejected.",
      },
    ],
  );

  const findings = await scanSourceClosure({ root });
  assert.deepEqual(findingsFor(findings, "docs/reviewed.md"), []);
  assert.ok(findingsFor(findings, "docs/unreviewed.md").some(
    (item) => item.code === "EE_DOCUMENT_REFERENCE",
  ));
  assert.ok(findingsFor(findings, "scripts/exempt.mjs").some(
    (item) => item.code === "EE_EXECUTABLE_REFERENCE",
  ));
  assert.ok(codes(findings).includes("ALLOWLIST_INVALID"));
});

test("fails closed with a stable finding when the documentary allowlist is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agencyai-source-closure-missing-"));
  await writeFixtureFile(root, "src/index.mjs", "export {};\n");

  const findings = await scanSourceClosure({ root });
  assert.deepEqual(findings, [
    {
      code: "ALLOWLIST_MISSING",
      file: `scripts/${allowlistName}`,
      line: 1,
      field: "allowlist",
      value: "required file is missing or unreadable",
    },
  ]);
});

test("JSON output is deterministic, sorted, and uses the stable finding schema", async () => {
  const root = await createFixture({
    "z-last.mjs": `const privatePath = "${restrictedSegment}/last";\n`,
    "a-first.mjs": `const privatePath = "${restrictedSegment}/first";\n`,
  });

  const command = ["--root", root, "--json"];
  const first = spawnSync(process.execPath, [guardPath, ...command], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [guardPath, ...command], { encoding: "utf8" });
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.equal(first.stdout, second.stdout);

  const result = JSON.parse(first.stdout);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.findings[0]), ["code", "file", "line", "field", "value"]);
  assert.deepEqual(
    result.findings.map((item) => item.file),
    [...result.findings.map((item) => item.file)].sort(),
  );
});

test("the current checkout reports its root source-boundary state accurately", async () => {
  const rootEntry = path.join(repositoryRoot, restrictedSegment);
  const rootExists = await lstat(rootEntry)
    .then(() => true)
    .catch(() => false);
  const findings = await scanSourceClosure({ root: repositoryRoot });
  assert.equal(codes(findings).includes("EE_ROOT_PRESENT"), rootExists);
});
