import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import {
  inventoryTree,
  sha256FileSync,
} from "./generate-release-metadata.mjs";
import { isRestrictedRepositoryPath } from "../../../scripts/check-source-closure.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const profile = JSON.parse(
  readFileSync(
    resolve(desktopRoot, "../../packages/product-config/profiles/local-mvp.json"),
    "utf8",
  ),
);
const FORBIDDEN_RESOURCE_NAMES = Object.freeze([
  "app-update.yml",
  "app-update.yaml",
  "latest.yml",
  "latest-mac.yml",
]);
const FORBIDDEN_TEXT = Object.freeze([
  "api.openworklabs.com",
  "app.openworklabs.com",
  "models.openworklabs.com",
  "us.i.posthog.com",
  "com.differentai.openwork",
  "support@openworklabs.com",
  "team@openworklabs.com",
  "founders@openworklabs.com",
]);
const REQUIRED_METADATA = Object.freeze([
  "ELECTRON-LICENSE.txt",
  "LICENSES.chromium.html",
  "OPENWORK-LICENSE.txt",
  "OPENCODE-LICENSE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "agencyai-desktop.cdx.json",
  "agencyai-desktop.spdx.json",
  "opencode/evidence-inventory.json",
  "opencode/opencode-build-source.cdx.json",
  "opencode/opencode-darwin-arm64.cdx.json",
  "opencode/opencode-darwin-arm64.spdx.json",
  "opencode/provenance.json",
  "release-manifest.json",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs() {
  const values = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  return values.length
    ? values
    : [resolve(desktopRoot, "dist-electron/mac-arm64/agencyai.app")];
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${commandName} ${args.join(" ")} failed: ${
        String(result.stderr ?? "").trim()
      }`,
    );
  }
  return String(result.stdout ?? "");
}

function findApps(root) {
  const apps = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        apps.push(filePath);
      } else if (entry.isDirectory()) {
        visit(filePath);
      }
    }
  }
  visit(root);
  return apps;
}

function mountDmg(dmgPath, mountPoint) {
  command("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noverify",
    "-mountpoint",
    mountPoint,
    dmgPath,
  ]);
  return () => command("hdiutil", ["detach", mountPoint, "-force"]);
}

function withResolvedApp(artifactPath, callback) {
  const resolvedArtifact = realpathSync(resolve(artifactPath));
  const stats = lstatSync(resolvedArtifact);
  if (
    stats.isDirectory()
    && resolvedArtifact.endsWith(".app")
    && !stats.isSymbolicLink()
  ) {
    return callback(resolvedArtifact, "app");
  }

  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "agencyai-artifact-inspect-"),
  );
  let cleanupMount = null;
  try {
    if (stats.isFile() && extname(resolvedArtifact).toLowerCase() === ".zip") {
      command("ditto", ["-x", "-k", resolvedArtifact, temporaryDirectory]);
    } else if (
      stats.isFile()
      && extname(resolvedArtifact).toLowerCase() === ".dmg"
    ) {
      cleanupMount = mountDmg(resolvedArtifact, temporaryDirectory);
    } else if (stats.isDirectory()) {
      const apps = findApps(resolvedArtifact);
      invariant(apps.length === 1, `Expected one .app below ${resolvedArtifact}`);
      return callback(realpathSync(apps[0]), "directory");
    } else {
      throw new Error(`Unsupported artifact: ${resolvedArtifact}`);
    }
    const apps = findApps(temporaryDirectory);
    invariant(
      apps.length === 1,
      `Expected exactly one AgencyAI.app in ${basename(resolvedArtifact)}; received ${apps.length}`,
    );
    return callback(realpathSync(apps[0]), extname(resolvedArtifact).slice(1));
  } finally {
    if (cleanupMount) cleanupMount();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readPlistJson(plistPath) {
  return JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", plistPath],
      { encoding: "utf8" },
    ),
  );
}

function assertMachO(filePath, architecture = "arm64") {
  const description = command("/usr/bin/file", ["-b", filePath]).trim();
  invariant(
    description.includes("Mach-O") && description.includes(architecture),
    `${filePath} is not a ${architecture} Mach-O: ${description}`,
  );
}

function findRuntimeMachO(resourcesPath) {
  const inventory = inventoryTree(resourcesPath);
  return inventory
    .filter(
      (entry) =>
        entry.type === "file"
        && (
          (
            entry.path.startsWith("sidecars/")
            && !entry.path.startsWith("sidecars/versions.json")
          )
          || entry.path === "toolchain/aarch64-apple-darwin/rg"
          || entry.path
            === "helpers/AgencyAI Computer Use.app/Contents/MacOS/ComputerUse"
          || entry.path.endsWith(".node")
          || entry.path.endsWith("/spawn-helper")
        ),
    )
    .map((entry) => join(resourcesPath, ...entry.path.split("/")));
}

function inspectReleaseMetadata(resourcesPath) {
  const metadataRoot = join(resourcesPath, "release-metadata");
  invariant(existsSync(metadataRoot), "release-metadata directory is missing");
  for (const fileName of REQUIRED_METADATA) {
    const filePath = join(metadataRoot, ...fileName.split("/"));
    invariant(existsSync(filePath), `Missing release metadata: ${fileName}`);
    const stats = lstatSync(filePath);
    invariant(
      stats.isFile() && !stats.isSymbolicLink() && stats.size > 0,
      `Unsafe or empty release metadata: ${fileName}`,
    );
  }

  const manifest = JSON.parse(
    readFileSync(join(metadataRoot, "release-manifest.json"), "utf8"),
  );
  invariant(manifest.schemaVersion === 1, "Release manifest schema mismatch");
  invariant(manifest.product === "AgencyAI Desktop", "Release manifest product mismatch");
  invariant(manifest.profile === "local-mvp", "Release manifest profile mismatch");
  invariant(
    manifest.target === "aarch64-apple-darwin",
    "Release manifest target mismatch",
  );
  const actualResources = inventoryTree(resourcesPath).filter(
    (entry) => entry.path !== "release-metadata/release-manifest.json",
  );
  invariant(
    JSON.stringify(actualResources) === JSON.stringify(manifest.resources.files),
    "Packaged resources no longer match the signed release manifest",
  );
  invariant(
    manifest.application.asarSha256
      === sha256FileSync(join(resourcesPath, "app.asar")),
    "Packaged ASAR hash does not match release manifest",
  );

  const spdx = JSON.parse(
    readFileSync(join(metadataRoot, "agencyai-desktop.spdx.json"), "utf8"),
  );
  const cycloneDx = JSON.parse(
    readFileSync(join(metadataRoot, "agencyai-desktop.cdx.json"), "utf8"),
  );
  invariant(spdx.spdxVersion === "SPDX-2.3", "SPDX version must be 2.3");
  invariant(
    cycloneDx.bomFormat === "CycloneDX" && cycloneDx.specVersion === "1.7",
    "CycloneDX version must be 1.7",
  );
  invariant(
    spdx.packages.length === cycloneDx.components.length,
    "SPDX and CycloneDX component inventories disagree",
  );
  for (const component of [
    {
      name: "OpenCode",
      path: join(
        resourcesPath,
        "sidecars",
        `opencode-${manifest.target}`,
      ),
    },
    {
      name: "ripgrep",
      path: join(
        resourcesPath,
        "toolchain",
        manifest.target,
        manifest.target.endsWith("windows-msvc") ? "rg.exe" : "rg",
      ),
    },
  ]) {
    const expectedHash = sha256FileSync(component.path);
    const spdxPackage = spdx.packages.find(
      (entry) => entry.name === component.name,
    );
    const cycloneDxComponent = cycloneDx.components.find(
      (entry) => entry.name === component.name,
    );
    invariant(
      spdxPackage?.checksums?.some(
        (checksum) =>
          checksum.algorithm === "SHA256"
          && checksum.checksumValue === expectedHash,
      ),
      `${component.name} SPDX hash does not match the packaged binary`,
    );
    invariant(
      cycloneDxComponent?.hashes?.some(
        (hash) =>
          hash.alg === "SHA-256"
          && hash.content === expectedHash,
      ),
      `${component.name} CycloneDX hash does not match the packaged binary`,
    );
  }
  return manifest;
}

function inspectTextClosure(resourcesPath) {
  for (const entry of inventoryTree(resourcesPath)) {
    invariant(
      !isRestrictedRepositoryPath(entry.path),
      `Packaged restricted enterprise path found: ${entry.path}`,
    );
    const lowerName = basename(entry.path).toLowerCase();
    invariant(
      !FORBIDDEN_RESOURCE_NAMES.includes(lowerName)
        && !lowerName.endsWith(".blockmap"),
      `Updater metadata is forbidden: ${entry.path}`,
    );
    if (
      entry.type !== "file"
      || entry.size > 4 * 1024 * 1024
      || !/\.(?:c?js|mjs|json|html?|css|mdx?|txt|ya?ml)$/i.test(entry.path)
    ) {
      continue;
    }
    const text = readFileSync(
      join(resourcesPath, ...entry.path.split("/")),
      "utf8",
    );
    for (const forbidden of FORBIDDEN_TEXT) {
      invariant(
        !text.toLowerCase().includes(forbidden.toLowerCase()),
        `Forbidden production value ${forbidden} found in ${entry.path}`,
      );
    }
  }
}

export function inspectPackagedApp(appPath, artifactType = "app") {
  const realAppPath = realpathSync(appPath);
  invariant(
    basename(realAppPath) === `${profile.brand.executableName}.app`,
    `Unexpected app bundle name: ${basename(realAppPath)}`,
  );
  const contentsPath = join(realAppPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const plist = readPlistJson(join(contentsPath, "Info.plist"));
  invariant(
    plist.CFBundleIdentifier === profile.brand.appId,
    `Unexpected bundle ID: ${plist.CFBundleIdentifier}`,
  );
  invariant(
    plist.CFBundleName === profile.brand.name
      && plist.CFBundleDisplayName === profile.brand.name
      && plist.CFBundleExecutable === profile.brand.executableName,
    "Packaged macOS identity does not match the AgencyAI product profile",
  );
  invariant(
    plist.CFBundleURLTypes === undefined,
    "Public URL protocol registration must be absent",
  );
  invariant(
    plist.NSAppTransportSecurity?.NSAllowsArbitraryLoads === false,
    "Arbitrary network loads must be disabled",
  );
  invariant(
    plist.NSAppTransportSecurity?.NSAllowsLocalNetworking === true,
    "Loopback networking must remain enabled",
  );
  assertMachO(join(contentsPath, "MacOS", profile.brand.executableName));
  const asarEntries = listPackage(join(resourcesPath, "app.asar"));
  invariant(
    !asarEntries.some((entry) => isRestrictedRepositoryPath(entry)),
    "ASAR contains a restricted enterprise path",
  );
  inspectTextClosure(resourcesPath);
  const manifest = inspectReleaseMetadata(resourcesPath);
  for (const filePath of findRuntimeMachO(resourcesPath)) {
    assertMachO(filePath);
  }
  command("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    realAppPath,
  ]);
  return {
    ok: true,
    artifactType,
    appPath: realAppPath,
    version: plist.CFBundleShortVersionString,
    sourceCommit: manifest.source.commit,
    resources: manifest.resources.count,
    components: manifest.application.componentCount,
    appSha256: sha256FileSync(join(resourcesPath, "app.asar")),
  };
}

export function inspectArtifact(artifactPath) {
  return withResolvedApp(artifactPath, inspectPackagedApp);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const results = parseArgs().map(inspectArtifact);
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `[artifact-inspector] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
