import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIXTURE_PREFIX = "agencyai-pr04-";
const RESULT_MARKER = "AGENCYAI_PR04_RESULT ";
const TARGET = "aarch64-apple-darwin";
const VERSION = "1.17.11";
const UPSTREAM_COMMIT = "67aec2212010d67775c35e696d8b8b54902eb338";
const PATCH_COMMITS = Object.freeze([
  "14c9607366e56d9c0c0f34c5575c7e9045b24c2b",
  "2a117b609748bc9bda24f74bdaea24600eeba676",
  "dd1c3809ac23b91ec2fbdebc47c18cc45d79ad03",
  "6ea79c2d5630eef28faa1adba81d5e6d95602ce9",
  "250187ae065e706e7f3d068215a587445d98c1eb",
  "21f80fa95205275d38ff05490fb640e624dc315d",
  "b4f05fef52047d30f5c4656dcd8480e2c4e72de7",
  "d7a2e5ed280a976d4b16e96c33e6b4780af6a34b",
  "b424e670490d6241dca6f7fbcb3d6608af69aa41",
]);
const FORK_COMMIT = PATCH_COMMITS.at(-1);
const FORK_TAG = "product-opencode-v1.17.11-p2";
const WORKFLOW_RUN_ID = 30360214214;
const ARTIFACT_NAME = "agencyai-opencode-1.17.11-darwin-arm64";
const RENDERER_ORIGIN = "agencyai-internal://renderer";
const CLIENT_TOKEN = "owt_agencyai_pr04_client";
const HOST_TOKEN = "owt_agencyai_pr04_host";
const OPENCODE_PASSWORD = "agencyai-pr04-opencode-password";
const PROVIDER_SECRET = "agencyai-pr04-provider-secret";
const WORKSPACE_ID = "ws_agencyai_pr04";

export const FRAME_DEFINITIONS = Object.freeze([
  Object.freeze({
    frame: 1,
    id: "manifest-compatibility",
    claim: "One immutable manifest pins the exact fork, upstream, binary, and SDK compatibility set",
  }),
  Object.freeze({
    frame: 2,
    id: "artifact-provenance",
    claim: "The real archive, binary, SBOMs, provenance, and ripgrep hashes match the reviewed manifest",
  }),
  Object.freeze({
    frame: 3,
    id: "bundled-only-runtime",
    claim: "Production runtime resolution accepts only the verified bundled OpenCode and toolchain",
  }),
  Object.freeze({
    frame: 4,
    id: "child-environment",
    claim: "The explicit OpenCode child environment preserves intentional local values and forces policy flags",
  }),
  Object.freeze({
    frame: 5,
    id: "empty-cache",
    claim: "Every runtime package fallback fails before registry I/O or package mutation",
  }),
  Object.freeze({
    frame: 6,
    id: "readiness-and-local-surfaces",
    claim: "Readiness exposes verified provenance without secrets while ordinary local engine surfaces work",
  }),
]);

const MODULES = Object.freeze({
  distribution: new URL(
    "../../apps/desktop/electron/opencode-distribution.mjs",
    import.meta.url,
  ).href,
  runtime: new URL(
    "../../apps/desktop/electron/runtime.mjs",
    import.meta.url,
  ).href,
  storageLayout: new URL(
    "../../apps/desktop/electron/storage-layout.mjs",
    import.meta.url,
  ).href,
  productContract: new URL(
    "../../packages/product-config/src/contract.ts",
    import.meta.url,
  ).href,
  opencodePolicy: new URL(
    "../../packages/product-config/src/opencode-policy.ts",
    import.meta.url,
  ).href,
  server: new URL("../../apps/server/src/server.ts", import.meta.url).href,
  generatedConfig: new URL(
    "../../apps/server/src/openwork-runtime-config.ts",
    import.meta.url,
  ).href,
});

const ARTIFACT_FILES = Object.freeze([
  "AGENCYAI_FORK_NOTICE.md",
  "LICENSE-OpenCode",
  "SHA256SUMS",
  "opencode-build-source.cdx.json",
  "opencode-darwin-arm64.cdx.json",
  "opencode-darwin-arm64.spdx.json",
  "opencode-darwin-arm64.zip",
  "provenance.json",
]);

