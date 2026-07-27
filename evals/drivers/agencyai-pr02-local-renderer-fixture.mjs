import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const FIXTURE_PREFIX = "agencyai-pr02-";
const MANIFEST_NAME = "manifest.json";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveFixtureRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("fixture root is required");
  }
  const resolved = path.resolve(value);
  const temporaryRoot = path.resolve(tmpdir());
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !path.basename(resolved).startsWith(FIXTURE_PREFIX)
  ) {
    throw new Error(
      `fixture root must be a ${FIXTURE_PREFIX}* directory inside ${temporaryRoot}`,
    );
  }
  return resolved;
}

export async function createLocalRendererFixture(rootInput) {
  const root = resolveFixtureRoot(rootInput);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await readdir(root);
  if (existing.length > 0) {
    throw new Error(`fixture root must be empty: ${root}`);
  }

  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "agencyai-storage");
  const appData = path.join(home, "Library", "Application Support");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(storageRoot, { recursive: true, mode: 0o700 }),
    mkdir(appData, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    path.join(workspace, "README.md"),
    "# AgencyAI PR02 local renderer fixture\n",
    "utf8",
  );

  const manifest = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    root,
    home,
    appData,
    workspace,
    storageRoot,
    manifestPath: path.join(root, MANIFEST_NAME),
  });
  await writeFile(manifest.manifestPath, stableJson(manifest), "utf8");
  return manifest;
}

export async function verifyLocalRendererFixture(rootInput) {
  const root = resolveFixtureRoot(rootInput);
  const manifest = JSON.parse(
    await readFile(path.join(root, MANIFEST_NAME), "utf8"),
  );
  if (
    manifest.schemaVersion !== SCHEMA_VERSION
    || manifest.root !== root
  ) {
    throw new Error("invalid AgencyAI PR02 fixture manifest");
  }

  const checks = {};
  for (const [name, candidate] of Object.entries({
    home: manifest.home,
    appData: manifest.appData,
    workspace: manifest.workspace,
    storageRoot: manifest.storageRoot,
  })) {
    const info = await stat(candidate);
    checks[name] = info.isDirectory();
  }
  const passed = Object.values(checks).every(Boolean);
  if (!passed) {
    throw new Error(`AgencyAI PR02 fixture verification failed: ${stableJson(checks)}`);
  }
  return { passed, manifest, checks };
}

async function main() {
  const mode = process.argv[2] ?? "";
  const root = process.argv[3] ?? "";
  if (mode === "setup") {
    process.stdout.write(
      stableJson({
        passed: true,
        mode,
        manifest: await createLocalRendererFixture(root),
      }),
    );
    return;
  }
  if (mode === "verify") {
    process.stdout.write(
      stableJson({
        mode,
        ...(await verifyLocalRendererFixture(root)),
      }),
    );
    return;
  }
  throw new Error(
    "usage: agencyai-pr02-local-renderer-fixture.mjs setup|verify <fixture-root>",
  );
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
