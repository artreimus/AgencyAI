import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  OPENCODE_ARTIFACT_FILES,
  OPENCODE_BUILD_ENVIRONMENT,
  sha256FileSync,
  verifyOpenCodeWorkflowArtifactEvidenceSync,
} from "./opencode-artifact-evidence.mjs";

const TARGET = "aarch64-apple-darwin";
const REPOSITORY = "artreimus/AgencyAI-OpenCode";
const SOURCE_REPOSITORY = `https://github.com/${REPOSITORY}`;
const WORKFLOW_PATH = ".github/workflows/agencyai-runtime.yml";
const WORKFLOW_RUN_ID = 30393234285;
const ARTIFACT_ID = 8701822665;
const ARTIFACT_NAME = "agencyai-opencode-1.17.11-darwin-arm64";
const FORK_TAG = "product-opencode-v1.17.11-p3";
const EXPIRES_AT = "2030-10-26T12:43:49Z";
const UPSTREAM_COMMIT = "0".repeat(40);
const PATCH_COMMITS = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
const FORK_COMMIT = PATCH_COMMITS.at(-1);
const BINARY_HASH = sha256("reviewed signed OpenCode binary");
const WORKFLOW_HASH = sha256("reviewed workflow");
const LOCK_HASH = sha256("reviewed bun.lock");
const MODELS_DEV_COMMIT = "c".repeat(40);
const MODELS_DEV_HASH = sha256("reviewed models.dev snapshot");
const MODELS_DEV_METADATA_HASH = sha256("reviewed models.dev metadata");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function artifactFiles(archive) {
  return OPENCODE_ARTIFACT_FILES.map((file) =>
    file === "opencode-darwin-arm64.zip" ? archive : file);
}

function resealTopLevel(fixture, { writeProvenance = true } = {}) {
  const { artifactDirectory, asset, provenance } = fixture;
  if (writeProvenance) {
    json(join(artifactDirectory, "provenance.json"), provenance);
  }
  const files = artifactFiles(asset.archive);
  const checksumBody = files
    .filter((file) => file !== "SHA256SUMS")
    .sort()
    .map((file) => `${sha256FileSync(join(artifactDirectory, file))}  ${file}`)
    .join("\n");
  writeFileSync(join(artifactDirectory, "SHA256SUMS"), `${checksumBody}\n`);

  asset.sourceArchiveSha256 = sha256FileSync(
    join(artifactDirectory, asset.archive),
  );
  asset.provenanceSha256 = sha256FileSync(
    join(artifactDirectory, "provenance.json"),
  );
  asset.spdxSha256 = sha256FileSync(
    join(artifactDirectory, "opencode-darwin-arm64.spdx.json"),
  );
  asset.cycloneDxSha256 = sha256FileSync(
    join(artifactDirectory, "opencode-darwin-arm64.cdx.json"),
  );
  asset.buildSourceCycloneDxSha256 = sha256FileSync(
    join(artifactDirectory, "opencode-build-source.cdx.json"),
  );
  asset.artifactFiles = Object.fromEntries(
    files.map((file) => [file, sha256FileSync(join(artifactDirectory, file))]),
  );
}