const ENVIRONMENT_KEYS = Object.freeze([
  "OPENWORK_STORAGE_ROOT",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_DATA_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENWORK_CONTROL_BASE_URL",
  "OPENWORK_CONTROL_TOKEN",
  "OPENWORK_GITHUB_API_BASE",
  "OPENWORK_GITHUB_RAW_BASE",
  "OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL",
  "OPENWORK_API_KEY",
  "OPENWORK_INFERENCE_BASE_URL",
  "OPENWORK_WEB_ROOT",
  "OPENWORK_TOY_UI",
  "OPENWORK_BROWSER_PROVIDER",
  "OPENWORK_SANDBOX_BACKEND",
  "OPENWORK_SANDBOX_ENABLED",
  "OPENWORK_DEV_LOG_FILE",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createChecks() {
  const checks = [];
  return {
    expect(condition, label, actual) {
      if (!condition) {
        throw new Error(
          `${label}${actual === undefined ? "" : ` (actual: ${stableJson(actual)})`}`,
        );
      }
      checks.push({
        label,
        passed: true,
        ...(actual === undefined ? {} : { actual }),
      });
    },
    list: checks,
  };
}

function normalizedOutput(result) {
  return [
    String(result.stdout ?? "").trim(),
    String(result.stderr ?? "").trim(),
    result.error?.message ?? "",
  ].filter(Boolean).join("\n");
}

function runSync(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed\n${normalizedOutput(result)}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

async function runAsync(program, args, options = {}) {
  const child = Bun.spawn([program, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed\n${stdout.trim()}\n${stderr.trim()}`,
    );
  }
  return { stdout, stderr, status };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function regularFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function findFile(root, fileName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

export function resolveFixtureRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("fixture root is required");
  }
  const resolved = resolve(value);
  const temporaryRoot = resolve(tmpdir());
  const relation = relative(temporaryRoot, resolved);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || basename(resolved).startsWith(FIXTURE_PREFIX) === false
  ) {
    throw new Error(
      `fixture root must be a ${FIXTURE_PREFIX}* directory inside ${temporaryRoot}`,
    );
  }
  return resolved;
}

export function resolveForkRoot(value, repositoryRoot) {
  const candidate = resolve(
    value?.trim()
      || join(repositoryRoot, "..", "AgencyAI-OpenCode"),
  );
  if (!existsSync(join(candidate, ".git"))) {
    throw new Error(
      "AgencyAI-OpenCode checkout is required; set AGENCYAI_OPENCODE_SOURCE_ROOT",
    );
  }
  return candidate;
}

async function frameDirectory(rootInput, frame) {
  const root = resolveFixtureRoot(rootInput);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, `frame-${frame}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { root, directory };
}

async function loadManifest(repositoryRoot) {
  const distributionModule = await import(MODULES.distribution);
  const loaded = distributionModule.loadOpencodeDistributionSync({
    desktopRoot: join(repositoryRoot, "apps", "desktop"),
    isPackaged: false,
  });
  return {
    distributionModule,
    manifestPath: loaded.path,
    manifest: loaded.manifest,
    target: distributionModule.distributionTarget(loaded.manifest, TARGET),
  };
}

async function copyArtifactSource(source, destination) {
  for (const fileName of [
    ...ARTIFACT_FILES,
    "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
  ]) {
    const sourcePath = join(source, fileName);
    if (!(await regularFile(sourcePath))) {
      throw new Error(`preseeded PR04 artifact is missing ${fileName}`);
    }
    await copyFile(sourcePath, join(destination, fileName));
  }
}

async function ensureArtifactBundle(root, manifest, target) {
  const bundle = join(root, "artifacts");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  const archivePath = join(bundle, target.opencode.archive);
  const ripgrepArchivePath = join(bundle, target.ripgrep.archive);
  const alreadyPresent = [
    ...ARTIFACT_FILES.map((fileName) => join(bundle, fileName)),
    ripgrepArchivePath,
  ].every(existsSync);

  if (!alreadyPresent) {
    const preseeded = process.env.AGENCYAI_PR04_ARTIFACT_DIR?.trim();
    if (preseeded) {
      await copyArtifactSource(resolve(preseeded), bundle);
    } else {
      await runAsync("gh", [
        "run",
        "download",
        String(manifest.targetAssets[TARGET].workflowRunId),
        "--repo",
        "artreimus/AgencyAI-OpenCode",
        "--name",
        manifest.targetAssets[TARGET].artifactName,
        "--dir",
        bundle,
      ]);
      await runAsync("curl", [
        "-fsSL",
        "-o",
        ripgrepArchivePath,
        target.ripgrep.url,
      ]);
    }
  }

  assert(await regularFile(archivePath), "OpenCode archive is missing");
  assert(
    await regularFile(ripgrepArchivePath),
    "ripgrep archive is missing",
  );
  return { bundle, archivePath, ripgrepArchivePath };
}

async function extractVerifiedArtifacts(root, manifest, target) {
  const bundle = await ensureArtifactBundle(root, manifest, target);
  const extractedRoot = join(root, "verified-artifacts");
  const opencodeExtracted = join(extractedRoot, "opencode");
  const ripgrepExtracted = join(extractedRoot, "ripgrep");
  await mkdir(opencodeExtracted, { recursive: true });
  await mkdir(ripgrepExtracted, { recursive: true });

  let opencodeBinary = await findFile(opencodeExtracted, target.opencode.binary);
  if (!opencodeBinary) {
    runSync("unzip", [
      "-q",
      bundle.archivePath,
      "-d",
      opencodeExtracted,
    ]);
    opencodeBinary = await findFile(
      opencodeExtracted,
      target.opencode.binary,
    );
  }
  assert(opencodeBinary, "OpenCode archive did not contain the binary");

  let ripgrepBinary = await findFile(ripgrepExtracted, target.ripgrep.binary);
  if (!ripgrepBinary) {
    runSync("tar", [
      "-xzf",
      bundle.ripgrepArchivePath,
      "-C",
      ripgrepExtracted,
    ]);
    ripgrepBinary = await findFile(
      ripgrepExtracted,
      target.ripgrep.binary,
    );
  }
  assert(ripgrepBinary, "ripgrep archive did not contain rg");

  return {
    ...bundle,
    opencodeBinary,
    ripgrepBinary,
    provenancePath: join(bundle.bundle, "provenance.json"),
    spdxPath: join(bundle.bundle, "opencode-darwin-arm64.spdx.json"),
    cycloneDxPath: join(bundle.bundle, "opencode-darwin-arm64.cdx.json"),
    buildSourceCycloneDxPath: join(
      bundle.bundle,
      "opencode-build-source.cdx.json",
    ),
  };
}

function packageDependency(packageJson, name) {
  return isRecord(packageJson.dependencies)
    ? packageJson.dependencies[name]
    : undefined;
}

async function frameOne(rootInput, repositoryRoot, forkRootInput) {
  await frameDirectory(rootInput, 1);
  const checks = createChecks();
  const { manifest, manifestPath, target } = await loadManifest(repositoryRoot);
  const forkRoot = resolveForkRoot(forkRootInput, repositoryRoot);
  const forkHead = runSync("git", ["-C", forkRoot, "rev-parse", "HEAD"]);
  const upstreamTagCommit = runSync("git", [
    "-C",
    forkRoot,
    "rev-parse",
    "v1.17.11^{commit}",
  ]);
  const firstPatchParent = runSync("git", [
    "-C",
    forkRoot,
    "rev-parse",
    `${PATCH_COMMITS[0]}^`,
  ]);
  const forkTagCommit = runSync("git", [
    "-C",
    forkRoot,
    "rev-parse",
    `${FORK_TAG}^{commit}`,
  ]);
  const forkPatchCommits = runSync("git", [
    "-C",
    forkRoot,
    "rev-list",
    "--reverse",
    `${UPSTREAM_COMMIT}..${FORK_COMMIT}`,
  ]).split("\n").filter(Boolean);

  checks.expect(
    manifest.schemaVersion === 1,
    "distribution manifest schema is exactly version 1",
  );
  checks.expect(
    manifest.sourceRepository
      === "https://github.com/artreimus/AgencyAI-OpenCode",
    "manifest selects the reviewed AgencyAI OpenCode fork",
    manifest.sourceRepository,
  );
  checks.expect(
    manifest.upstreamTag === "v1.17.11"
      && manifest.upstreamCommit === UPSTREAM_COMMIT,
    "manifest pins exact upstream tag and commit",
    {
      tag: manifest.upstreamTag,
      commit: manifest.upstreamCommit,
    },
  );
  checks.expect(
    manifest.forkCommit === FORK_COMMIT
      && manifest.forkTag === FORK_TAG
      && JSON.stringify(manifest.patchCommits) === JSON.stringify(PATCH_COMMITS),
    "manifest pins the complete reviewed immutable fork patch queue",
    {
      forkCommit: manifest.forkCommit,
      forkTag: manifest.forkTag,
      patchCommits: manifest.patchCommits,
    },
  );
  checks.expect(
    forkHead === FORK_COMMIT
      && forkTagCommit === FORK_COMMIT
      && upstreamTagCommit === UPSTREAM_COMMIT
      && firstPatchParent === UPSTREAM_COMMIT
      && JSON.stringify(forkPatchCommits) === JSON.stringify(PATCH_COMMITS),
    "local fork checkout proves the exact linear ancestry",
    {
      upstream: upstreamTagCommit,
      tag: FORK_TAG,
      fork: forkHead,
      patchCommits: forkPatchCommits,
    },
  );
  checks.expect(
    manifest.binaryVersion === VERSION
      && manifest.sdkVersion === VERSION
      && target.opencode.version === VERSION,
    "binary and SDK compatibility versions all equal 1.17.11",
  );

  const constants = JSON.parse(
    await readFile(join(repositoryRoot, "constants.json"), "utf8"),
  );
  checks.expect(
    String(constants.opencodeVersion).replace(/^v/, "") === VERSION,
    "root OpenCode version agrees with the distribution",
    constants.opencodeVersion,
  );
  const consumers = [];
  for (const consumer of manifest.sdkConsumers) {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, consumer, "package.json"), "utf8"),
    );
    const sdk = packageDependency(packageJson, "@opencode-ai/sdk");
    checks.expect(
      sdk === VERSION,
      `${consumer} pins the exact OpenCode SDK version`,
      sdk,
    );
    consumers.push({ consumer, sdk });
  }

  return {
    passed: true,
    frame: 1,
    checks: checks.list,
    evidence: {
      manifest: basename(manifestPath),
      sourceRepository: manifest.sourceRepository,
      upstream: {
        tag: manifest.upstreamTag,
        commit: manifest.upstreamCommit,
      },
      fork: {
        commit: manifest.forkCommit,
        tag: manifest.forkTag,
        patchset: manifest.patchset,
        patchCommits: manifest.patchCommits,
      },
      versions: {
        binary: manifest.binaryVersion,
        sdk: manifest.sdkVersion,
        consumers,
      },
    },
  };
}

async function frameTwo(rootInput, repositoryRoot) {
  const { root, directory } = await frameDirectory(rootInput, 2);
  const checks = createChecks();
  const { manifest, target, distributionModule } =
    await loadManifest(repositoryRoot);
  const artifacts = await extractVerifiedArtifacts(root, manifest, target);

  const hashes = {
    archive: await sha256File(artifacts.archivePath),
    binary: await sha256File(artifacts.opencodeBinary),
    provenance: await sha256File(artifacts.provenancePath),
    spdx: await sha256File(artifacts.spdxPath),
    cycloneDx: await sha256File(artifacts.cycloneDxPath),
    buildSourceCycloneDx: await sha256File(
      artifacts.buildSourceCycloneDxPath,
    ),
    ripgrepArchive: await sha256File(artifacts.ripgrepArchivePath),
    ripgrepBinary: await sha256File(artifacts.ripgrepBinary),
  };
  const expected = {
    archive: target.opencode.sourceArchiveSha256,
    binary: target.opencode.sourceBinarySha256,
    provenance: target.opencode.provenanceSha256,
    spdx: target.opencode.spdxSha256,
    cycloneDx: target.opencode.cycloneDxSha256,
    buildSourceCycloneDx: target.opencode.buildSourceCycloneDxSha256,
    ripgrepArchive: target.ripgrep.sourceArchiveSha256,
    ripgrepBinary: target.ripgrep.sourceBinarySha256,
  };
  for (const [name, expectedHash] of Object.entries(expected)) {
    checks.expect(
      hashes[name] === expectedHash,
      `${name} matches the reviewed SHA-256`,
      hashes[name],
    );
  }

  const verifiedOpenCode = distributionModule.verifyOpencodeBinarySync(
    artifacts.opencodeBinary,
    target.opencode,
  );
  const verifiedRipgrep = distributionModule.verifyRipgrepBinarySync(
    artifacts.ripgrepBinary,
    target.ripgrep,
  );
  checks.expect(
    verifiedOpenCode.source === "bundled-patched"
      && verifiedOpenCode.version === VERSION,
    "extracted OpenCode identifies as the reviewed bundled-patched 1.17.11 binary",
    {
      source: verifiedOpenCode.source,
      version: verifiedOpenCode.version,
    },
  );
  checks.expect(
    verifiedRipgrep.version === manifest.toolchain.ripgrep.version,
    "packaged ripgrep identifies as the reviewed toolchain version",
    verifiedRipgrep.version,
  );

  const provenance = JSON.parse(
    await readFile(artifacts.provenancePath, "utf8"),
  );
  checks.expect(
    provenance.schemaVersion === 2
      && provenance.upstream?.commit === UPSTREAM_COMMIT
      && provenance.fork?.commit === FORK_COMMIT
      && provenance.fork?.tag === FORK_TAG
      && JSON.stringify(provenance.fork?.patchCommits)
        === JSON.stringify(PATCH_COMMITS)
      && String(provenance.workflow?.runId) === String(WORKFLOW_RUN_ID)
      && provenance.workflow?.url
        === `https://github.com/artreimus/AgencyAI-OpenCode/actions/runs/${WORKFLOW_RUN_ID}`
      && provenance.target === TARGET,
    "provenance binds the artifact to exact source, workflow, and target",
    provenance,
  );
  const spdx = JSON.parse(await readFile(artifacts.spdxPath, "utf8"));
  const cycloneDx = JSON.parse(
    await readFile(artifacts.cycloneDxPath, "utf8"),
  );
  const buildSourceCycloneDx = JSON.parse(
    await readFile(artifacts.buildSourceCycloneDxPath, "utf8"),
  );
  checks.expect(
    spdx.spdxVersion === "SPDX-2.3"
      && JSON.stringify(spdx).includes(target.opencode.sourceBinarySha256),
    "SPDX SBOM identifies the exact binary hash",
  );
  checks.expect(
    cycloneDx.bomFormat === "CycloneDX"
      && JSON.stringify(cycloneDx).includes(target.opencode.sourceBinarySha256),
    "binary CycloneDX SBOM identifies the exact binary hash",
  );
  checks.expect(
    buildSourceCycloneDx.bomFormat === "CycloneDX",
    "build-source CycloneDX SBOM is present and parseable",
  );

  const searchRoot = join(directory, "rg-smoke");
  await mkdir(searchRoot, { recursive: true });
  await writeFile(
    join(searchRoot, "proof.txt"),
    "AgencyAI packaged ripgrep proof\n",
    "utf8",
  );
  const rgOutput = runSync(
    artifacts.ripgrepBinary,
    ["-n", "packaged ripgrep", searchRoot],
  );
  checks.expect(
    rgOutput.includes("AgencyAI packaged ripgrep proof"),
    "verified packaged ripgrep executes a local search",
  );

  return {
    passed: true,
    frame: 2,
    checks: checks.list,
    evidence: {
      target: TARGET,
      workflowRunId: WORKFLOW_RUN_ID,
      hashes,
      versions: {
        opencode: verifiedOpenCode.version,
        ripgrep: verifiedRipgrep.version,
      },
      sboms: ["SPDX-2.3", "CycloneDX binary", "CycloneDX build source"],
      packagedRipgrepSmoke: "matched local proof text",
    },
  };
}

async function copyVerifiedRuntime(artifacts, desktopRoot) {
  const sidecarDir = join(desktopRoot, "resources", "sidecars");
  const toolchainDir = join(
    desktopRoot,
    "resources",
    "toolchain",
    TARGET,
  );
  await mkdir(sidecarDir, { recursive: true });
  await mkdir(toolchainDir, { recursive: true });
  const opencode = join(sidecarDir, `opencode-${TARGET}`);
  const ripgrep = join(toolchainDir, "rg");
  await copyFile(artifacts.opencodeBinary, opencode);
  await copyFile(artifacts.ripgrepBinary, ripgrep);
  await chmod(opencode, 0o755);
  await chmod(ripgrep, 0o755);
  return { opencode, ripgrep, toolchainDir };
}

function localProductPolicy(features) {
  return Object.freeze({
    profile: "local-mvp",
    features: Object.freeze({
      ...features,
      browserAutomation: false,
      computerUse: false,
    }),
    networkPolicy: "user-authorized",
    rendererOrigin: RENDERER_ORIGIN,
  });
}

async function frameThree(rootInput, repositoryRoot) {
  const { root, directory } = await frameDirectory(rootInput, 3);
  const checks = createChecks();
  const [
    { manifest, target, distributionModule },
    runtimeModule,
    storageModule,
    productContract,
    opencodePolicy,
  ] = await Promise.all([
    loadManifest(repositoryRoot),
    import(MODULES.runtime),
    import(MODULES.storageLayout),
    import(MODULES.productContract),
    import(MODULES.opencodePolicy),
  ]);
  const artifacts = await extractVerifiedArtifacts(root, manifest, target);
  const desktopRoot = join(directory, "desktop");
  const packaged = await copyVerifiedRuntime(artifacts, desktopRoot);
  const pluginRoot = join(
    directory,
    "server",
    "dist",
    "opencode-plugins",
  );
  await mkdir(pluginRoot, { recursive: true });
  for (const name of opencodePolicy.AGENCYAI_LOCAL_OPENCODE_PLUGIN_NAMES) {
    await writeFile(
      join(pluginRoot, `${name}.js`),
      "export default {};\n",
      "utf8",
    );
  }
  const home = join(directory, "home");
  const appData = join(home, "Library", "Application Support");
  await mkdir(appData, { recursive: true });
  const storageLayout = storageModule.resolveStorageLayout({
    appDataPath: appData,
    appIdentifier: "com.artreimus.agencyai",
    platform: "darwin",
  });
  const app = {
    getPath(name) {
      if (name === "userData") return storageLayout.userData;
      if (name === "exe") return join(directory, "AgencyAI");
      if (name === "home") return home;
      throw new Error(`unexpected app path ${name}`);
    },
  };
  const baseOptions = {
    app,
    desktopRoot,
    listLocalWorkspacePaths: async () => [],
    storageLayout,
    storageEnvironment:
      storageModule.storageLayoutEnvironment(storageLayout),
    allowRemoteAccess: false,
    productPolicy: localProductPolicy(
      productContract.LOCAL_MVP_FEATURES,
    ),
    opencodeDistribution: manifest,
    trustedRendererOrigin: RENDERER_ORIGIN,
  };
  const runtime = runtimeModule.createRuntimeManager(baseOptions);
  const doctor = runtime.engineDoctor();
  checks.expect(
    doctor.found === true
      && doctor.resolvedSource === "bundled-patched"
      && doctor.version === VERSION
      && doctor.supportsServe === true,
    "runtime doctor accepts the exact verified bundled OpenCode binary",
    {
      found: doctor.found,
      source: doctor.resolvedSource,
      version: doctor.version,
      supportsServe: doctor.supportsServe,
    },
  );
  checks.expect(
    resolve(doctor.resolvedPath) === resolve(packaged.opencode),
    "runtime doctor resolves only the packaged sidecar",
  );
  const verifiedRg = distributionModule.resolveVerifiedRipgrepSync({
    toolchainDirs: [packaged.toolchainDir],
    asset: target.ripgrep,
  });
  checks.expect(
    verifiedRg.binarySha256 === target.ripgrep.sourceBinarySha256,
    "runtime resolves the exact packaged ripgrep tool",
    verifiedRg.binarySha256,
  );

  const globalBinDir = join(directory, "global-bin");
  await mkdir(globalBinDir, { recursive: true });
  const globalBinary = join(globalBinDir, "opencode");
  await writeFile(
    globalBinary,
    "#!/bin/sh\nprintf '%s\\n' '1.17.11'\n",
    "utf8",
  );
  await chmod(globalBinary, 0o755);
  const customDoctor = runtime.engineDoctor({
    opencodeBinPath: globalBinary,
  });
  checks.expect(
    customDoctor.found === false
      && customDoctor.notes.some((note) =>
        note.includes("Custom OpenCode paths are disabled")
      ),
    "custom OpenCode paths fail closed",
    customDoctor.notes,
  );

  const missingDesktopRoot = join(directory, "desktop-without-sidecar");
  await mkdir(missingDesktopRoot, { recursive: true });
  const previousPath = process.env.PATH;
  process.env.PATH = `${globalBinDir}${delimiter}${previousPath ?? ""}`;
  try {
    const missingRuntime = runtimeModule.createRuntimeManager({
      ...baseOptions,
      desktopRoot: missingDesktopRoot,
    });
    const missingDoctor = missingRuntime.engineDoctor();
    checks.expect(
      missingDoctor.found === false
        && missingDoctor.inPath === false
        && missingDoctor.resolvedSource === null,
      "missing bundled OpenCode does not fall back to PATH or global installs",
      {
        found: missingDoctor.found,
        inPath: missingDoctor.inPath,
        source: missingDoctor.resolvedSource,
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  const install = await runtime.engineInstall();
  checks.expect(
    install.ok === false
      && install.status === -1
      && install.stderr.includes("installation is disabled"),
    "guided and silent engine installation is disabled",
    {
      ok: install.ok,
      status: install.status,
      message: install.stderr,
    },
  );

  return {
    passed: true,
    frame: 3,
    checks: checks.list,
    evidence: {
      accepted: {
        engineSource: doctor.resolvedSource,
        engineVersion: doctor.version,
        engineSha256: target.opencode.sourceBinarySha256,
        ripgrepSha256: verifiedRg.binarySha256,
      },
      denied: [
        "custom path",
        "global install",
        "PATH fallback",
        "guided installer",
        "silent installer",
      ],
    },
  };
}

async function frameFour(rootInput, repositoryRoot) {
  const { directory } = await frameDirectory(rootInput, 4);
  const checks = createChecks();
  const runtimeModule = await import(MODULES.runtime);
  const toolchainDir = join(directory, "packaged-toolchain");
  const environment = runtimeModule.buildLocalMvpOpenCodeChildEnv({
    userEnv: {
      NOTION_TOKEN: "intentional-user-value",
      OPENAI_API_KEY: "intentional-openai-key",
      OLLAMA_HOST: "http://127.0.0.1:11434",
      CUSTOM_PROVIDER_BASE_URL: "http://127.0.0.1:11434/v1",
      MCP_GITHUB_TOKEN: "intentional-mcp-token",
      OPENCODE_MODELS_URL: "https://user-override.invalid",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user-telemetry.invalid",
    },
    parentEnv: {
      HOME: join(directory, "home"),
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "intentional-provider-key",
      GITHUB_TOKEN: "ambient-token",
      NODE_OPTIONS: "--require /tmp/injected.js",
      OPENWORK_TOKEN: "ambient-openwork-token",
      OPENCODE_CONFIG: "/tmp/ambient-opencode.json",
      OPENCODE_CONFIG_CONTENT: "{\"share\":\"auto\"}",
      OPENCODE_CONFIG_DIR: "/tmp/ambient-config-dir",
      OPENCODE_MODELS_URL: "https://models.invalid",
      OPENCODE_MODELS_PATH: "/tmp/models.json",
      OPENCODE_DB: "/tmp/ambient-opencode.db",
      OPENCODE_PERMISSION: "allow",
      OPENCODE_AUTO_SHARE: "true",
      OPENCODE_ALWAYS_NOTIFY_UPDATE: "true",
      OPENCODE_EXPERIMENTAL: "true",
      OPENCODE_ENABLE_EXA: "true",
      OPENCODE_EXPERIMENTAL_EXA: "true",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "false",
      OPENCODE_CONSOLE_TOKEN: "ambient-console-token",
      OPENCODE_SERVER_USERNAME: "ambient-user",
      OPENCODE_SERVER_PASSWORD: "ambient-password",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=ambient",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=ambient",
    },
    caEnv: { NODE_EXTRA_CA_CERTS: join(directory, "system-ca.pem") },
    extra: {
      OPENWORK_SERVER_URL: "http://127.0.0.1:48000",
      OPENCODE_SERVER_USERNAME: "generated-user",
      OPENCODE_SERVER_PASSWORD: "generated-password",
      OPENCODE_ENABLE_EXA: "true",
      OPENCODE_AUTO_SHARE: "true",
    },
    storageEnvironment: {
      XDG_CONFIG_HOME: join(directory, "agencyai", "config"),
      XDG_DATA_HOME: join(directory, "agencyai", "data"),
      OPENCODE_CONFIG_DIR: join(
        directory,
        "agencyai",
        "config",
        "opencode",
      ),
      OPENCODE_DB: join(
        directory,
        "agencyai",
        "data",
        "opencode.sqlite",
      ),
    },
    toolchainDir,
  });

  for (const name of [
    "NOTION_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OLLAMA_HOST",
    "CUSTOM_PROVIDER_BASE_URL",
    "MCP_GITHUB_TOKEN",
    "OPENWORK_SERVER_URL",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DB",
  ]) {
    checks.expect(
      typeof environment[name] === "string" && environment[name].length > 0,
      `${name} intentionally remains in the child environment`,
    );
  }
  const scrubbed = [
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "OPENWORK_TOKEN",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_MODELS_URL",
    "OPENCODE_MODELS_PATH",
    "OPENCODE_PERMISSION",
    "OPENCODE_AUTO_SHARE",
    "OPENCODE_ALWAYS_NOTIFY_UPDATE",
    "OPENCODE_EXPERIMENTAL",
    "OPENCODE_EXPERIMENTAL_EXA",
    "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
    "OPENCODE_CONSOLE_TOKEN",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
  ];
  for (const name of scrubbed) {
    checks.expect(
      environment[name] === undefined,
      `${name} is scrubbed from inherited/user policy overrides`,
    );
  }
  const forced = {
    OPENCODE_DISABLE_RUNTIME_DOWNLOADS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_SHARE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_ENABLE_EXA: "false",
  };
  for (const [name, value] of Object.entries(forced)) {
    checks.expect(
      environment[name] === value,
      `${name} is forced to ${value}`,
      environment[name],
    );
  }
  checks.expect(
    String(environment.PATH).split(delimiter)[0] === toolchainDir,
    "packaged toolchain is first on PATH",
    String(environment.PATH).split(delimiter)[0],
  );

  return {
    passed: true,
    frame: 4,
    checks: checks.list,
    evidence: {
      preserved: [
        "AgencyAI storage",
        "generated loopback credentials",
        "direct provider credentials",
        "Ollama/local provider endpoint",
        "explicit MCP credential",
      ],
      scrubbed,
      forced,
      pathPrecedence: "verified packaged toolchain first",
    },
  };
}

async function frameFive(rootInput, repositoryRoot, forkRootInput) {
  const { directory } = await frameDirectory(rootInput, 5);
  const checks = createChecks();
  const forkRoot = resolveForkRoot(forkRootInput, repositoryRoot);
  const forkHead = runSync("git", ["-C", forkRoot, "rev-parse", "HEAD"]);
  checks.expect(
    forkHead === FORK_COMMIT,
    "empty-cache proof runs against the exact reviewed fork commit",
    forkHead,
  );

  const sourceFiles = {
    npm: await readFile(join(forkRoot, "packages/core/src/npm.ts"), "utf8"),
    flag: await readFile(
      join(forkRoot, "packages/core/src/flag/flag.ts"),
      "utf8",
    ),
    plugin: await readFile(
      join(forkRoot, "packages/opencode/src/plugin/shared.ts"),
      "utf8",
    ),
    provider: await readFile(
      join(forkRoot, "packages/opencode/src/provider/provider.ts"),
      "utf8",
    ),
    formatter: await readFile(
      join(forkRoot, "packages/opencode/src/format/formatter.ts"),
      "utf8",
    ),
    lsp: await readFile(
      join(forkRoot, "packages/opencode/src/lsp/server.ts"),
      "utf8",
    ),
  };
  checks.expect(
    sourceFiles.flag.includes("OPENCODE_DISABLE_RUNTIME_DOWNLOADS")
      && sourceFiles.npm.includes("RuntimeDownloadDisabledError"),
    "fork exposes a typed runtime-download kill switch",
  );
  const fallbackFamilies = {
    plugin: /Npm\.add\(pkg\)/.test(sourceFiles.plugin),
    providerSdk: /Npm\.add\(model\.api\.npm\)/.test(sourceFiles.provider),
    formatter: /Npm\.which\(/.test(sourceFiles.formatter),
    languageServer: /Npm\.which\(/.test(sourceFiles.lsp),
    executableFallback: /const which[\s\S]*OPENCODE_DISABLE_RUNTIME_DOWNLOADS/
      .test(sourceFiles.npm),
  };
  for (const [family, mapped] of Object.entries(fallbackFamilies)) {
    checks.expect(
      mapped,
      `${family} fallback is routed through the guarded Npm boundary`,
    );
  }

  const registryRequests = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      registryRequests.push({
        method: request.method,
        path: url.pathname,
      });
      return Response.json(
        { code: "unexpected_registry_request" },
        { status: 503 },
      );
    },
  });
  const environmentRoot = join(directory, "empty-runtime");
  const environment = {
    ...process.env,
    HOME: join(environmentRoot, "home"),
    XDG_DATA_HOME: join(environmentRoot, "data"),
    XDG_STATE_HOME: join(environmentRoot, "state"),
    XDG_CONFIG_HOME: join(environmentRoot, "config"),
    XDG_CACHE_HOME: join(environmentRoot, "cache"),
    npm_config_cache: join(environmentRoot, "npm-cache"),
    npm_config_registry: `http://127.0.0.1:${registry.port}/`,
    BUN_INSTALL_CACHE_DIR: join(environmentRoot, "bun-cache"),
    OPENCODE_DISABLE_RUNTIME_DOWNLOADS: "true",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const path of [
    environment.HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_CACHE_HOME,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  let testRun;
  try {
    testRun = await runAsync(
      "bun",
      [
        "test",
        "test/npm.test.ts",
        "--test-name-pattern",
        "runtime downloads are disabled|runtime download",
      ],
      {
        cwd: join(forkRoot, "packages", "core"),
        env: environment,
      },
    );
  } finally {
    registry.stop(true);
  }
  const testOutput = `${testRun.stdout}\n${testRun.stderr}`;
  checks.expect(
    /5 pass/.test(testOutput)
      && /0 fail/.test(testOutput),
    "five guarded empty-cache/package-mutation tests pass",
  );
  checks.expect(
    registryRequests.length === 0,
    "monitored local package registry receives zero requests",
    registryRequests,
  );
  checks.expect(
    !existsSync(environment.npm_config_cache),
    "empty external package cache remains uncreated",
  );
  for (const assertion of [
    "fails before creating a package cache on a runtime download",
    "fails before creating node_modules when runtime downloads are disabled",
    "fails before deleting the package lock on a runtime download",
  ]) {
    checks.expect(
      testOutput.includes(assertion),
      `${assertion} is observed`,
    );
  }

  return {
    passed: true,
    frame: 5,
    checks: checks.list,
    evidence: {
      forkCommit: forkHead,
      fallbackFamilies,
      emptyCacheTests: {
        passed: 5,
        failed: 0,
        registryRequests: 0,
        externalPackageCacheCreated: false,
        mutationGuards: [
          "package cache not created",
          "node_modules not created",
          "package lock not deleted",
        ],
      },
    },
  };
}

function nestedKeys(value) {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...nestedKeys(entry),
  ]);
}

function startEngineTrap() {
  const requests = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      if (url.pathname === "/global/health") {
        return Response.json({ healthy: true, version: VERSION });
      }
      if (url.pathname === "/provider") {
        return Response.json({
          providers: [
            { id: "anthropic", name: "Anthropic" },
            { id: "ollama", name: "Ollama" },
            { id: "openai-compatible", name: "Local compatible endpoint" },
          ],
          default: {},
        });
      }
      if (url.pathname === "/mcp") {
        return Response.json({
          github: { status: "connected" },
        });
      }
      if (url.pathname === "/session") return Response.json([]);
      if (url.pathname === "/agent") {
        return Response.json([
          { name: "agencyai", tools: { read: true, write: true, bash: true } },
        ]);
      }
      return Response.json({ ok: true });
    },
  });
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

function applyServerEnvironment(directory, trapBaseUrl) {
  const previous = new Map(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    OPENWORK_RUNTIME_DB: join(directory, "runtime.sqlite"),
    OPENWORK_TOKEN_STORE: join(directory, "tokens.json"),
    OPENWORK_ENV_STORE: join(directory, "env.json"),
    OPENWORK_MCP_AUTH_PATH: join(directory, "mcp-auth.json"),
    OPENWORK_DATA_DIR: join(directory, "data"),
    OPENCODE_CONFIG_DIR: join(directory, "opencode-config"),
    OPENCODE_DB: join(directory, "opencode.db"),
    OPENWORK_CONTROL_BASE_URL: `${trapBaseUrl}/disabled-control`,
    OPENWORK_CONTROL_TOKEN: "agencyai-pr04-control-token",
    OPENWORK_GITHUB_API_BASE: `${trapBaseUrl}/disabled-github-api`,
    OPENWORK_GITHUB_RAW_BASE: `${trapBaseUrl}/disabled-github-raw`,
    OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL:
      `${trapBaseUrl}/disabled-google`,
    OPENWORK_API_KEY: PROVIDER_SECRET,
    OPENWORK_INFERENCE_BASE_URL: `${trapBaseUrl}/disabled-inference`,
    OPENWORK_TOY_UI: "0",
    OPENWORK_BROWSER_PROVIDER: "none",
    OPENWORK_SANDBOX_BACKEND: "none",
    OPENWORK_SANDBOX_ENABLED: "0",
    OPENWORK_DEV_LOG_FILE: join(directory, "renderer.jsonl"),
  });
  delete process.env.OPENWORK_STORAGE_ROOT;
  delete process.env.OPENWORK_SERVER_CONFIG;
  delete process.env.OPENWORK_WEB_ROOT;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function clientHeaders() {
  return { authorization: `Bearer ${CLIENT_TOKEN}` };
}

async function responseValue(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function frameSix(rootInput, repositoryRoot) {
  const { directory } = await frameDirectory(rootInput, 6);
  const trap = startEngineTrap();
  const restoreEnvironment = applyServerEnvironment(directory, trap.baseUrl);
  let server = null;
  try {
    const [
      { manifest, target, distributionModule },
      serverModule,
      productContract,
      generatedConfigModule,
    ] = await Promise.all([
      loadManifest(repositoryRoot),
      import(MODULES.server),
      import(MODULES.productContract),
      import(MODULES.generatedConfig),
    ]);
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, ".opencode"), { recursive: true });
    await writeFile(
      join(workspace, ".opencode", "opencode.jsonc"),
      "{}\n",
      "utf8",
    );
    const provenance = distributionModule.opencodeReadinessProvenance(
      manifest,
      target.opencode,
    );
    const config = {
      host: "127.0.0.1",
      port: 0,
      token: CLIENT_TOKEN,
      hostToken: HOST_TOKEN,
      configPath: join(directory, "server.json"),
      opencodeBaseUrl: trap.baseUrl,
      opencodeDirectory: workspace,
      opencodeUsername: "agencyai-pr04-engine",
      opencodePassword: OPENCODE_PASSWORD,
      approval: { mode: "manual", timeoutMs: 250 },
      corsOrigins: [RENDERER_ORIGIN],
      workspaces: [{
        id: WORKSPACE_ID,
        name: "PR04 Local Workspace",
        path: workspace,
        preset: "starter",
        workspaceType: "local",
        baseUrl: trap.baseUrl,
        directory: workspace,
      }],
      authorizedRoots: [workspace],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "generated",
      hostTokenSource: "generated",
      logFormat: "pretty",
      logRequests: false,
      productPolicy: localProductPolicy(
        productContract.LOCAL_MVP_FEATURES,
      ),
      opencodeDistribution: provenance,
    };
    server = await serverModule.startServer(config);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const checks = createChecks();
    const readyResponse = await fetch(`${baseUrl}/ready`, {
      headers: clientHeaders(),
    });
    const ready = await responseValue(readyResponse);
    assert(isRecord(ready), "readiness response was not an object");
    const opencode = isRecord(ready.opencode) ? ready.opencode : {};
    checks.expect(
      readyResponse.status === 200 && ready.ready === true,
      "authenticated readiness reports ready",
      readyResponse.status,
    );
    checks.expect(
      opencode.healthy === true
        && opencode.version === VERSION
        && opencode.source === "bundled-patched",
      "readiness reports healthy bundled-patched OpenCode 1.17.11",
      {
        healthy: opencode.healthy,
        version: opencode.version,
        source: opencode.source,
      },
    );
    checks.expect(
      opencode.binarySha256 === target.opencode.sourceBinarySha256
        && opencode.upstreamCommit === UPSTREAM_COMMIT
        && opencode.forkCommit === FORK_COMMIT
        && opencode.patchset === manifest.patchset,
      "readiness exposes the reviewed non-secret binary and source provenance",
      {
        binarySha256: opencode.binarySha256,
        upstreamCommit: opencode.upstreamCommit,
        forkCommit: opencode.forkCommit,
        patchset: opencode.patchset,
      },
    );
    const forbiddenKeys = nestedKeys(ready).filter((key) =>
      /token|port|path|workspace|provider|secret|credential|baseurl|directory/i
        .test(key)
    );
    checks.expect(
      forbiddenKeys.length === 0,
      "readiness contains no path, port, credential, provider, or workspace keys",
      forbiddenKeys,
    );
    const serialized = JSON.stringify(ready);
    const leakedValues = [
      CLIENT_TOKEN,
      HOST_TOKEN,
      OPENCODE_PASSWORD,
      PROVIDER_SECRET,
      directory,
      workspace,
      "PR04 Local Workspace",
    ].filter((value) => serialized.includes(value));
    checks.expect(
      leakedValues.length === 0,
      "readiness exposes no token, path, provider secret, or workspace name",
      leakedValues,
    );

    const generated =
      generatedConfigModule.buildOpenworkRuntimeConfigObjectFromSnapshot({
        provider: {
          anthropic: {
            name: "Anthropic",
            npm: "@ai-sdk/anthropic",
            options: {},
          },
          ollama: {
            name: "Ollama",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:11434/v1" },
          },
          compatible: {
            name: "Compatible local endpoint",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:8080/v1" },
          },
        },
        mcp: {
          github: {
            type: "remote",
            url: "https://github.example.invalid/mcp",
            enabled: true,
          },
        },
      }, true);
    checks.expect(
      isRecord(generated.provider)
        && ["anthropic", "ollama", "compatible"].every((name) =>
          isRecord(generated.provider[name])
        ),
      "generated local config preserves direct, Ollama, and compatible providers",
    );
    checks.expect(
      isRecord(generated.mcp) && isRecord(generated.mcp.github),
      "generated local config preserves an explicitly configured ordinary MCP",
    );

    const localApis = [
      { family: "providers", path: "/provider" },
      { family: "sessions", path: "/session" },
      { family: "tools", path: "/agent" },
      { family: "ordinary MCP", path: "/mcp" },
    ];
    const localEvidence = [];
    for (const api of localApis) {
      const response = await fetch(
        `${baseUrl}/workspace/${WORKSPACE_ID}/opencode${api.path}`,
        { headers: clientHeaders() },
      );
      const body = await responseValue(response);
      checks.expect(
        response.status === 200,
        `${api.family} API remains available`,
        response.status,
      );
      localEvidence.push({
        family: api.family,
        status: response.status,
        response: body,
      });
    }
    checks.expect(
      trap.requests.every((entry) =>
        ["/global/health", "/provider", "/session", "/agent", "/mcp"]
          .includes(entry.path)
      ),
      "request audit contains only the expected loopback engine paths",
      trap.requests,
    );

    return {
      passed: true,
      frame: 6,
      checks: checks.list,
      evidence: {
        readiness: {
          ready: true,
          version: opencode.version,
          healthy: opencode.healthy,
          source: opencode.source,
          binarySha256: opencode.binarySha256,
          upstreamCommit: opencode.upstreamCommit,
          forkCommit: opencode.forkCommit,
          patchset: opencode.patchset,
          secretScan: [],
        },
        preserved: [
          "direct providers",
          "Ollama",
          "compatible local endpoint",
          "sessions",
          "tools",
          "ordinary MCP",
        ],
        localApis: localEvidence.map(({ family, status }) => ({
          family,
          status,
        })),
      },
    };
  } finally {
    await server?.stop(true);
    trap.server.stop(true);
    restoreEnvironment();
  }
}

const FRAME_RUNNERS = new Map([
  [1, frameOne],
  [2, frameTwo],
  [3, frameThree],
  [4, frameFour],
  [5, frameFive],
  [6, frameSix],
]);

function resultLine(value) {
  return `${RESULT_MARKER}${JSON.stringify(value)}\n`;
}

async function main() {
  const mode = process.argv[2] ?? "";
  if (mode === "list") {
    process.stdout.write(
      `${stableJson({ passed: true, frames: FRAME_DEFINITIONS })}\n`,
    );
    return;
  }
  const frame = Number(mode);
  const root = process.argv[3] ?? "";
  const repositoryRoot = resolve(process.argv[4] ?? "");
  const forkRoot = process.argv[5] ?? "";
  const runner = FRAME_RUNNERS.get(frame);
  if (!runner || !repositoryRoot) {
    throw new Error(
      "usage: agencyai-pr04-opencode-distribution-fixture.mjs list|1|2|3|4|5|6 <fixture-root> <repository-root> [fork-root]",
    );
  }
  const result = await runner(root, repositoryRoot, forkRoot);
  process.stdout.write(resultLine(result));
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
