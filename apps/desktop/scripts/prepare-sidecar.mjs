import { spawnSync } from "child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  currentTargetTriple,
  distributionTarget,
  loadOpencodeDistributionSync,
  sha256FileSync,
  verifyOpencodeBinarySync,
  verifyRipgrepBinarySync,
} from "../electron/opencode-distribution.mjs";
import {
  assertExtractedTreeSafeSync,
  preflightSidecarArchiveSync,
} from "./archive-policy.mjs";
import {
  verifyOpenCodeWorkflowArtifactEvidenceSync,
} from "./opencode-artifact-evidence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.OPENWORK_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "resources", "sidecars");
const desktopRoot = resolve(__dirname, "..");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");
const distribution = loadOpencodeDistributionSync({
  desktopRoot,
  isPackaged: false,
}).manifest;
const opencodeVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.opencodeVersion === "string" ? parsed.opencodeVersion.trim() || null : null;
  } catch {
    return null;
  }
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  return currentTargetTriple();
})();
const targetDistribution = distributionTarget(distribution, resolvedTargetTriple);
const isWindowsTarget = process.platform === "win32" || resolvedTargetTriple?.includes("windows") === true;

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    // Windows baseline artifacts intermittently fail to extract in CI
    // with Bun 1.3.6. Use the stable x64 target here for now.
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64";
    case "aarch64-pc-windows-msvc":
      return "bun-windows-arm64";
    default:
      return null;
  }
})();

const opencodeBaseName = isWindowsTarget ? "opencode.exe" : "opencode";
const opencodePath = join(sidecarDir, opencodeBaseName);
const opencodeTargetName = resolvedTargetTriple
  ? `opencode-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const opencodeTargetPath = opencodeTargetName ? join(sidecarDir, opencodeTargetName) : null;

const opencodeCandidatePath = opencodeTargetPath ?? opencodePath;

// openwork-server paths
const openworkServerBaseName = "openwork-server";
const openworkServerName = isWindowsTarget ? `${openworkServerBaseName}.exe` : openworkServerBaseName;
const openworkServerPath = join(sidecarDir, openworkServerName);
const openworkServerBuildName = bunTarget
  ? `${openworkServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : openworkServerName;
const openworkServerBuildPath = join(sidecarDir, openworkServerBuildName);
const openworkServerTargetTriple = resolvedTargetTriple;
const openworkServerTargetName = openworkServerTargetTriple
  ? `${openworkServerBaseName}-${openworkServerTargetTriple}${openworkServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const openworkServerTargetPath = openworkServerTargetName ? join(sidecarDir, openworkServerTargetName) : null;

const openworkServerDir = resolve(__dirname, "..", "..", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

// orchestrator paths
const orchestratorBaseName = "openwork-orchestrator";
const orchestratorName =
  isWindowsTarget ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "orchestrator");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const findOpencodeBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${opencodeBaseName}`) || file.endsWith(`\\${opencodeBaseName}`)) ??
    candidates.find((file) => file.endsWith("/opencode.exe") || file.endsWith("\\opencode.exe")) ??
    candidates.find((file) => file.endsWith("/opencode") || file.endsWith("\\opencode")) ??
    null
  );
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath)) return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error("codesign is required to prepare runnable macOS sidecars");
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(`Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`);
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

// openwork-server is no longer compiled as a sidecar binary — it runs
// in-process inside Electron via a direct import of the server library.
const didBuildOpenworkServer = false;

// Server binary copy/sign skipped — runs in-process.

const normalizedOpencodeVersion = normalizeVersion(opencodeVersion);

if (!normalizedOpencodeVersion) {
  console.error(
    `OpenCode version could not be resolved from ${constantsPath}.`
  );
  process.exit(1);
}

if (normalizedOpencodeVersion !== distribution.binaryVersion) {
  console.error(
    `constants.json OpenCode ${normalizedOpencodeVersion} does not match distribution ${distribution.binaryVersion}.`,
  );
  process.exit(1);
}

for (const name of [
  "OPENCODE_ASSET",
  "OPENCODE_GITHUB_REPO",
  "OPENWORK_OPENCODE_GITHUB_REPO",
]) {
  if (process.env[name]?.trim()) {
    console.error(
      `${name} is disabled. AgencyAI resolves OpenCode only from opencode-distribution.json.`,
    );
    process.exit(1);
  }
}

const productionPackaging = process.env.OPENWORK_RELEASE_BUILD === "1";
const releaseInputsDirectory =
  process.env.AGENCYAI_RELEASE_INPUTS_DIR?.trim() || null;