function synchronizeReferencedFileHashes(fixture) {
  const { artifactDirectory, provenance } = fixture;
  for (const entry of provenance.sboms) {
    entry.sha256 = sha256FileSync(join(artifactDirectory, entry.file));
  }
  for (const entry of provenance.notices) {
    entry.sha256 = sha256FileSync(join(artifactDirectory, entry.file));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agencyai-artifact-evidence-"));
  roots.push(root);
  const artifactDirectory = join(root, "artifact");
  mkdirSync(artifactDirectory);
  const archive = "opencode-darwin-arm64.zip";

  writeFileSync(join(artifactDirectory, archive), "deterministic ZIP fixture");
  writeFileSync(join(artifactDirectory, "AGENCYAI_FORK_NOTICE.md"), "AgencyAI fork notice\n");
  writeFileSync(join(artifactDirectory, "LICENSE-OpenCode"), "MIT\n");
  json(join(artifactDirectory, "opencode-darwin-arm64.spdx.json"), {
    spdxVersion: "SPDX-2.3",
    packages: [{
      name: "opencode",
      versionInfo: `sha256:${BINARY_HASH}`,
      checksums: [{ algorithm: "SHA256", checksumValue: BINARY_HASH }],
    }],
  });
  json(join(artifactDirectory, "opencode-darwin-arm64.cdx.json"), {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: {
      component: {
        type: "file",
        name: "opencode",
        version: `sha256:${BINARY_HASH}`,
      },
    },
  });
  json(join(artifactDirectory, "opencode-build-source.cdx.json"), {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: { component: { type: "directory", name: "." } },
  });

  const workflowRunUrl =
    `${SOURCE_REPOSITORY}/actions/runs/${WORKFLOW_RUN_ID}`;
  const provenance = {
    schemaVersion: 2,
    component: "AgencyAI-OpenCode",
    version: "1.17.11",
    target: TARGET,
    sourceDateEpoch: 315532800,
    upstream: {
      repository: "https://github.com/anomalyco/opencode",
      tag: "v1.17.11",
      commit: UPSTREAM_COMMIT,
    },
    fork: {
      repository: SOURCE_REPOSITORY,
      tag: FORK_TAG,
      commit: FORK_COMMIT,
      patchCommits: [...PATCH_COMMITS],
    },
    workflow: {
      repository: REPOSITORY,
      runId: String(WORKFLOW_RUN_ID),
      attempt: "1",
      event: "push",
      ref: "refs/heads/agencyai-runtime-lock",
      url: workflowRunUrl,
      file: WORKFLOW_PATH,
      sha256: WORKFLOW_HASH,
    },
    build: {
      command:
        "bun packages/opencode/script/build.ts --single --skip-embed-web-ui --skip-install",
      outputBinary:
        "packages/opencode/dist/opencode-darwin-arm64/bin/opencode",
      binary: {
        sha256: BINARY_HASH,
        signed: "ad-hoc codesign before archiving",
      },
      archive: {
        file: archive,
        sha256: sha256FileSync(join(artifactDirectory, archive)),
      },
      environment: { ...OPENCODE_BUILD_ENVIRONMENT },
    },
    dependencies: {
      lockFile: "bun.lock",
      lockSha256: LOCK_HASH,
      ghosttyWeb: {
        source: `github:anomalyco/ghostty-web#${"d".repeat(40)}`,
        commit: "d".repeat(40),
      },
      modelsDev: {
        source: "https://github.com/anomalyco/models.dev",
        commit: MODELS_DEV_COMMIT,
        buildCommand: "bun run --cwd packages/web build",
        sourcePath: "packages/web/dist/_api.json",
        file: ".github/agencyai/models-dev-api.json",
        sha256: MODELS_DEV_HASH,
      },
    },
    sboms: [
      {
        file: "opencode-darwin-arm64.spdx.json",
        format: "SPDX JSON",
        scope: "signed runtime binary",
      },
      {
        file: "opencode-darwin-arm64.cdx.json",
        format: "CycloneDX JSON",
        scope: "signed runtime binary",
      },
      {
        file: "opencode-build-source.cdx.json",
        format: "CycloneDX JSON",
        scope: "build source tree",
      },
    ],
    notices: [
      { file: "LICENSE-OpenCode" },
      { file: "AGENCYAI_FORK_NOTICE.md" },
    ],
    materials: [
      { file: WORKFLOW_PATH, sha256: WORKFLOW_HASH },
      { file: "bun.lock", sha256: LOCK_HASH },
      {
        file: ".github/agencyai/models-dev-api.json",
        sha256: MODELS_DEV_HASH,
      },
      {
        file: ".github/agencyai/models-dev-snapshot.json",
        sha256: MODELS_DEV_METADATA_HASH,
      },
    ],
  };

  const asset = {
    workflowRunId: WORKFLOW_RUN_ID,
    workflowRunUrl,
    workflowPath: WORKFLOW_PATH,
    headBranch: "agencyai-runtime-lock",
    artifactId: ARTIFACT_ID,
    artifactName: ARTIFACT_NAME,
    artifactDigestSha256: sha256("GitHub artifact envelope"),
    artifactExpiresAt: EXPIRES_AT,
    archive,
    sourceArchiveSha256: "",
    binary: "opencode",
    sourceBinarySha256: BINARY_HASH,
    provenanceSha256: "",
    spdxSha256: "",
    cycloneDxSha256: "",
    buildSourceCycloneDxSha256: "",
    artifactFiles: {},
  };
  const distribution = {
    schemaVersion: 1,
    sourceRepository: SOURCE_REPOSITORY,
    upstreamTag: "v1.17.11",
    upstreamCommit: UPSTREAM_COMMIT,
    forkCommit: FORK_COMMIT,
    forkTag: FORK_TAG,
    patchCommits: [...PATCH_COMMITS],
    binaryVersion: "1.17.11",
    targetAssets: { [TARGET]: asset },
  };
  const artifactMetadata = {
    id: ARTIFACT_ID,
    name: ARTIFACT_NAME,
    digest: `sha256:${asset.artifactDigestSha256}`,
    expired: false,
    expires_at: EXPIRES_AT,
    workflow_run: {
      id: WORKFLOW_RUN_ID,
      repository_id: 90210,
      head_branch: asset.headBranch,
      head_sha: FORK_COMMIT,
    },
  };
  const workflowRunMetadata = {
    id: WORKFLOW_RUN_ID,
    html_url: workflowRunUrl,
    path: `${WORKFLOW_PATH}@refs/heads/${asset.headBranch}`,
    head_branch: asset.headBranch,
    head_sha: FORK_COMMIT,
    status: "completed",
    conclusion: "success",
    event: "push",
    run_attempt: 1,
    repository: { id: 90210, full_name: REPOSITORY },
  };

  const result = {
    root,
    artifactDirectory,
    asset,
    distribution,
    provenance,
    artifactMetadata,
    workflowRunMetadata,
  };
  synchronizeReferencedFileHashes(result);
  resealTopLevel(result);
  return result;
}

function verify(fixtureValue) {
  return verifyOpenCodeWorkflowArtifactEvidenceSync({
    artifactDirectory: fixtureValue.artifactDirectory,
    distribution: fixtureValue.distribution,
    target: TARGET,
    artifactMetadata: fixtureValue.artifactMetadata,
    workflowRunMetadata: fixtureValue.workflowRunMetadata,
    now: new Date("2026-07-28T00:00:00Z"),
  });
}

describe("OpenCode workflow artifact evidence", () => {
  test("binds a complete schema-2 artifact to its manifest and GitHub metadata", () => {
    const value = fixture();
    const result = verify(value);

    assert.equal(result.artifactId, ARTIFACT_ID);
    assert.equal(result.workflowRunId, WORKFLOW_RUN_ID);
    assert.equal(result.repository, REPOSITORY);
    assert.equal(result.forkCommit, FORK_COMMIT);
    assert.equal(result.sourceBinarySha256, BINARY_HASH);
    assert.equal(result.provenance.schemaVersion, 2);
    assert.equal(Object.isFrozen(result), true);
  });

  test("rejects tampering, unexpected inventory, and symbolic links", () => {
    const tampered = fixture();
    writeFileSync(join(tampered.artifactDirectory, "LICENSE-OpenCode"), "tampered\n");
    assert.throws(() => verify(tampered), /Artifact SHA-256 mismatch/);

    const extra = fixture();
    writeFileSync(join(extra.artifactDirectory, "unexpected.txt"), "unexpected\n");
    assert.throws(() => verify(extra), /Downloaded artifact inventory/);

    const linked = fixture();
    const outside = join(linked.root, "outside-license");
    writeFileSync(outside, "MIT\n");
    unlinkSync(join(linked.artifactDirectory, "LICENSE-OpenCode"));
    symlinkSync(outside, join(linked.artifactDirectory, "LICENSE-OpenCode"));
    assert.throws(() => verify(linked), /cannot be a symbolic link/);
  });

  test("binds every named manifest evidence hash to artifactFiles", () => {
    const fields = [
      "sourceArchiveSha256",
      "provenanceSha256",
      "spdxSha256",
      "cycloneDxSha256",
      "buildSourceCycloneDxSha256",
    ];
    for (const field of fields) {
      const value = fixture();
      value.asset[field] = "e".repeat(64);
      assert.throws(
        () => verify(value),
        /evidence hash does not match artifactFiles/,
        field,
      );
    }
  });

  test("requires exact, relative, duplicate-free SHA256SUMS coverage", () => {
    const traversal = fixture();
    const checksumPath = join(traversal.artifactDirectory, "SHA256SUMS");
    const body = readFileSync(checksumPath, "utf8");
    writeFileSync(
      checksumPath,
      body.replace("  LICENSE-OpenCode", "  ../LICENSE-OpenCode"),
    );
    traversal.asset.artifactFiles.SHA256SUMS = sha256FileSync(checksumPath);
    assert.throws(() => verify(traversal), /Invalid relative SHA256SUMS entry/);

    const missing = fixture();
    const missingChecksumPath = join(missing.artifactDirectory, "SHA256SUMS");
    const lines = readFileSync(missingChecksumPath, "utf8")
      .trimEnd()
      .split("\n")
      .slice(1);
    writeFileSync(missingChecksumPath, `${lines.join("\n")}\n`);
    missing.asset.artifactFiles.SHA256SUMS = sha256FileSync(missingChecksumPath);
    assert.throws(() => verify(missing), /SHA256SUMS coverage/);

    const duplicate = fixture();
    const duplicateChecksumPath = join(duplicate.artifactDirectory, "SHA256SUMS");
    const duplicateBody = readFileSync(duplicateChecksumPath, "utf8");
    writeFileSync(
      duplicateChecksumPath,
      `${duplicateBody}${duplicateBody.split("\n")[0]}\n`,
    );
    duplicate.asset.artifactFiles.SHA256SUMS =
      sha256FileSync(duplicateChecksumPath);
    assert.throws(() => verify(duplicate), /Duplicate SHA256SUMS entry/);
  });

  test("rejects GitHub artifact metadata that is not pinned by the manifest", () => {
    const cases = [
      ["artifact ID", (value) => { value.artifactMetadata.id += 1; }, /artifact ID/i],
      ["artifact name", (value) => { value.artifactMetadata.name += "-other"; }, /artifact name/i],
      ["artifact digest", (value) => { value.artifactMetadata.digest = `sha256:${"f".repeat(64)}`; }, /artifact digest/i],
      ["artifact expiry", (value) => { value.artifactMetadata.expires_at = "2031-01-01T00:00:00Z"; }, /artifact expiry/i],
      ["artifact head", (value) => { value.artifactMetadata.workflow_run.head_sha = "f".repeat(40); }, /head commit/i],
      ["artifact repository", (value) => { value.artifactMetadata.workflow_run.repository_id += 1; }, /repository IDs/i],
    ];
    for (const [label, mutate, expected] of cases) {
      const value = fixture();
      mutate(value);
      assert.throws(() => verify(value), expected, label);
    }
  });

  test("rejects a GitHub run with the wrong identity, workflow, head, or result", () => {
    const cases = [
      ["run ID", (value) => { value.workflowRunMetadata.id += 1; }, /run ID/i],
      ["workflow", (value) => { value.workflowRunMetadata.path = ".github/workflows/other.yml"; }, /workflow path/i],
      ["head branch", (value) => { value.workflowRunMetadata.head_branch = "main"; }, /head branch/i],
      ["head commit", (value) => { value.workflowRunMetadata.head_sha = "f".repeat(40); }, /head commit/i],
      ["status", (value) => { value.workflowRunMetadata.status = "in_progress"; }, /not completed/i],
      ["conclusion", (value) => { value.workflowRunMetadata.conclusion = "failure"; }, /did not succeed/i],
      ["repository", (value) => { value.workflowRunMetadata.repository.full_name = "attacker/fork"; }, /repository/i],
    ];
    for (const [label, mutate, expected] of cases) {
      const value = fixture();
      mutate(value);
      assert.throws(() => verify(value), expected, label);
    }
  });

  test("rejects schema-2 provenance that diverges from reviewed source and build inputs", () => {
    const cases = [
      ["upstream tag", (value) => { value.provenance.upstream.tag = "v1.17.12"; }, /upstream tag/i],
      ["fork tag", (value) => { value.provenance.fork.tag = "unreviewed"; }, /fork tag/i],
      ["fork commit", (value) => { value.provenance.fork.commit = "f".repeat(40); }, /fork commit/i],
      ["patch queue", (value) => { value.provenance.fork.patchCommits.pop(); }, /patch queue/i],
      ["workflow hash", (value) => { value.provenance.workflow.sha256 = "e".repeat(64); }, /workflow material hash/i],
      ["archive hash", (value) => { value.provenance.build.archive.sha256 = "e".repeat(64); }, /archive hash/i],
      ["binary hash", (value) => { value.provenance.build.binary.sha256 = "e".repeat(64); }, /binary hash/i],
      ["environment", (value) => { value.provenance.build.environment.OPENCODE_DISABLE_SHARE = "0"; }, /environment OPENCODE_DISABLE_SHARE/i],
      ["lock hash", (value) => { value.provenance.dependencies.lockSha256 = "e".repeat(64); }, /lock material hash/i],
      ["models.dev source", (value) => { value.provenance.dependencies.modelsDev.source = "https://example.invalid/models"; }, /models\.dev source/i],
      ["models.dev commit", (value) => { value.provenance.dependencies.modelsDev.commit = "invalid"; }, /models\.dev commit/i],
      ["models.dev snapshot", (value) => { value.provenance.dependencies.modelsDev.sha256 = "e".repeat(64); }, /models\.dev snapshot material hash/i],
      ["workflow attempt", (value) => { value.provenance.workflow.attempt = "2"; }, /workflow attempt/i],
    ];
    for (const [label, mutate, expected] of cases) {
      const value = fixture();
      mutate(value);
      resealTopLevel(value);
      assert.throws(() => verify(value), expected, label);
    }
  });

  test("requires structured SPDX and CycloneDX references to the binary hash", () => {
    const spdx = fixture();
    const spdxPath = join(
      spdx.artifactDirectory,
      "opencode-darwin-arm64.spdx.json",
    );
    const spdxDocument = JSON.parse(readFileSync(spdxPath, "utf8"));
    spdxDocument.packages[0].checksums[0].checksumValue = "e".repeat(64);
    json(spdxPath, spdxDocument);
    synchronizeReferencedFileHashes(spdx);
    resealTopLevel(spdx);
    assert.throws(() => verify(spdx), /SPDX SHA256 checksum references/);

    const cycloneDx = fixture();
    const cycloneDxPath = join(
      cycloneDx.artifactDirectory,
      "opencode-darwin-arm64.cdx.json",
    );
    const cycloneDxDocument = JSON.parse(readFileSync(cycloneDxPath, "utf8"));
    cycloneDxDocument.metadata.component.version = `sha256:${"e".repeat(64)}`;
    json(cycloneDxPath, cycloneDxDocument);
    synchronizeReferencedFileHashes(cycloneDx);
    resealTopLevel(cycloneDx);
    assert.throws(
      () => verify(cycloneDx),
      /CycloneDX does not reference the reviewed binary hash/,
    );
  });
});
