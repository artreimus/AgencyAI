import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const OPENCODE_DISTRIBUTION_FILE_NAME = "opencode-distribution.json";
export const PACKAGED_RUNTIME_INTEGRITY_FILE_NAME =
  "packaged-runtime-integrity.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const TARGET_PATTERN = /^(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, label, pattern = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new Error(`${label} has an invalid format`);
  }
  return normalized;
}

function requiredHttpsUrl(value, label, expectedHost = null) {
  const normalized = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (expectedHost && parsed.hostname !== expectedHost)
  ) {
    throw new Error(`${label} must be an approved HTTPS URL`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function requiredArtifactName(value, label) {
  const normalized = requiredString(value, label);
  if (
    normalized === "."
    || normalized === ".."
    || path.basename(normalized) !== normalized
    || normalized.includes("/")
    || normalized.includes("\\")
  ) {
    throw new Error(`${label} must be a single file name`);
  }
  return normalized;
}

function requiredArtifactRelativePath(value, label) {
  const normalized = requiredString(value, label).replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.endsWith("/")
    || normalized.split("/").some((segment) =>
      !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a normalized relative artifact path`);
  }
  return normalized;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredBooleanTrue(value, label) {
  if (value !== true) {
    throw new Error(`${label} must be true`);
  }
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateOpenCodeAsset(value, target, binaryVersion) {
  if (!isRecord(value)) {
    throw new Error(`targetAssets.${target} must be an object`);
  }
  const workflowRunId = requiredPositiveInteger(
    value.workflowRunId,
    `targetAssets.${target}.workflowRunId`,
  );
  const workflowRunUrl = requiredHttpsUrl(
    value.workflowRunUrl,
    `targetAssets.${target}.workflowRunUrl`,
    "github.com",
  );
  if (!workflowRunUrl.endsWith(`/actions/runs/${workflowRunId}`)) {
    throw new Error(`targetAssets.${target}.workflowRunUrl does not match workflowRunId`);
  }
  const artifactExpiresAt = requiredString(
    value.artifactExpiresAt,
    `targetAssets.${target}.artifactExpiresAt`,
  );
  if (Number.isNaN(Date.parse(artifactExpiresAt))) {
    throw new Error(`targetAssets.${target}.artifactExpiresAt must be an ISO date`);
  }
  const archive = requiredArtifactName(
    value.archive,
    `targetAssets.${target}.archive`,
  );
  const sourceArchiveSha256 = requiredString(
    value.sourceArchiveSha256,
    `targetAssets.${target}.sourceArchiveSha256`,
    SHA256_PATTERN,
  );
  const sourceBinarySha256 = requiredString(
    value.sourceBinarySha256,
    `targetAssets.${target}.sourceBinarySha256`,
    SHA256_PATTERN,
  );
  const provenanceSha256 = requiredString(
    value.provenanceSha256,
    `targetAssets.${target}.provenanceSha256`,
    SHA256_PATTERN,
  );
  const spdxSha256 = requiredString(
    value.spdxSha256,
    `targetAssets.${target}.spdxSha256`,
    SHA256_PATTERN,
  );
  const cycloneDxSha256 = requiredString(
    value.cycloneDxSha256,
    `targetAssets.${target}.cycloneDxSha256`,
    SHA256_PATTERN,
  );
  const buildSourceCycloneDxSha256 = requiredString(
    value.buildSourceCycloneDxSha256,
    `targetAssets.${target}.buildSourceCycloneDxSha256`,
    SHA256_PATTERN,
  );
  if (!isRecord(value.artifactFiles)) {
    throw new Error(`targetAssets.${target}.artifactFiles must be an object`);
  }
  const expectedArtifactHashes = {
    "AGENCYAI_FORK_NOTICE.md": null,
    "LICENSE-OpenCode": null,
    SHA256SUMS: null,
    "opencode-build-source.cdx.json": buildSourceCycloneDxSha256,
    "opencode-darwin-arm64.cdx.json": cycloneDxSha256,
    "opencode-darwin-arm64.spdx.json": spdxSha256,
    [archive]: sourceArchiveSha256,
    "provenance.json": provenanceSha256,
  };
  const expectedArtifactFiles = Object.keys(expectedArtifactHashes).sort();
  const receivedArtifactFiles = Object.keys(value.artifactFiles).sort();
  if (
    JSON.stringify(receivedArtifactFiles)
    !== JSON.stringify(expectedArtifactFiles)
  ) {
    throw new Error(
      `targetAssets.${target}.artifactFiles must contain the exact reviewed artifact inventory`,
    );
  }
  const artifactFiles = {};
  for (const fileName of expectedArtifactFiles) {
    const hash = requiredString(
      value.artifactFiles[fileName],
      `targetAssets.${target}.artifactFiles.${fileName}`,
      SHA256_PATTERN,
    );
    const expectedHash = expectedArtifactHashes[fileName];
    if (expectedHash && hash !== expectedHash) {
      throw new Error(
        `targetAssets.${target}.artifactFiles.${fileName} does not match its declared evidence hash`,
      );
    }
    artifactFiles[fileName] = hash;
  }
  return {
    workflowRunId,
    workflowRunUrl,
    workflowPath: requiredString(
      value.workflowPath,
      `targetAssets.${target}.workflowPath`,
    ),
    headBranch: requiredString(
      value.headBranch,
      `targetAssets.${target}.headBranch`,
    ),
    artifactId: requiredPositiveInteger(
      value.artifactId,
      `targetAssets.${target}.artifactId`,
    ),
    artifactName: requiredArtifactName(
      value.artifactName,
      `targetAssets.${target}.artifactName`,
    ),
    artifactDigestSha256: requiredString(
      value.artifactDigestSha256,
      `targetAssets.${target}.artifactDigestSha256`,
      SHA256_PATTERN,
    ),
    artifactExpiresAt,
    archive,
    sourceArchiveSha256,
    binary: requiredArtifactName(value.binary, `targetAssets.${target}.binary`),
    sourceBinarySha256,
    provenanceSha256,
    spdxSha256,
    cycloneDxSha256,
    buildSourceCycloneDxSha256,
    artifactFiles,
    version: binaryVersion,
  };
}

function validateRipgrep(value) {
  if (!isRecord(value)) throw new Error("toolchain.ripgrep must be an object");
  const version = requiredString(value.version, "toolchain.ripgrep.version", SEMVER_PATTERN);
  const sourceRepository = requiredHttpsUrl(
    value.sourceRepository,
    "toolchain.ripgrep.sourceRepository",
    "github.com",
  );
  if (!sourceRepository.endsWith("/BurntSushi/ripgrep")) {
    throw new Error("toolchain.ripgrep.sourceRepository must be the official ripgrep repository");
  }
  if (value.license !== "MIT") {
    throw new Error("toolchain.ripgrep.license must select the bundled MIT license");
  }
  if (!isRecord(value.targetAssets) || Object.keys(value.targetAssets).length === 0) {
    throw new Error("toolchain.ripgrep.targetAssets must not be empty");
  }
  const targetAssets = {};
  for (const [target, asset] of Object.entries(value.targetAssets)) {
    if (!TARGET_PATTERN.test(target) || !isRecord(asset)) {
      throw new Error(`toolchain.ripgrep.targetAssets.${target} is invalid`);
    }
    const url = requiredHttpsUrl(
      asset.url,
      `toolchain.ripgrep.targetAssets.${target}.url`,
      "github.com",
    );
    if (!url.startsWith(`${sourceRepository}/releases/download/${version}/`)) {
      throw new Error(`toolchain.ripgrep.targetAssets.${target}.url is not an official release asset`);
    }
    targetAssets[target] = {
      url,
      archive: requiredArtifactName(
        asset.archive,
        `toolchain.ripgrep.targetAssets.${target}.archive`,
      ),
      sourceArchiveSha256: requiredString(
        asset.sourceArchiveSha256,
        `toolchain.ripgrep.targetAssets.${target}.sourceArchiveSha256`,
        SHA256_PATTERN,
      ),
      binary: requiredArtifactName(
        asset.binary,
        `toolchain.ripgrep.targetAssets.${target}.binary`,
      ),
      sourceBinarySha256: requiredString(
        asset.sourceBinarySha256,
        `toolchain.ripgrep.targetAssets.${target}.sourceBinarySha256`,
        SHA256_PATTERN,
      ),
      licenseFile: requiredArtifactName(
        asset.licenseFile,
        `toolchain.ripgrep.targetAssets.${target}.licenseFile`,
      ),
      licenseSha256: requiredString(
        asset.licenseSha256,
        `toolchain.ripgrep.targetAssets.${target}.licenseSha256`,
        SHA256_PATTERN,
      ),
      version,
    };
  }
  return {
    version,
    sourceRepository,
    license: "MIT",
    targetAssets,
  };
}

export function validateOpencodeDistribution(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("OpenCode distribution schemaVersion must be 1");
  }
  const binaryVersion = requiredString(
    value.binaryVersion,
    "binaryVersion",
    SEMVER_PATTERN,
  );
  const sdkVersion = requiredString(value.sdkVersion, "sdkVersion", SEMVER_PATTERN);
  if (sdkVersion !== binaryVersion) {
    throw new Error("sdkVersion must exactly match binaryVersion");
  }
  const sourceRepository = requiredHttpsUrl(
    value.sourceRepository,
    "sourceRepository",
    "github.com",
  );
  if (!sourceRepository.endsWith("/artreimus/AgencyAI-OpenCode")) {
    throw new Error("sourceRepository must be the reviewed AgencyAI OpenCode fork");
  }
  const upstreamTag = requiredString(value.upstreamTag, "upstreamTag");
  if (upstreamTag !== `v${binaryVersion}`) {
    throw new Error("upstreamTag must exactly match binaryVersion");
  }
  if (!Array.isArray(value.patchCommits) || value.patchCommits.length === 0) {
    throw new Error("patchCommits must contain the reviewed fork patch queue");
  }
  const sdkConsumers = Array.isArray(value.sdkConsumers)
    ? value.sdkConsumers.map((entry, index) =>
        requiredString(entry, `sdkConsumers[${index}]`))
    : [];
  const expectedSdkConsumers = [
    "apps/app",
    "apps/desktop",
    "apps/orchestrator",
    "apps/server",
  ];
  if (
    sdkConsumers.length !== expectedSdkConsumers.length
    || expectedSdkConsumers.some((entry) => !sdkConsumers.includes(entry))
  ) {
    throw new Error("sdkConsumers must name all four AgencyAI SDK consumers");
  }
  if (!isRecord(value.targetAssets) || Object.keys(value.targetAssets).length === 0) {
    throw new Error("targetAssets must not be empty");
  }
  const targetAssets = {};
  for (const [target, asset] of Object.entries(value.targetAssets)) {
    if (!TARGET_PATTERN.test(target)) {
      throw new Error(`targetAssets.${target} is not a supported target triple`);
    }
    targetAssets[target] = validateOpenCodeAsset(asset, target, binaryVersion);
  }
  if (!isRecord(value.toolchain)) throw new Error("toolchain must be an object");
  if (!isRecord(value.capabilities)) throw new Error("capabilities must be an object");

  const forkCommit = requiredString(
    value.forkCommit,
    "forkCommit",
    COMMIT_PATTERN,
  );
  const patchCommits = value.patchCommits.map((entry, index) =>
    requiredString(entry, `patchCommits[${index}]`, COMMIT_PATTERN));
  if (patchCommits.at(-1) !== forkCommit) {
    throw new Error("patchCommits must end at forkCommit");
  }

  return deepFreeze({
    schemaVersion: 1,
    sourceRepository,
    upstreamTag,
    upstreamCommit: requiredString(
      value.upstreamCommit,
      "upstreamCommit",
      COMMIT_PATTERN,
    ),
    forkCommit,
    forkTag: (() => {
      const forkTag = requiredString(value.forkTag, "forkTag");
      if (forkTag !== `product-opencode-v${binaryVersion}-p2`) {
        throw new Error(
          "forkTag must select the immutable reviewed AgencyAI patchset",
        );
      }
      return forkTag;
    })(),
    patchset: requiredString(value.patchset, "patchset"),
    patchCommits,
    binaryVersion,
    sdkVersion,
    sdkConsumers,
    targetAssets,
    toolchain: {
      ripgrep: validateRipgrep(value.toolchain.ripgrep),
    },
    capabilities: {
      runtimeDownloadsDenied: requiredBooleanTrue(
        value.capabilities.runtimeDownloadsDenied,
        "capabilities.runtimeDownloadsDenied",
      ),
      remoteConfigDenied: requiredBooleanTrue(
        value.capabilities.remoteConfigDenied,
        "capabilities.remoteConfigDenied",
      ),
    },
  });
}

export function currentTargetTriple({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

export function opencodeDistributionManifestPaths({
  desktopRoot,
  resourcesPath = process.resourcesPath,
  isPackaged = false,
}) {
  const repositoryPath = path.resolve(
    desktopRoot,
    "..",
    "..",
    OPENCODE_DISTRIBUTION_FILE_NAME,
  );
  const packagedPath = resourcesPath
    ? path.resolve(resourcesPath, OPENCODE_DISTRIBUTION_FILE_NAME)
    : null;
  return isPackaged
    ? [packagedPath].filter(Boolean)
    : [repositoryPath, packagedPath].filter(Boolean);
}

export function loadOpencodeDistributionSync(options) {
  const explicitPath = options?.manifestPath
    ? path.resolve(options.manifestPath)
    : null;
  const candidates = explicitPath
    ? [explicitPath]
    : opencodeDistributionManifestPaths(options);
  const manifestPath = candidates.find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    throw new Error(
      `Verified OpenCode distribution manifest not found. Checked: ${candidates.join(", ")}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read OpenCode distribution manifest at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    path: manifestPath,
    manifest: validateOpencodeDistribution(parsed),
  };
}

export function distributionTarget(manifest, target = currentTargetTriple()) {
  if (!target) throw new Error("Unsupported runtime platform for OpenCode distribution");
  const opencode = manifest.targetAssets[target];
  const ripgrep = manifest.toolchain.ripgrep.targetAssets[target];
  if (!opencode || !ripgrep) {
    throw new Error(`OpenCode distribution does not support ${target}`);
  }
  return { target, opencode, ripgrep };
}

function assertRegularFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing`);
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
}

export function sha256FileSync(filePath) {
  assertRegularFile(filePath, filePath);
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function packagedRuntimeIntegrityRelativePaths(target) {
  if (!TARGET_PATTERN.test(target)) {
    throw new Error(`Unsupported packaged runtime target: ${target}`);
  }
  const executableSuffix = target.endsWith("windows-msvc") ? ".exe" : "";
  return Object.freeze([
    `sidecars/opencode${executableSuffix}`,
    `sidecars/opencode-${target}${executableSuffix}`,
    `toolchain/${target}/${executableSuffix ? "rg.exe" : "rg"}`,
    `toolchain/${target}/LICENSE-ripgrep`,
  ]);
}

export function validatePackagedRuntimeIntegrity(value, target) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Packaged runtime integrity schemaVersion must be 1");
  }
  if (value.hashPhase !== "post-nested-signing") {
    throw new Error(
      "Packaged runtime integrity hashPhase must be post-nested-signing",
    );
  }
  const manifestTarget = requiredString(value.target, "target");
  if (manifestTarget !== target) {
    throw new Error(
      `Packaged runtime integrity target mismatch: expected ${target}, received ${manifestTarget}`,
    );
  }
  const distributionManifestSha256 = requiredString(
    value.distributionManifestSha256,
    "distributionManifestSha256",
    SHA256_PATTERN,
  );
  if (!Array.isArray(value.files)) {
    throw new Error("Packaged runtime integrity files must be an array");
  }
  const files = value.files.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Packaged runtime integrity files[${index}] must be an object`);
    }
    return Object.freeze({
      path: requiredArtifactRelativePath(
        entry.path,
        `Packaged runtime integrity files[${index}].path`,
      ),
      sha256: requiredString(
        entry.sha256,
        `Packaged runtime integrity files[${index}].sha256`,
        SHA256_PATTERN,
      ),
    });
  });
  const expectedPaths = packagedRuntimeIntegrityRelativePaths(target);
  const receivedPaths = files.map((entry) => entry.path);
  if (
    receivedPaths.length !== expectedPaths.length
    || new Set(receivedPaths).size !== receivedPaths.length
    || expectedPaths.some((expectedPath, index) =>
      receivedPaths[index] !== expectedPath)
  ) {
    throw new Error(
      `Packaged runtime integrity files must exactly match: ${expectedPaths.join(", ")}`,
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    hashPhase: "post-nested-signing",
    target,
    distributionManifestSha256,
    files,
  });
}

