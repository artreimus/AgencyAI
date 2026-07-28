const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const sidecarBases = [
  "opencode",
  "openwork-orchestrator",
];

function normalizeArch(arch) {
  if (arch === 1 || arch === "x64") return "x64";
  if (arch === 3 || arch === "arm64") return "arm64";
  return null;
}

function targetTriple(platformName, arch) {
  const normalizedArch = normalizeArch(arch);
  if (platformName === "darwin") {
    if (normalizedArch === "arm64") return "aarch64-apple-darwin";
    if (normalizedArch === "x64") return "x86_64-apple-darwin";
  }
  if (platformName === "linux") {
    if (normalizedArch === "arm64") return "aarch64-unknown-linux-gnu";
    if (normalizedArch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platformName === "win32") {
    if (normalizedArch === "arm64") return "aarch64-pc-windows-msvc";
    if (normalizedArch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

function resolveSidecarsDir(context) {
  if (context.electronPlatformName === "darwin") {
    const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
    const appName = entries.find((entry) => entry.endsWith(".app"));
    return appName ? path.join(context.appOutDir, appName, "Contents", "Resources", "sidecars") : null;
  }
  return path.join(context.appOutDir, "resources", "sidecars");
}

function resolveMacAppPath(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const direct = path.join(context.appOutDir, appName);
  if (fs.existsSync(direct)) return direct;

  const entries = fs.existsSync(context.appOutDir) ? fs.readdirSync(context.appOutDir) : [];
  const fallback = entries.find((entry) => entry.endsWith(".app"));
  return fallback ? path.join(context.appOutDir, fallback) : null;
}

function resolveResourcesDir(context) {
  const appPath = resolveMacAppPath(context);
  if (appPath) return path.join(appPath, "Contents", "Resources");
  return path.join(context.appOutDir, "resources");
}

function walkFiles(root, current = root) {
  if (!fs.existsSync(current)) return [];
  const output = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const filePath = path.join(current, entry.name);
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Native payload cannot contain symbolic links: ${path.relative(root, filePath)}`,
      );
    }
    if (stats.isDirectory()) output.push(...walkFiles(root, filePath));
    else if (stats.isFile()) output.push(filePath);
  }
  return output;
}

function prunePackagedNativePayload(context, triple) {
  if (context.electronPlatformName !== "darwin") return [];
  const resourcesDir = resolveResourcesDir(context);
  const unpackedRoot = path.join(resourcesDir, "app.asar.unpacked");
  if (!fs.existsSync(unpackedRoot)) {
    throw new Error("Packaged app is missing app.asar.unpacked");
  }

  for (const filePath of walkFiles(unpackedRoot)) {
    const relativePath = path.relative(unpackedRoot, filePath)
      .split(path.sep)
      .join("/");
    if (
      relativePath.includes("/better-sqlite3/prebuilds/")
      && !relativePath.endsWith(
        triple === "aarch64-apple-darwin"
          ? "/better-sqlite3/prebuilds/darwin-arm64.node"
          : "/better-sqlite3/prebuilds/darwin-x64.node",
      )
    ) {
      fs.rmSync(filePath, { force: true });
    }
  }

  const nativeFiles = walkFiles(unpackedRoot)
    .filter((filePath) => {
      const relativePath = path.relative(unpackedRoot, filePath)
        .split(path.sep)
        .join("/");
      return relativePath.endsWith(".node")
        || relativePath.endsWith("/spawn-helper");
    })
    .sort();
  const expectedSuffixes = triple === "aarch64-apple-darwin"
    ? [
        "/better-sqlite3/prebuilds/darwin-arm64.node",
        "/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node",
        "/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper",
      ]
    : [
        "/better-sqlite3/prebuilds/darwin-x64.node",
        "/@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/pty.node",
        "/@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/spawn-helper",
      ];
  for (const suffix of expectedSuffixes) {
    const matches = nativeFiles.filter((filePath) =>
      filePath.split(path.sep).join("/").endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one packaged native payload ending in ${suffix}; received ${matches.length}`,
      );
    }
  }
  if (nativeFiles.length !== expectedSuffixes.length) {
    throw new Error(
      `Unexpected packaged native payload closure: ${nativeFiles
        .map((filePath) => path.relative(unpackedRoot, filePath))
        .join(", ")}`,
    );
  }

  const expectedArchitecture =
    triple === "aarch64-apple-darwin" ? "arm64" : "x86_64";
  for (const filePath of nativeFiles) {
    const description = execFileSync("/usr/bin/file", ["-b", filePath], {
      encoding: "utf8",
    }).trim();
    if (
      !description.includes("Mach-O")
      || !description.includes(expectedArchitecture)
    ) {
      throw new Error(
        `Wrong native architecture for ${filePath}: ${description}`,
      );
    }
  }
  return nativeFiles;
}

function enforceMacTransportSecurity(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const appPath = resolveMacAppPath(context);
  if (!appPath) {
    throw new Error("Cannot locate packaged macOS app for transport-policy hardening");
  }
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (
    !fs.existsSync(infoPlistPath)
    || !fs.lstatSync(infoPlistPath).isFile()
    || fs.lstatSync(infoPlistPath).isSymbolicLink()
  ) {
    throw new Error(`Unsafe or missing packaged Info.plist: ${infoPlistPath}`);
  }

  // electron-builder 26 forces this value to true for updater proxy support
  // after merging mac.extendInfo. AgencyAI's local MVP has no updater and must
  // retain only its explicit loopback HTTP exceptions.
  execFileSync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "-bool",
    "NO",
    infoPlistPath,
  ]);
  const transportSecurity = JSON.parse(execFileSync("/usr/bin/plutil", [
    "-extract",
    "NSAppTransportSecurity",
    "json",
    "-o",
    "-",
    infoPlistPath,
  ], { encoding: "utf8" }));
  if (
    transportSecurity.NSAllowsArbitraryLoads !== false
    || transportSecurity.NSAllowsLocalNetworking !== true
    || transportSecurity.NSExceptionDomains?.["127.0.0.1"]
      ?.NSTemporaryExceptionAllowsInsecureHTTPLoads !== true
    || transportSecurity.NSExceptionDomains?.localhost
      ?.NSTemporaryExceptionAllowsInsecureHTTPLoads !== true
  ) {
    throw new Error("Packaged macOS transport policy is not loopback-only");
  }
  return transportSecurity;
}