const verifiedOpenCodeEvidenceDirectory = resolvedTargetTriple
  ? resolve(
      desktopRoot,
      "resources",
      "opencode-evidence",
      resolvedTargetTriple,
    )
  : null;
const taskTempRoot = mkdtempSync(join(tmpdir(), "agencyai-sidecar-"));
process.once("exit", () => {
  rmSync(taskTempRoot, { recursive: true, force: true });
});

const runChecked = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? -1}`,
    );
  }
  return result;
};

const readGithubJson = (endpoint, label) => {
  const result = runChecked("gh", ["api", endpoint], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not return valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const assertExpectedHash = (filePath, expected, label) => {
  const actual = sha256FileSync(filePath);
  if (actual !== expected) {
    throw new Error(
      `${label} hash mismatch: expected ${expected}, received ${actual}`,
    );
  }
  return actual;
};

const stageManifestOpenCodeEvidence = (asset, sourceDirectory) => {
  if (!releaseInputsDirectory) {
    throw new Error(
      "AGENCYAI_RELEASE_INPUTS_DIR is required to stage OpenCode evidence",
    );
  }
  if (!sourceDirectory || !existsSync(sourceDirectory)) {
    throw new Error(
      `Missing reviewed OpenCode evidence snapshot for ${resolvedTargetTriple}`,
    );
  }
  const packagedEvidence = Object.keys(asset.artifactFiles)
    .filter((fileName) => fileName !== asset.archive)
    .sort((left, right) => left.localeCompare(right));
  const entries = readdirSync(sourceDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    entries.some((entry) => !entry.isFile())
    || JSON.stringify(entries.map((entry) => entry.name))
      !== JSON.stringify(packagedEvidence)
  ) {
    throw new Error(
      `Reviewed OpenCode evidence closure mismatch: ${entries
        .map((entry) => entry.name)
        .join(", ")}`,
    );
  }

  const evidenceDirectory = resolve(
    releaseInputsDirectory,
    "opencode",
    resolvedTargetTriple,
  );
  rmSync(evidenceDirectory, { recursive: true, force: true });
  mkdirSync(evidenceDirectory, { recursive: true });
  for (const fileName of packagedEvidence) {
    const sourcePath = join(sourceDirectory, fileName);
    assertExpectedHash(
      sourcePath,
      asset.artifactFiles[fileName],
      `OpenCode evidence ${fileName}`,
    );
    copyFileSync(sourcePath, join(evidenceDirectory, fileName));
  }
  writeFileSync(
    join(evidenceDirectory, "evidence-inventory.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        target: resolvedTargetTriple,
        excludedArchive: {
          file: asset.archive,
          sha256: asset.artifactFiles[asset.archive],
        },
        files: Object.fromEntries(
          packagedEvidence.map((fileName) => [
            fileName,
            asset.artifactFiles[fileName],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const resolveLocalArchiveOverride = (name) => {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (productionPackaging) {
    throw new Error(`${name} is forbidden for production packaging`);
  }
  const filePath = resolve(value);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`${name} does not point to a regular file`);
  }
  return filePath;
};

const extractArchive = (archivePath, extractDir) => {
  preflightSidecarArchiveSync(archivePath);
  mkdirSync(extractDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
      runChecked("powershell", [
        "-NoProfile",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
        ].join("; "),
      ]);
      assertExtractedTreeSafeSync(extractDir);
      return;
    }
    runChecked("unzip", ["-q", archivePath, "-d", extractDir]);
    assertExtractedTreeSafeSync(extractDir);
    return;
  }
  if (archivePath.endsWith(".tar.gz")) {
    runChecked("tar", ["-xzf", archivePath, "-C", extractDir]);
    assertExtractedTreeSafeSync(extractDir);
    return;
  }
  throw new Error(`Unsupported verified archive type: ${archivePath}`);
};

const downloadUrl = (url, destination) => {
  if (process.platform === "win32") {
    const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
    runChecked("powershell", [
      "-NoProfile",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        `Invoke-WebRequest -Uri ${psQuote(url)} -OutFile ${psQuote(destination)}`,
      ].join("; "),
    ]);
    return;
  }
  runChecked("curl", ["-fsSL", "-o", destination, url]);
};

const downloadManifestOpenCodeArchive = (asset) => {
  if (Date.now() >= Date.parse(asset.artifactExpiresAt)) {
    throw new Error(
      `The manifest-pinned private OpenCode workflow artifact expired at ${asset.artifactExpiresAt}. Rebuild and review PR04 provenance before packaging.`,
    );
  }
  const repository = new URL(distribution.sourceRepository).pathname
    .replace(/^\/+/, "");
  const artifactMetadata = readGithubJson(
    `repos/${repository}/actions/artifacts/${asset.artifactId}`,
    "GitHub OpenCode artifact metadata",
  );
  const workflowRunMetadata = readGithubJson(
    `repos/${repository}/actions/runs/${asset.workflowRunId}`,
    "GitHub OpenCode workflow run metadata",
  );
  const downloadDir = join(taskTempRoot, "opencode-workflow-artifact");
  mkdirSync(downloadDir, { recursive: true });
  runChecked("gh", [
    "run",
    "download",
    String(asset.workflowRunId),
    "--repo",
    repository,
    "--name",
    asset.artifactName,
    "--dir",
    downloadDir,
  ]);
  verifyOpenCodeWorkflowArtifactEvidenceSync({
    artifactDirectory: downloadDir,
    distribution,
    target: resolvedTargetTriple,
    artifactMetadata,
    workflowRunMetadata,
  });
  const archivePath = join(downloadDir, asset.archive);
  if (!existsSync(archivePath)) {
    throw new Error(
      `Workflow artifact ${asset.artifactName} did not contain ${asset.archive}`,
    );
  }
  return archivePath;
};

const copyExecutable = (source, targets) => {
  for (const target of [...new Set(targets.filter(Boolean))]) {
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) unlinkSync(target);
    copyFileSync(source, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // Some Windows filesystems ignore chmod.
    }
  }
};

const opencodeAsset = targetDistribution.opencode;
const verifiedBinaryPath =
  process.env.AGENCYAI_VERIFIED_OPENCODE_BINARY_PATH?.trim() || null;
if (verifiedBinaryPath) {
  const resolvedBinaryPath = resolve(verifiedBinaryPath);
  if (!existsSync(resolvedBinaryPath) || !statSync(resolvedBinaryPath).isFile()) {
    throw new Error(
      "AGENCYAI_VERIFIED_OPENCODE_BINARY_PATH does not point to a regular file",
    );
  }
  verifyOpencodeBinarySync(resolvedBinaryPath, opencodeAsset);
  copyExecutable(resolvedBinaryPath, [opencodeTargetPath, opencodePath]);
}
let verifiedWorkflowArchive = null;
let verifiedExistingOpenCode = false;
if (opencodeCandidatePath && existsSync(opencodeCandidatePath)) {
  try {
    verifyOpencodeBinarySync(opencodeCandidatePath, opencodeAsset);
    verifiedExistingOpenCode = true;
  } catch {
    verifiedExistingOpenCode = false;
  }
}

if (productionPackaging) {
  if (!releaseInputsDirectory) {
    throw new Error(
      "AGENCYAI_RELEASE_INPUTS_DIR is required for production packaging",
    );
  }
  stageManifestOpenCodeEvidence(
    opencodeAsset,
    verifiedOpenCodeEvidenceDirectory,
  );
  if (!verifiedExistingOpenCode) {
    verifiedWorkflowArchive = downloadManifestOpenCodeArchive(opencodeAsset);
  }
}

if (!verifiedExistingOpenCode) {
  const archivePath =
    resolveLocalArchiveOverride("AGENCYAI_OPENCODE_ARCHIVE_PATH")
    ?? verifiedWorkflowArchive
    ?? downloadManifestOpenCodeArchive(opencodeAsset);
  assertExpectedHash(
    archivePath,
    opencodeAsset.sourceArchiveSha256,
    "OpenCode archive",
  );
  const extractDir = join(taskTempRoot, "opencode-extracted");
  extractArchive(archivePath, extractDir);
  const extractedBinary = findOpencodeBinary(extractDir);
  if (!extractedBinary) {
    throw new Error("Verified OpenCode archive did not contain an OpenCode binary");
  }
  verifyOpencodeBinarySync(extractedBinary, opencodeAsset);
  copyExecutable(extractedBinary, [opencodeTargetPath, opencodePath]);
}

for (const target of [opencodeTargetPath, opencodePath].filter(Boolean)) {
  verifyOpencodeBinarySync(target, opencodeAsset);
}
console.log(`Verified OpenCode ${normalizedOpencodeVersion} from ${distribution.forkCommit}.`);

const ripgrepAsset = targetDistribution.ripgrep;
const toolchainDir = join(
  desktopRoot,
  "resources",
  "toolchain",
  resolvedTargetTriple,
);
const ripgrepPath = join(
  toolchainDir,
  isWindowsTarget ? "rg.exe" : "rg",
);
const ripgrepLicensePath = join(toolchainDir, "LICENSE-ripgrep");
let verifiedExistingRipgrep = false;
if (existsSync(ripgrepPath) && existsSync(ripgrepLicensePath)) {
  try {
    verifyRipgrepBinarySync(ripgrepPath, ripgrepAsset);
    assertExpectedHash(
      ripgrepLicensePath,
      ripgrepAsset.licenseSha256,
      "ripgrep MIT license",
    );
    verifiedExistingRipgrep = true;
  } catch {
    verifiedExistingRipgrep = false;
  }
}

if (!verifiedExistingRipgrep) {
  const override = resolveLocalArchiveOverride("AGENCYAI_RIPGREP_ARCHIVE_PATH");
  const archivePath = override ?? join(taskTempRoot, ripgrepAsset.archive);
  if (!override) downloadUrl(ripgrepAsset.url, archivePath);
  assertExpectedHash(
    archivePath,
    ripgrepAsset.sourceArchiveSha256,
    "ripgrep archive",
  );
  const extractDir = join(taskTempRoot, "ripgrep-extracted");
  extractArchive(archivePath, extractDir);
  const extractedBinary = readDirectory(extractDir).find(
    (filePath) =>
      filePath.endsWith(`/${ripgrepAsset.binary}`)
      || filePath.endsWith(`\\${ripgrepAsset.binary}`),
  );
  if (!extractedBinary) {
    throw new Error("Verified ripgrep archive did not contain rg");
  }
  const extractedLicense = readDirectory(extractDir).find(
    (filePath) =>
      filePath.endsWith(`/${ripgrepAsset.licenseFile}`)
      || filePath.endsWith(`\\${ripgrepAsset.licenseFile}`),
  );
  if (!extractedLicense) {
    throw new Error(
      `Verified ripgrep archive did not contain ${ripgrepAsset.licenseFile}`,
    );
  }
  verifyRipgrepBinarySync(extractedBinary, ripgrepAsset);
  assertExpectedHash(
    extractedLicense,
    ripgrepAsset.licenseSha256,
    "ripgrep MIT license",
  );
  copyExecutable(extractedBinary, [ripgrepPath]);
  mkdirSync(toolchainDir, { recursive: true });
  if (existsSync(ripgrepLicensePath)) unlinkSync(ripgrepLicensePath);
  copyFileSync(extractedLicense, ripgrepLicensePath);
}
verifyRipgrepBinarySync(ripgrepPath, ripgrepAsset);
assertExpectedHash(
  ripgrepLicensePath,
  ripgrepAsset.licenseSha256,
  "ripgrep MIT license",
);
console.log(`Verified packaged ripgrep ${ripgrepAsset.version}.`);

// Build orchestrator sidecar
let didBuildOrchestrator = false;
const shouldBuildOrchestrator =
  forceBuild || !existsSync(orchestratorBuildPath) || isStubBinary(orchestratorBuildPath);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  const orchestratorArgs = [
    orchestratorBuildScript,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
      ...(releaseInputsDirectory
        ? { AGENCYAI_RELEASE_INPUTS_DIR: releaseInputsDirectory }
        : {}),
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical =
    didBuildOrchestrator || !existsSync(orchestratorPath) || isStubBinary(orchestratorPath);
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    try {
      if (existsSync(orchestratorPath)) unlinkSync(orchestratorPath);
    } catch {
      // ignore
    }
    copyFileSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget =
      didBuildOrchestrator ||
      !existsSync(orchestratorTargetPath) ||
      isStubBinary(orchestratorTargetPath);
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      try {
        if (existsSync(orchestratorTargetPath)) unlinkSync(orchestratorTargetPath);
      } catch {
        // ignore
      }
      copyFileSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

adHocSignDarwinSidecars([
  // openwork-server runs in-process — no binary to sign.
  orchestratorBuildPath,
  orchestratorPath,
  orchestratorTargetPath,
]);

const openworkServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(openworkServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  opencode: {
    version: normalizedOpencodeVersion,
    sha256: opencodeCandidatePath && existsSync(opencodeCandidatePath)
      ? sha256FileSync(opencodeCandidatePath)
      : null,
    source: "bundled-patched",
    upstreamCommit: distribution.upstreamCommit,
    forkCommit: distribution.forkCommit,
    patchset: distribution.patchset,
  },
  "openwork-server": {
    version: openworkServerVersion,
    sha256: "in-process",
  },
  "openwork-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath)
      ? sha256FileSync(orchestratorPath)
      : null,
  },
  ripgrep: {
    version: ripgrepAsset.version,
    sha256: existsSync(ripgrepPath) ? sha256FileSync(ripgrepPath) : null,
    source: ripgrepAsset.url,
    license: distribution.toolchain.ripgrep.license,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = isWindowsTarget ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