export function assertRegularFileWithinRootSync(
  filePath,
  rootPath,
  label,
) {
  const absoluteRoot = path.resolve(rootPath);
  const absoluteFile = path.resolve(filePath);
  const relativePath = path.relative(absoluteRoot, absoluteFile);
  if (
    !relativePath
    || relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be a descendant of packaged resources`);
  }
  const rootStats = lstatSync(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Packaged resources root must be a non-symlink directory");
  }
  let currentPath = absoluteRoot;
  const segments = relativePath.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not traverse symbolic links`);
    }
    const leaf = index === segments.length - 1;
    if (leaf ? !stats.isFile() : !stats.isDirectory()) {
      throw new Error(
        `${label} must traverse directories to a regular file`,
      );
    }
  }
  const resolvedRoot = realpathSync(absoluteRoot);
  const resolvedFile = realpathSync(absoluteFile);
  if (
    resolvedFile !== resolvedRoot
    && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`${label} resolves outside packaged resources`);
  }
}

export function loadPackagedRuntimeIntegritySync({
  resourcesPath,
  target = currentTargetTriple(),
  distributionManifestPath = null,
}) {
  if (!resourcesPath || !target) {
    throw new Error("Packaged runtime integrity requires resourcesPath and target");
  }
  const resourcesRoot = path.resolve(resourcesPath);
  const integrityPath = path.join(
    resourcesRoot,
    PACKAGED_RUNTIME_INTEGRITY_FILE_NAME,
  );
  const resolvedDistributionPath = distributionManifestPath
    ? path.resolve(distributionManifestPath)
    : path.join(resourcesRoot, OPENCODE_DISTRIBUTION_FILE_NAME);
  assertRegularFileWithinRootSync(
    integrityPath,
    resourcesRoot,
    "Packaged runtime integrity manifest",
  );
  assertRegularFileWithinRootSync(
    resolvedDistributionPath,
    resourcesRoot,
    "Packaged OpenCode distribution manifest",
  );

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(integrityPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read packaged runtime integrity at ${integrityPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const integrity = validatePackagedRuntimeIntegrity(parsed, target);
  const distributionManifestSha256 = sha256FileSync(resolvedDistributionPath);
  if (distributionManifestSha256 !== integrity.distributionManifestSha256) {
    throw new Error(
      "Packaged OpenCode distribution manifest does not match packaged runtime integrity",
    );
  }

  const hashesByAbsolutePath = {};
  for (const entry of integrity.files) {
    const filePath = path.resolve(resourcesRoot, ...entry.path.split("/"));
    assertRegularFileWithinRootSync(
      filePath,
      resourcesRoot,
      `Packaged runtime file ${entry.path}`,
    );
    const actualSha256 = sha256FileSync(filePath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(
        `Packaged runtime hash mismatch for ${entry.path}: expected ${entry.sha256}, received ${actualSha256}`,
      );
    }
    hashesByAbsolutePath[filePath] = actualSha256;
  }

  return deepFreeze({
    path: integrityPath,
    manifest: integrity,
    hashesByAbsolutePath,
  });
}

function verifyVersionCommand({
  filePath,
  expectedVersion,
  args,
  parseVersion,
  spawnSyncImpl = spawnSync,
  label,
}) {
  const result = spawnSyncImpl(filePath, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} version probe failed`);
  }
  const actualVersion = parseVersion(String(result.stdout ?? "").trim());
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${label} version mismatch: expected ${expectedVersion}, received ${actualVersion || "unknown"}`,
    );
  }
  return actualVersion;
}