async function writePackagedRuntimeIntegrity(context, triple) {
  const resourcesDir = resolveResourcesDir(context);
  const distributionPath = path.join(resourcesDir, "opencode-distribution.json");
  if (!fs.existsSync(distributionPath) || !fs.lstatSync(distributionPath).isFile()) {
    throw new Error(`Missing packaged OpenCode distribution manifest: ${distributionPath}`);
  }
  const {
    PACKAGED_RUNTIME_INTEGRITY_FILE_NAME,
    assertRegularFileWithinRootSync,
    packagedRuntimeIntegrityRelativePaths,
    sha256FileSync,
  } = await import("../electron/opencode-distribution.mjs");
  assertRegularFileWithinRootSync(
    distributionPath,
    resourcesDir,
    "Packaged OpenCode distribution manifest",
  );
  const relativePaths = packagedRuntimeIntegrityRelativePaths(triple);

  const files = relativePaths.map((relativePath) => {
    const filePath = path.resolve(resourcesDir, ...relativePath.split("/"));
    assertRegularFileWithinRootSync(
      filePath,
      resourcesDir,
      `Packaged runtime integrity input ${relativePath}`,
    );
    return {
      path: relativePath,
      sha256: sha256FileSync(filePath),
    };
  });
  const integrity = {
    schemaVersion: 1,
    hashPhase: "post-nested-signing",
    target: triple,
    distributionManifestSha256: sha256FileSync(distributionPath),
    files,
  };
  const integrityPath = path.join(
    resourcesDir,
    PACKAGED_RUNTIME_INTEGRITY_FILE_NAME,
  );
  if (fs.existsSync(integrityPath)) {
    const stats = fs.lstatSync(integrityPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe packaged runtime integrity output: ${integrityPath}`);
    }
    fs.unlinkSync(integrityPath);
  }
  fs.writeFileSync(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  return integrity;
}

function copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName) {
  const targetPath = path.join(sidecarsDir, targetName);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing packaged sidecar for target: ${targetName}`);
  }

  const aliasPath = path.join(sidecarsDir, aliasName);
  fs.copyFileSync(targetPath, aliasPath);
  try {
    fs.chmodSync(aliasPath, 0o755);
  } catch {
    // Windows and some filesystems may ignore chmod.
  }
}

async function afterPack(context) {
  const triple = targetTriple(context.electronPlatformName, context.arch);
  if (!triple) return;
  enforceMacTransportSecurity(context);
  prunePackagedNativePayload(context, triple);

  const sidecarsDir = resolveSidecarsDir(context);
  if (!sidecarsDir || !fs.existsSync(sidecarsDir)) return;

  const isWindows = context.electronPlatformName === "win32";
  const executableSuffix = isWindows ? ".exe" : "";
  const keep = new Set();

  for (const base of sidecarBases) {
    const aliasName = `${base}${executableSuffix}`;
    const targetName = `${base}-${triple}${executableSuffix}`;
    copyExecutableTargetToAlias(sidecarsDir, targetName, aliasName);
    keep.add(aliasName);
    keep.add(targetName);
  }

  const versionsAlias = "versions.json";
  const versionsTarget = `versions.json-${triple}${executableSuffix}`;
  const versionsTargetPath = path.join(sidecarsDir, versionsTarget);
  if (!fs.existsSync(versionsTargetPath)) {
    throw new Error(`Missing packaged sidecar metadata for target: ${versionsTarget}`);
  }
  fs.copyFileSync(versionsTargetPath, path.join(sidecarsDir, versionsAlias));
  keep.add(versionsAlias);
  keep.add(versionsTarget);

  for (const entry of fs.readdirSync(sidecarsDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(sidecarsDir, entry), { force: true, recursive: true });
    }
  }

  // macOS writes this only after nested signing in the custom sign hook.
  if (context.electronPlatformName !== "darwin") {
    await writePackagedRuntimeIntegrity(context, triple);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.enforceMacTransportSecurity = enforceMacTransportSecurity;
module.exports.normalizeArch = normalizeArch;
module.exports.prunePackagedNativePayload = prunePackagedNativePayload;
module.exports.resolveResourcesDir = resolveResourcesDir;
module.exports.sidecarBases = sidecarBases;
module.exports.targetTriple = targetTriple;
module.exports.writePackagedRuntimeIntegrity = writePackagedRuntimeIntegrity;
