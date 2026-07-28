import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const FIXTURE_PREFIX = "agencyai-pr01-";
const MANIFEST_NAME = "manifest-before.json";
const AFTER_NAME = "manifest-after.json";

const PROTECTED_RELATIVE_ROOTS = Object.freeze([
  ".config/openwork",
  ".config/opencode",
  ".cache/opencode",
  ".local/share/opencode",
  ".local/state/opencode",
  ".openwork",
  "Desktop/desktop-bootstrap.json",
  "Downloads/desktop-bootstrap.json",
  "Library/Application Support/com.differentai.openwork",
  "Library/Application Support/com.differentai.openwork.dev",
  "Library/Application Support/opencode",
  "Library/Caches/com.differentai.openwork.ShipIt",
  "Library/Preferences/com.differentai.openwork.ShipIt.plist",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixtureRoot(value) {
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

async function writeSeed(home, relativePath, contents) {
  const target = path.join(home, relativePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, "utf8");
}

async function snapshotEntry(home, absolutePath, relativePath, entries) {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    throw new Error(`fixture protected path may not be a symlink: ${relativePath}`);
  }
  if (info.isDirectory()) {
    entries.push({ path: relativePath, type: "directory" });
    const children = await readdir(absolutePath);
    children.sort((left, right) => left.localeCompare(right));
    for (const child of children) {
      await snapshotEntry(
        home,
        path.join(absolutePath, child),
        path.posix.join(relativePath.split(path.sep).join("/"), child),
        entries,
      );
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`unsupported fixture entry type: ${relativePath}`);
  }
  const bytes = await readFile(absolutePath);
  entries.push({
    path: relativePath.split(path.sep).join("/"),
    type: "file",
    size: bytes.length,
    sha256: sha256(bytes),
  });
}

export async function snapshotProtectedState(home) {
  const entries = [];
  for (const relativeRoot of PROTECTED_RELATIVE_ROOTS) {
    await snapshotEntry(
      home,
      path.join(home, ...relativeRoot.split("/")),
      relativeRoot,
      entries,
    );
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    protectedRoots: [...PROTECTED_RELATIVE_ROOTS],
    entries,
    sha256: sha256(JSON.stringify(entries)),
  });
}

export async function createCoexistenceFixture(rootInput) {
  const root = fixtureRoot(rootInput);
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
    mkdir(appData, { recursive: true, mode: 0o700 }),
  ]);

  const staleBootstrap = stableJson({
    baseUrl: "https://stale.openworklabs.com",
    apiBaseUrl: "https://stale.openworklabs.com/api/den",
    requireSignin: true,
    brandAppName: "Stale OpenWork Organization",
  });
  const staleOpenCodeConfig = stableJson({
    provider: {
      "stale-global": {
        npm: "@ai-sdk/openai-compatible",
        name: "Stale Global Provider",
        options: { baseURL: "https://stale-provider.invalid/v1" },
      },
    },
    mcp: {
      "openwork-cloud": {
        type: "remote",
        url: "https://stale.openworklabs.com/mcp",
      },
    },
    plugin: ["stale-global-plugin"],
  });

  await Promise.all([
    writeSeed(home, ".config/openwork/desktop-bootstrap.json", staleBootstrap),
    writeSeed(home, ".config/openwork/server.json", stableJson({
      baseUrl: "https://stale.openworklabs.com",
      remoteAccess: true,
    })),
    writeSeed(home, ".config/openwork/env.json", stableJson({
      OPENWORK_CLOUD_TOKEN: "non-secret-stale-fixture",
    })),
    writeSeed(home, ".config/opencode/opencode.json", staleOpenCodeConfig),
    writeSeed(home, ".config/opencode/config.json", staleOpenCodeConfig),
    writeSeed(home, ".config/opencode/opencode.jsonc", `${staleOpenCodeConfig.trim()}\n`),
    writeSeed(home, ".config/opencode/mcp-auth.json", stableJson({
      "openwork-cloud": { token: "non-secret-stale-fixture" },
    })),
    writeSeed(
      home,
      ".cache/opencode/cache.json",
      stableJson({ source: "stale-global-cache" }),
    ),
    writeSeed(
      home,
      ".local/share/opencode/opencode.db",
      "stale-xdg-global-opencode-database-fixture\n",
    ),
    writeSeed(
      home,
      ".local/share/opencode/mcp-auth.json",
      stableJson({ "openwork-cloud": { token: "non-secret-stale-xdg-fixture" } }),
    ),
    writeSeed(
      home,
      ".local/state/opencode/state.json",
      stableJson({ source: "stale-global-state" }),
    ),
    writeSeed(
      home,
      ".config/opencode/plugins/stale-global.js",
      "export const staleGlobalPlugin = true;\n",
    ),
    writeSeed(
      home,
      ".config/opencode/commands/stale-global.md",
      "# Stale global command\n",
    ),
    writeSeed(
      home,
      ".config/opencode/skills/stale-global/SKILL.md",
      "# Stale global skill\n",
    ),
    writeSeed(home, ".openwork/openwork-server/server.json", staleBootstrap),
    writeSeed(home, ".openwork/openwork-server/tokens.json", stableJson({
      ownerToken: "non-secret-stale-fixture",
    })),
    writeSeed(home, "Desktop/desktop-bootstrap.json", staleBootstrap),
    writeSeed(home, "Downloads/desktop-bootstrap.json", staleBootstrap),
    writeSeed(
      home,
      "Library/Application Support/com.differentai.openwork/workspaces.json",
      stableJson({
        activeId: "stale-upstream-workspace",
        workspaces: [{
          id: "stale-upstream-workspace",
          path: "/tmp/stale-upstream-workspace",
          type: "remote",
        }],
      }),
    ),
    writeSeed(
      home,
      "Library/Application Support/com.differentai.openwork/server-state.json",
      stableJson({
        baseUrl: "https://stale.openworklabs.com",
        remoteAccess: true,
      }),
    ),
    writeSeed(
      home,
      "Library/Application Support/com.differentai.openwork.dev/workspaces.json",
      stableJson({ workspaces: [{ id: "stale-dev-workspace" }] }),
    ),
    writeSeed(
      home,
      "Library/Application Support/opencode/opencode.db",
      "stale-global-opencode-database-fixture\n",
    ),
    writeSeed(
      home,
      "Library/Caches/com.differentai.openwork.ShipIt/ShipItState.plist",
      "stale-upstream-shipit-cache-fixture\n",
    ),
    writeSeed(
      home,
      "Library/Preferences/com.differentai.openwork.ShipIt.plist",
      "stale-upstream-shipit-defaults-fixture\n",
    ),
    writeFile(
      path.join(workspace, "README.md"),
      "# AgencyAI PR01 fixture workspace\n",
      "utf8",
    ),
  ]);

  const before = await snapshotProtectedState(home);
  const manifest = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    root,
    home,
    appData,
    workspace,
    storageRoot,
    manifestPath: path.join(root, MANIFEST_NAME),
    protectedState: before,
  });
  await writeFile(manifest.manifestPath, stableJson(manifest), "utf8");
  return manifest;
}