export function verifyOpencodeBinarySync(
  filePath,
  asset,
  {
    spawnSyncImpl = spawnSync,
    expectedSha256 = asset.sourceBinarySha256,
  } = {},
) {
  assertRegularFile(filePath, "Bundled OpenCode binary");
  const binarySha256 = sha256FileSync(filePath);
  if (binarySha256 !== expectedSha256) {
    throw new Error(
      `Bundled OpenCode hash mismatch: expected ${expectedSha256}, received ${binarySha256}`,
    );
  }
  const version = verifyVersionCommand({
    filePath,
    expectedVersion: asset.version,
    args: ["--version"],
    parseVersion: (value) => value.replace(/^v/, ""),
    spawnSyncImpl,
    label: "Bundled OpenCode",
  });
  return Object.freeze({
    path: filePath,
    source: "bundled-patched",
    version,
    binarySha256,
  });
}

export function verifyRipgrepBinarySync(
  filePath,
  asset,
  {
    spawnSyncImpl = spawnSync,
    expectedSha256 = asset.sourceBinarySha256,
  } = {},
) {
  assertRegularFile(filePath, "Bundled ripgrep binary");
  const binarySha256 = sha256FileSync(filePath);
  if (binarySha256 !== expectedSha256) {
    throw new Error(
      `Bundled ripgrep hash mismatch: expected ${expectedSha256}, received ${binarySha256}`,
    );
  }
  const version = verifyVersionCommand({
    filePath,
    expectedVersion: asset.version,
    args: ["--version"],
    parseVersion: (value) =>
      value.match(/^ripgrep\s+(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? "",
    spawnSyncImpl,
    label: "Bundled ripgrep",
  });
  return Object.freeze({ path: filePath, version, binarySha256 });
}

export function resolveVerifiedBundledOpencodeSync({
  sidecarDirs,
  asset,
  target,
  packagedIntegrity = null,
  spawnSyncImpl = spawnSync,
}) {
  const suffix = target.endsWith("windows-msvc") ? ".exe" : "";
  const fileNames = [`opencode-${target}${suffix}`, `opencode${suffix}`];
  for (const directory of sidecarDirs) {
    for (const fileName of fileNames) {
      const candidate = path.resolve(directory, fileName);
      if (!existsSync(candidate)) continue;
      const packagedSha256 =
        packagedIntegrity?.hashesByAbsolutePath?.[candidate];
      if (packagedIntegrity && !packagedSha256) {
        throw new Error(
          `Packaged OpenCode candidate is absent from runtime integrity: ${candidate}`,
        );
      }
      const expectedSha256 = packagedSha256 ?? asset.sourceBinarySha256;
      return verifyOpencodeBinarySync(candidate, asset, {
        spawnSyncImpl,
        expectedSha256,
      });
    }
  }
  throw new Error(`Verified bundled OpenCode binary is missing for ${target}`);
}

export function resolveVerifiedRipgrepSync({
  toolchainDirs,
  asset,
  packagedIntegrity = null,
  spawnSyncImpl = spawnSync,
}) {
  const fileName = process.platform === "win32" ? "rg.exe" : "rg";
  for (const directory of toolchainDirs) {
    const candidate = path.resolve(directory, fileName);
    if (!existsSync(candidate)) continue;
    const packagedSha256 =
      packagedIntegrity?.hashesByAbsolutePath?.[candidate];
    if (packagedIntegrity && !packagedSha256) {
      throw new Error(
        `Packaged ripgrep candidate is absent from runtime integrity: ${candidate}`,
      );
    }
    const expectedSha256 = packagedSha256 ?? asset.sourceBinarySha256;
    return verifyRipgrepBinarySync(candidate, asset, {
      spawnSyncImpl,
      expectedSha256,
    });
  }
  throw new Error("Verified bundled ripgrep binary is missing");
}

export function opencodeReadinessProvenance(
  manifest,
  asset,
  packagedBinarySha256 = null,
) {
  return Object.freeze({
    source: "bundled-patched",
    binarySha256: packagedBinarySha256 ?? asset.sourceBinarySha256,
    sourceBinarySha256: asset.sourceBinarySha256,
    upstreamCommit: manifest.upstreamCommit,
    forkCommit: manifest.forkCommit,
    forkTag: manifest.forkTag,
    patchset: manifest.patchset,
  });
}
