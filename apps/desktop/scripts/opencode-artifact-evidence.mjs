import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const BUILD_COMMAND =
  "bun packages/opencode/script/build.ts --single --skip-embed-web-ui --skip-install";
const BUILD_OUTPUT =
  "packages/opencode/dist/opencode-darwin-arm64/bin/opencode";
const SOURCE_DATE_EPOCH = 315532800;
const MODELS_DEV_SOURCE = "https://github.com/anomalyco/models.dev";
const MODELS_DEV_BUILD_COMMAND = "bun run --cwd packages/web build";
const MODELS_DEV_SOURCE_PATH = "packages/web/dist/_api.json";
const MODELS_DEV_SNAPSHOT_FILE = ".github/agencyai/models-dev-api.json";
const MODELS_DEV_METADATA_FILE = ".github/agencyai/models-dev-snapshot.json";

export const OPENCODE_ARTIFACT_FILES = Object.freeze([
  "AGENCYAI_FORK_NOTICE.md",
  "LICENSE-OpenCode",
  "SHA256SUMS",
  "opencode-build-source.cdx.json",
  "opencode-darwin-arm64.cdx.json",
  "opencode-darwin-arm64.spdx.json",
  "opencode-darwin-arm64.zip",
  "provenance.json",
].sort());

export const OPENCODE_BUILD_ENVIRONMENT = Object.freeze({
  OPENCODE_CHANNEL: "latest",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_ENABLE_OPENAI_OAUTH: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_REMOTE_CONFIG: "1",
  OPENCODE_DISABLE_REMOTE_INSTRUCTIONS: "1",
  OPENCODE_DISABLE_REMOTE_SKILLS: "1",
  OPENCODE_DISABLE_RUNTIME_DOWNLOADS: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_ENABLE_EXA: "0",
  OPENCODE_TRUSTED_PLUGIN_PATHS: "[]",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value, label) {
  invariant(isRecord(value), `${label} must be an object`);
  return value;
}

function assertString(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

function assertSha256(value, label) {
  invariant(SHA256_PATTERN.test(value), `${label} must be a lowercase SHA-256`);
  return value;
}

function assertCommit(value, label) {
  invariant(COMMIT_PATTERN.test(value), `${label} must be a full lowercase Git commit`);
  return value;
}

function sorted(values) {
  return [...values].sort();
}

function assertExactStrings(actual, expected, label) {
  invariant(
    Array.isArray(actual)
      && JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must match the reviewed values exactly`,
  );
}

function normalizedTimestamp(value, label) {
  assertString(value, label);
  const timestamp = Date.parse(value);
  invariant(Number.isFinite(timestamp), `${label} must be an ISO timestamp`);
  return timestamp;
}

function githubRepository(sourceRepository) {
  let parsed;
  try {
    parsed = new URL(sourceRepository);
  } catch {
    throw new Error("sourceRepository must be an absolute GitHub URL");
  }
  invariant(
    parsed.protocol === "https:"
      && parsed.hostname === "github.com"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash,
    "sourceRepository must be an approved GitHub URL",
  );
  const repository = parsed.pathname.replace(/^\/+|\/+$/g, "");
  invariant(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "sourceRepository must identify one GitHub repository",
  );
  return repository;
}

function expectedArtifactFiles(asset) {
  const archive = assertString(asset.archive, "OpenCode asset archive");
  invariant(path.basename(archive) === archive, "OpenCode asset archive must be a top-level file name");
  return sorted(
    OPENCODE_ARTIFACT_FILES.map((file) =>
      file === "opencode-darwin-arm64.zip" ? archive : file),
  );
}

function verifyDeclaredEvidenceHashes(asset) {
  const evidence = {
    [asset.archive]: asset.sourceArchiveSha256,
    "provenance.json": asset.provenanceSha256,
    "opencode-darwin-arm64.spdx.json": asset.spdxSha256,
    "opencode-darwin-arm64.cdx.json": asset.cycloneDxSha256,
    "opencode-build-source.cdx.json": asset.buildSourceCycloneDxSha256,
  };
  for (const [file, declaredHash] of Object.entries(evidence)) {
    assertSha256(declaredHash, `OpenCode ${file} evidence hash`);
    invariant(
      asset.artifactFiles[file] === declaredHash,
      `OpenCode ${file} evidence hash does not match artifactFiles`,
    );
  }
}

export function sha256FileSync(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readJsonSync(filePath, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return assertRecord(value, label);
}

function verifyTopLevelInventory(artifactDirectory, asset) {
  const directoryStat = lstatSync(artifactDirectory);
  invariant(
    !directoryStat.isSymbolicLink(),
    "Downloaded artifact directory cannot be a symbolic link",
  );
  invariant(
    directoryStat.isDirectory(),
    "Downloaded artifact path must be a directory",
  );
  const expected = expectedArtifactFiles(asset);
  const declared = sorted(Object.keys(assertRecord(asset.artifactFiles, "artifactFiles")));
  assertExactStrings(declared, expected, "Manifest artifact inventory");
  verifyDeclaredEvidenceHashes(asset);

  const actual = sorted(readdirSync(artifactDirectory));
  assertExactStrings(actual, expected, "Downloaded artifact inventory");

  const realArtifactDirectory = realpathSync(artifactDirectory);
  for (const file of actual) {
    invariant(
      path.basename(file) === file && file !== "." && file !== ".."
        && !file.includes("/") && !file.includes("\\"),
      `Artifact entry is not a safe top-level path: ${file}`,
    );
    const filePath = path.join(artifactDirectory, file);
    const stat = lstatSync(filePath);
    invariant(!stat.isSymbolicLink(), `Artifact entry cannot be a symbolic link: ${file}`);
    invariant(stat.isFile(), `Artifact entry must be a regular file: ${file}`);
    invariant(
      path.dirname(realpathSync(filePath)) === realArtifactDirectory,
      `Artifact entry escaped its reviewed directory: ${file}`,
    );
    const expectedHash = assertSha256(
      asset.artifactFiles[file],
      `artifactFiles.${file}`,
    );
    const actualHash = sha256FileSync(filePath);
    invariant(
      actualHash === expectedHash,
      `Artifact SHA-256 mismatch for ${file}: expected ${expectedHash}, got ${actualHash}`,
    );
  }
  return expected;
}

export function parseOpenCodeSha256SumsSync(artifactDirectory, expectedFiles) {
  const checksumPath = path.join(artifactDirectory, "SHA256SUMS");
  const body = readFileSync(checksumPath, "utf8");
  invariant(body.endsWith("\n"), "SHA256SUMS must end with a newline");
  invariant(!body.includes("\r"), "SHA256SUMS must use LF line endings");

  const entries = new Map();
  for (const line of body.slice(0, -1).split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  ([^/\\]+)$/);
    invariant(match, `Invalid relative SHA256SUMS entry: ${line}`);
    const [, hash, file] = match;
    invariant(
      path.basename(file) === file && file !== "." && file !== "..",
      `Invalid relative SHA256SUMS path: ${file}`,
    );
    invariant(!entries.has(file), `Duplicate SHA256SUMS entry: ${file}`);
    entries.set(file, hash);
  }

  const expectedCoverage = sorted(expectedFiles.filter((file) => file !== "SHA256SUMS"));
  assertExactStrings(sorted(entries.keys()), expectedCoverage, "SHA256SUMS coverage");
  return entries;
}

function verifyChecksums(artifactDirectory, expectedFiles, asset) {
  const entries = parseOpenCodeSha256SumsSync(artifactDirectory, expectedFiles);
  for (const [file, expectedHash] of entries) {
    invariant(
      expectedHash === asset.artifactFiles[file],
      `SHA256SUMS disagrees with the manifest for ${file}`,
    );
    invariant(
      expectedHash === sha256FileSync(path.join(artifactDirectory, file)),
      `SHA256SUMS verification failed for ${file}`,
    );
  }
}

function normalizedWorkflowPath(value) {
  const workflowPath = assertString(value, "GitHub workflow path").split("@", 1)[0];
  invariant(
    workflowPath.startsWith(".github/workflows/")
      && !workflowPath.includes("..")
      && !workflowPath.includes("\\"),
    "GitHub workflow path is unsafe",
  );
  return workflowPath;
}

function verifyGithubMetadata({
  distribution,
  asset,
  artifactMetadata,
  workflowRunMetadata,
  now,
}) {
  assertRecord(artifactMetadata, "GitHub artifact metadata");
  assertRecord(workflowRunMetadata, "GitHub workflow run metadata");
  const repository = githubRepository(distribution.sourceRepository);

  invariant(
    Number.isSafeInteger(asset.workflowRunId) && asset.workflowRunId > 0,
    "Manifest workflow run ID must be a positive integer",
  );
  invariant(
    Number.isSafeInteger(asset.artifactId) && asset.artifactId > 0,
    "Manifest artifact ID must be a positive integer",
  );
  assertSha256(asset.artifactDigestSha256, "Manifest GitHub artifact digest");
  invariant(
    asset.workflowRunUrl
      === `${distribution.sourceRepository.replace(/\/$/, "")}/actions/runs/${asset.workflowRunId}`,
    "Manifest GitHub workflow run URL does not match sourceRepository",
  );
  invariant(
    normalizedWorkflowPath(asset.workflowPath) === asset.workflowPath,
    "Manifest GitHub workflow path is not normalized",
  );
  invariant(artifactMetadata.id === asset.artifactId, "GitHub artifact ID does not match the manifest");
  invariant(artifactMetadata.name === asset.artifactName, "GitHub artifact name does not match the manifest");
  invariant(
    artifactMetadata.digest === `sha256:${asset.artifactDigestSha256}`,
    "GitHub artifact digest does not match the manifest",
  );
  invariant(artifactMetadata.expired === false, "GitHub artifact is expired");
  invariant(
    normalizedTimestamp(artifactMetadata.expires_at, "GitHub artifact expiry")
      === normalizedTimestamp(asset.artifactExpiresAt, "Manifest artifact expiry"),
    "GitHub artifact expiry does not match the manifest",
  );
  invariant(
    Number(now) < normalizedTimestamp(asset.artifactExpiresAt, "Manifest artifact expiry"),
    "Manifest-pinned GitHub artifact has expired",
  );

  const artifactRun = assertRecord(
    artifactMetadata.workflow_run,
    "GitHub artifact workflow run",
  );
  invariant(artifactRun.id === asset.workflowRunId, "Artifact workflow run ID does not match the manifest");
  invariant(artifactRun.head_branch === asset.headBranch, "Artifact head branch does not match the manifest");
  invariant(artifactRun.head_sha === distribution.forkCommit, "Artifact head commit does not match the fork");

  invariant(workflowRunMetadata.id === asset.workflowRunId, "GitHub run ID does not match the manifest");
  invariant(workflowRunMetadata.html_url === asset.workflowRunUrl, "GitHub run URL does not match the manifest");
  invariant(
    normalizedWorkflowPath(workflowRunMetadata.path) === asset.workflowPath,
    "GitHub run workflow path does not match the manifest",
  );
  invariant(workflowRunMetadata.head_branch === asset.headBranch, "GitHub run head branch does not match the manifest");
  invariant(workflowRunMetadata.head_sha === distribution.forkCommit, "GitHub run head commit does not match the fork");
  invariant(workflowRunMetadata.status === "completed", "GitHub workflow run is not completed");
  invariant(workflowRunMetadata.conclusion === "success", "GitHub workflow run did not succeed");

  const runRepository = assertRecord(
    workflowRunMetadata.repository,
    "GitHub workflow run repository",
  );
  invariant(runRepository.full_name === repository, "GitHub run repository does not match sourceRepository");
  if (artifactRun.repository_id !== undefined || runRepository.id !== undefined) {
    invariant(
      artifactRun.repository_id === runRepository.id,
      "Artifact and workflow run repository IDs do not match",
    );
  }

  return repository;
}

function entriesByFile(entries, expectedFiles, label) {
  invariant(Array.isArray(entries), `${label} must be an array`);
  const byFile = new Map();
  for (const entry of entries) {
    assertRecord(entry, `${label} entry`);
    const file = assertString(entry.file, `${label} entry file`);
    invariant(!byFile.has(file), `${label} contains a duplicate file: ${file}`);
    byFile.set(file, entry);
  }
  assertExactStrings(sorted(byFile.keys()), sorted(expectedFiles), `${label} files`);
  return byFile;
}

function verifySpdxBinaryReference(spdx, binaryHash) {
  invariant(/^SPDX-2\.\d+$/.test(spdx.spdxVersion), "Binary SPDX has an unsupported spdxVersion");
  invariant(Array.isArray(spdx.packages), "Binary SPDX packages must be an array");
  const packages = spdx.packages.filter((entry) => entry?.name === "opencode");
  invariant(packages.length === 1, "Binary SPDX must describe exactly one opencode package");
  const runtime = packages[0];
  invariant(
    runtime.versionInfo === `sha256:${binaryHash}`,
    "Binary SPDX versionInfo does not reference the reviewed binary hash",
  );
  const sha256Checksums = (runtime.checksums ?? [])
    .filter((entry) => entry?.algorithm === "SHA256")
    .map((entry) => entry.checksumValue);
  assertExactStrings(
    sha256Checksums,
    [binaryHash],
    "Binary SPDX SHA256 checksum references",
  );
}

function verifyCycloneDxBinaryReference(cycloneDx, binaryHash) {
  invariant(cycloneDx.bomFormat === "CycloneDX", "Binary CycloneDX has an unexpected bomFormat");
  const component = assertRecord(cycloneDx.metadata?.component, "Binary CycloneDX metadata component");
  invariant(component.name === "opencode", "Binary CycloneDX component must be opencode");
  const hashReferences = (component.hashes ?? [])
    .filter((entry) => entry?.alg === "SHA-256")
    .map((entry) => entry.content);
  const versionReferencesHash = component.version === `sha256:${binaryHash}`;
  invariant(
    versionReferencesHash || hashReferences.includes(binaryHash),
    "Binary CycloneDX does not reference the reviewed binary hash",
  );
  invariant(
    hashReferences.every((hash) => hash === binaryHash),
    "Binary CycloneDX contains a conflicting SHA-256 reference",
  );
}

function verifyProvenance({
  artifactDirectory,
  distribution,
  target,
  asset,
  repository,
  workflowRunMetadata,
}) {
  const provenance = readJsonSync(
    path.join(artifactDirectory, "provenance.json"),
    "OpenCode provenance",
  );
  invariant(provenance.schemaVersion === 2, "OpenCode provenance schemaVersion must be 2");
  invariant(provenance.component === "AgencyAI-OpenCode", "Unexpected provenance component");
  invariant(provenance.version === distribution.binaryVersion, "Provenance version does not match the manifest");
  invariant(provenance.target === target, "Provenance target does not match the manifest");
  invariant(provenance.sourceDateEpoch === SOURCE_DATE_EPOCH, "Unexpected provenance sourceDateEpoch");

  const upstream = assertRecord(provenance.upstream, "Provenance upstream");
  invariant(upstream.repository === "https://github.com/anomalyco/opencode", "Unexpected provenance upstream repository");
  invariant(upstream.tag === distribution.upstreamTag, "Provenance upstream tag does not match the manifest");
  invariant(upstream.commit === distribution.upstreamCommit, "Provenance upstream commit does not match the manifest");
  assertCommit(upstream.commit, "Provenance upstream commit");

  const fork = assertRecord(provenance.fork, "Provenance fork");
  const expectedForkTag = assertString(
    distribution.forkTag,
    "Manifest forkTag",
  );
  invariant(fork.repository?.replace(/\/$/, "") === distribution.sourceRepository.replace(/\/$/, ""), "Provenance fork repository does not match the manifest");
  invariant(fork.tag === expectedForkTag, "Provenance fork tag does not match the reviewed tag");
  invariant(fork.commit === distribution.forkCommit, "Provenance fork commit does not match the manifest");
  assertCommit(fork.commit, "Provenance fork commit");
  invariant(Array.isArray(distribution.patchCommits), "Manifest patchCommits must be an array");
  distribution.patchCommits.forEach((commit, index) =>
    assertCommit(commit, `Manifest patch commit ${index + 1}`));
  assertExactStrings(fork.patchCommits, distribution.patchCommits, "Provenance patch queue");
  invariant(
    distribution.patchCommits.at(-1) === distribution.forkCommit,
    "Manifest patch queue must end at forkCommit",
  );

  const workflow = assertRecord(provenance.workflow, "Provenance workflow");
  invariant(workflow.repository === repository, "Provenance workflow repository does not match the manifest");
  invariant(String(workflow.runId) === String(asset.workflowRunId), "Provenance workflow run ID does not match the manifest");
  invariant(workflow.url === asset.workflowRunUrl, "Provenance workflow URL does not match the manifest");
  invariant(workflow.file === asset.workflowPath, "Provenance workflow file does not match the manifest");
  assertSha256(workflow.sha256, "Provenance workflow hash");
  if (workflowRunMetadata.run_attempt !== undefined) {
    invariant(
      String(workflow.attempt) === String(workflowRunMetadata.run_attempt),
      "Provenance workflow attempt does not match GitHub",
    );
  }
  if (workflowRunMetadata.event !== undefined) {
    invariant(
      workflow.event === workflowRunMetadata.event,
      "Provenance workflow event does not match GitHub",
    );
  }

  const build = assertRecord(provenance.build, "Provenance build");
  invariant(build.command === BUILD_COMMAND, "Unexpected provenance build command");
  invariant(build.outputBinary === BUILD_OUTPUT, "Unexpected provenance build output path");
  const archive = assertRecord(build.archive, "Provenance build archive");
  invariant(archive.file === asset.archive, "Provenance archive name does not match the manifest");
  invariant(archive.sha256 === asset.sourceArchiveSha256, "Provenance archive hash does not match the manifest");
  const binary = assertRecord(build.binary, "Provenance build binary");
  invariant(binary.sha256 === asset.sourceBinarySha256, "Provenance binary hash does not match the manifest");
  invariant(binary.signed === "ad-hoc codesign before archiving", "Unexpected provenance binary signing phase");
  assertExactStrings(
    sorted(Object.keys(assertRecord(build.environment, "Provenance build environment"))),
    sorted(Object.keys(OPENCODE_BUILD_ENVIRONMENT)),
    "Provenance build environment variables",
  );
  for (const [name, expectedValue] of Object.entries(OPENCODE_BUILD_ENVIRONMENT)) {
    invariant(
      build.environment[name] === expectedValue,
      `Provenance build environment ${name} does not match the reviewed value`,
    );
  }

  const dependencies = assertRecord(provenance.dependencies, "Provenance dependencies");
  assertSha256(dependencies.lockSha256, "Provenance lockfile hash");
  const ghostty = assertRecord(dependencies.ghosttyWeb, "Provenance ghostty-web dependency");
  assertCommit(ghostty.commit, "Provenance ghostty-web commit");
  invariant(
    ghostty.source === `github:anomalyco/ghostty-web#${ghostty.commit}`,
    "Provenance ghostty-web source is not commit-pinned",
  );
  const modelsDev = assertRecord(
    dependencies.modelsDev,
    "Provenance models.dev dependency",
  );
  invariant(
    modelsDev.source === MODELS_DEV_SOURCE,
    "Provenance models.dev source is not the reviewed repository",
  );
  assertCommit(modelsDev.commit, "Provenance models.dev commit");
  invariant(
    modelsDev.buildCommand === MODELS_DEV_BUILD_COMMAND,
    "Provenance models.dev build command does not match the reviewed command",
  );
  invariant(
    modelsDev.sourcePath === MODELS_DEV_SOURCE_PATH,
    "Provenance models.dev source path does not match the reviewed output",
  );
  invariant(
    modelsDev.file === MODELS_DEV_SNAPSHOT_FILE,
    "Provenance models.dev snapshot file does not match the reviewed path",
  );
  assertSha256(modelsDev.sha256, "Provenance models.dev snapshot hash");

  const sbomDescriptors = {
    "opencode-build-source.cdx.json": {
      format: "CycloneDX JSON",
      scope: "build source tree",
    },
    "opencode-darwin-arm64.cdx.json": {
      format: "CycloneDX JSON",
      scope: "signed runtime binary",
    },
    "opencode-darwin-arm64.spdx.json": {
      format: "SPDX JSON",
      scope: "signed runtime binary",
    },
  };
  const sbomFiles = Object.keys(sbomDescriptors);
  const sboms = entriesByFile(provenance.sboms, sbomFiles, "Provenance SBOMs");
  for (const [file, entry] of sboms) {
    invariant(
      entry.sha256 === asset.artifactFiles[file],
      `Provenance SBOM hash does not match the manifest: ${file}`,
    );
    invariant(
      entry.format === sbomDescriptors[file].format
        && entry.scope === sbomDescriptors[file].scope,
      `Provenance SBOM descriptor does not match the reviewed scope: ${file}`,
    );
  }

  const notices = entriesByFile(
    provenance.notices,
    ["AGENCYAI_FORK_NOTICE.md", "LICENSE-OpenCode"],
    "Provenance notices",
  );
  for (const [file, entry] of notices) {
    invariant(
      entry.sha256 === asset.artifactFiles[file],
      `Provenance notice hash does not match the manifest: ${file}`,
    );
  }

  const materials = entriesByFile(
    provenance.materials,
    [
      asset.workflowPath,
      "bun.lock",
      MODELS_DEV_SNAPSHOT_FILE,
      MODELS_DEV_METADATA_FILE,
    ],
    "Provenance materials",
  );
  invariant(
    materials.get(asset.workflowPath).sha256 === workflow.sha256,
    "Provenance workflow material hash does not match workflow.sha256",
  );
  invariant(
    materials.get("bun.lock").sha256 === dependencies.lockSha256,
    "Provenance lock material hash does not match dependencies.lockSha256",
  );
  invariant(
    materials.get(MODELS_DEV_SNAPSHOT_FILE).sha256 === modelsDev.sha256,
    "Provenance models.dev snapshot material hash does not match dependencies.modelsDev.sha256",
  );
  assertSha256(
    materials.get(MODELS_DEV_METADATA_FILE).sha256,
    "Provenance models.dev metadata material hash",
  );

  const spdx = readJsonSync(
    path.join(artifactDirectory, "opencode-darwin-arm64.spdx.json"),
    "Binary SPDX",
  );
  verifySpdxBinaryReference(spdx, asset.sourceBinarySha256);
  const binaryCycloneDx = readJsonSync(
    path.join(artifactDirectory, "opencode-darwin-arm64.cdx.json"),
    "Binary CycloneDX",
  );
  verifyCycloneDxBinaryReference(binaryCycloneDx, asset.sourceBinarySha256);
  const buildCycloneDx = readJsonSync(
    path.join(artifactDirectory, "opencode-build-source.cdx.json"),
    "Build-source CycloneDX",
  );
  invariant(
    buildCycloneDx.bomFormat === "CycloneDX",
    "Build-source CycloneDX has an unexpected bomFormat",
  );

  return provenance;
}

export function verifyOpenCodeWorkflowArtifactEvidenceSync({
  artifactDirectory,
  distribution,
  target,
  artifactMetadata,
  workflowRunMetadata,
  now = Date.now(),
}) {
  invariant(path.isAbsolute(artifactDirectory), "artifactDirectory must be absolute");
  assertRecord(distribution, "OpenCode distribution manifest");
  assertString(target, "OpenCode target");
  const asset = assertRecord(
    distribution.targetAssets?.[target],
    `OpenCode target asset ${target}`,
  );
  assertSha256(asset.sourceArchiveSha256, "OpenCode sourceArchiveSha256");
  assertSha256(asset.sourceBinarySha256, "OpenCode sourceBinarySha256");
  assertCommit(distribution.upstreamCommit, "Manifest upstream commit");
  assertCommit(distribution.forkCommit, "Manifest fork commit");

  const expectedFiles = verifyTopLevelInventory(artifactDirectory, asset);
  verifyChecksums(artifactDirectory, expectedFiles, asset);
  const repository = verifyGithubMetadata({
    distribution,
    asset,
    artifactMetadata,
    workflowRunMetadata,
    now: now instanceof Date ? now.getTime() : Number(now),
  });
  const provenance = verifyProvenance({
    artifactDirectory,
    distribution,
    target,
    asset,
    repository,
    workflowRunMetadata,
  });

  return Object.freeze({
    artifactDirectory: realpathSync(artifactDirectory),
    artifactId: asset.artifactId,
    workflowRunId: asset.workflowRunId,
    repository,
    forkCommit: distribution.forkCommit,
    sourceArchiveSha256: asset.sourceArchiveSha256,
    sourceBinarySha256: asset.sourceBinarySha256,
    provenance,
  });
}