export async function verifyCoexistenceFixture(rootInput) {
  const root = fixtureRoot(rootInput);
  const manifestPath = path.join(root, MANIFEST_NAME);
  const before = JSON.parse(await readFile(manifestPath, "utf8"));
  if (before.schemaVersion !== SCHEMA_VERSION || before.root !== root) {
    throw new Error("invalid AgencyAI PR01 fixture manifest");
  }
  const afterState = await snapshotProtectedState(before.home);
  const passed = JSON.stringify(afterState) === JSON.stringify(before.protectedState);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    passed,
    root,
    beforeSha256: before.protectedState.sha256,
    afterSha256: afterState.sha256,
    protectedRoots: afterState.protectedRoots,
    beforeEntries: before.protectedState.entries,
    afterEntries: afterState.entries,
  };
  await writeFile(path.join(root, AFTER_NAME), stableJson(report), "utf8");
  if (!passed) {
    throw new Error(
      `protected upstream state changed: ${before.protectedState.sha256} -> ${afterState.sha256}`,
    );
  }
  return report;
}

async function main() {
  const mode = process.argv[2] ?? "";
  const root = process.argv[3] ?? "";
  if (mode === "setup") {
    const manifest = await createCoexistenceFixture(root);
    process.stdout.write(stableJson({ passed: true, mode, manifest }));
    return;
  }
  if (mode === "verify") {
    const report = await verifyCoexistenceFixture(root);
    process.stdout.write(stableJson({ passed: true, mode, report }));
    return;
  }
  throw new Error("usage: agencyai-pr01-coexistence-fixture.mjs setup|verify <fixture-root>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
