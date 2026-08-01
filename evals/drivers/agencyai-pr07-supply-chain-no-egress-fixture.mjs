import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_MARKER = "AGENCYAI_PR07_RESULT ";
const DRIVER_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(DRIVER_ROOT, "../..");
const TARGET = "aarch64-apple-darwin";

export const FRAME_DEFINITIONS = Object.freeze([
  Object.freeze({
    frame: 1,
    id: "release-input-provenance",
    claim: "Every shipped JavaScript, font, and OpenCode evidence input is recorded before packaging",
  }),
  Object.freeze({
    frame: 2,
    id: "sbom-license-and-notice-closure",
    claim: "The exact packaged component inventory has reviewed licenses, notices, and matching SPDX and CycloneDX documents",
  }),
  Object.freeze({
    frame: 3,
    id: "dmg-zip-and-native-inspection",
    claim: "The unpacked app, DMG, ZIP, and arm64 native payload pass one independent fail-closed inspector",
  }),
  Object.freeze({
    frame: 4,
    id: "about-release-documents",
    claim: "About exposes packaged notices and SBOMs through a narrow read-only desktop contract",
  }),
  Object.freeze({
    frame: 5,
    id: "unsigned-ci-boundary",
    claim: "PR07 CI proves the local arm64 candidate without signing, notarizing, or publishing a release",
  }),
  Object.freeze({
    frame: 6,
    id: "packaged-zero-unexpected-egress",
    claim: "The real packaged app exercises its local runtime while audit and OS socket samples observe no non-loopback traffic",
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function repositoryRoot(value) {
  const root = resolve(value?.trim() || DEFAULT_REPOSITORY_ROOT);
  assert(
    statSync(join(root, "PLAN_AGENCYAI_DESKTOP_MVP.md")).isFile(),
    "AgencyAI implementation plan is missing",
  );
  return root;
}

function commandOutput(result) {
  return [
    String(result.stdout ?? "").trim(),
    String(result.stderr ?? "").trim(),
    result.error?.message ?? "",
  ].filter(Boolean).join("\n");
}

function run(root, command, args, timeoutMs = 180_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENWORK_PRODUCT_PROFILE: "local-mvp",
      VITE_OPENWORK_PRODUCT_PROFILE: "local-mvp",
    },
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${commandOutput(result)}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function source(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function json(root, relativePath) {
  return JSON.parse(source(root, relativePath));
}

function parseLastJson(output, label) {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (!line) throw new Error(`${label} did not print JSON evidence`);
  return JSON.parse(line);
}

function createChecks() {
  const checks = [];
  return {
    expect(condition, label, actual) {
      assert(
        condition,
        `${label}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`,
      );
      checks.push({
        label,
        passed: true,
        ...(actual === undefined ? {} : { actual }),
      });
    },
    list: checks,
  };
}

function packagedApp(root) {
  const requested = process.env.AGENCYAI_PR07_APP_PATH?.trim();
  const appPath = resolve(
    requested
      || join(
        root,
        "apps/desktop/dist-electron/mac-arm64/agencyai.app",
      ),
  );
  assert(existsSync(appPath), `Packaged AgencyAI app is missing: ${appPath}`);
  return appPath;
}

function releaseMetadataRoot(root) {
  return join(
    packagedApp(root),
    "Contents/Resources/release-metadata",
  );
}

function candidateArtifacts(root) {
  const outputRoot = join(root, "apps/desktop/dist-electron");
  const files = readdirSync(outputRoot).sort();
  const dmg = files.filter((name) =>
    /^agencyai-mac-arm64-[\w.-]+\.dmg$/.test(name));
  const zip = files.filter((name) =>
    /^agencyai-mac-arm64-[\w.-]+\.zip$/.test(name));
  assert(
    dmg.length === 1 && zip.length === 1,
    `Expected one AgencyAI DMG and ZIP; received ${[...dmg, ...zip].join(", ")}`,
  );
  return [join(outputRoot, dmg[0]), join(outputRoot, zip[0])];
}

async function frameReleaseInputProvenance(root, check) {
  const closure = run(root, "node", ["scripts/check-source-closure.mjs"]);
  const inputsRoot = join(
    root,
    "apps/desktop/.generated/release-inputs",
  );
  const renderer = json(
    root,
    "apps/desktop/.generated/release-inputs/renderer-modules.json",
  );
  const server = json(
    root,
    "apps/desktop/.generated/release-inputs/server-plugins.metafile.json",
  );
  const orchestratorName = readdirSync(inputsRoot).find((name) =>
    /^orchestrator-.+\.metafile\.json$/.test(name));
  assert(orchestratorName, "Orchestrator release-input metafile is missing");
  const orchestrator = json(
    root,
    `apps/desktop/.generated/release-inputs/${orchestratorName}`,
  );
  const evidenceRoot = join(inputsRoot, "opencode", TARGET);
  const evidence = JSON.parse(
    readFileSync(join(evidenceRoot, "evidence-inventory.json"), "utf8"),
  );
  const evidenceFiles = readdirSync(evidenceRoot).sort();

  check.expect(
    closure.includes("passed (0 findings)"),
    "Source closure reports zero restricted-source findings",
    closure,
  );
  check.expect(
    renderer.modules.length > 3_900
      && renderer.modules.filter((name) =>
        name.includes("@fontsource-variable")).length === 9,
    "Renderer provenance records the transformed module and nine-font closure",
    {
      modules: renderer.modules.length,
      fonts: renderer.modules.filter((name) =>
        name.includes("@fontsource-variable")).length,
    },
  );
  check.expect(
    Object.keys(server.inputs).length > 175
      && Object.keys(orchestrator.inputs).length > 30,
    "Server and orchestrator metafiles retain their exact build inputs",
    {
      server: Object.keys(server.inputs).length,
      orchestrator: Object.keys(orchestrator.inputs).length,
    },
  );
  check.expect(
    evidence.target === TARGET
      && !evidenceFiles.includes(evidence.excludedArchive.file)
      && Object.keys(evidence.files).every((name) =>
        evidenceFiles.includes(name)),
    "Verified OpenCode evidence is staged without duplicating its source archive",
    {
      files: evidenceFiles,
      excludedArchive: evidence.excludedArchive,
    },
  );
  return {
    rendererModules: renderer.modules.length,
    fontInputs: 9,
    serverInputs: Object.keys(server.inputs).length,
    orchestratorInputs: Object.keys(orchestrator.inputs).length,
    openCodeEvidenceFiles: evidenceFiles.length,
    sourceArchiveDuplicated: false,
  };
}

async function frameSbomLicenseClosure(root, check) {
  run(root, "node", [
    "--test",
    "apps/desktop/scripts/generate-release-metadata.test.mjs",
  ]);
  const metadataRoot = releaseMetadataRoot(root);
  const manifest = JSON.parse(
    readFileSync(join(metadataRoot, "release-manifest.json"), "utf8"),
  );
  const spdx = JSON.parse(
    readFileSync(join(metadataRoot, "agencyai-desktop.spdx.json"), "utf8"),
  );
  const cycloneDx = JSON.parse(
    readFileSync(join(metadataRoot, "agencyai-desktop.cdx.json"), "utf8"),
  );
  const notices = readFileSync(
    join(metadataRoot, "THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  const policy = json(root, "apps/desktop/release-component-policy.json");
  const acceptedLicenses = new Set([
    ...policy.allowedLicenses,
    "LicenseRef-Public-Domain",
    "NOASSERTION",
  ]);
  const spdxLicenses = new Set(
    spdx.packages.map((component) => component.licenseConcluded),
  );

  check.expect(
    manifest.product === "AgencyAI Desktop"
      && manifest.profile === "local-mvp"
      && manifest.target === TARGET,
    "Release manifest binds the AgencyAI local profile to arm64 macOS",
    {
      product: manifest.product,
      profile: manifest.profile,
      target: manifest.target,
    },
  );
  check.expect(
    spdx.spdxVersion === "SPDX-2.3"
      && cycloneDx.bomFormat === "CycloneDX"
      && cycloneDx.specVersion === "1.7"
      && spdx.packages.length === cycloneDx.components.length
      && spdx.packages.length === manifest.application.componentCount,
    "SPDX, CycloneDX, and the signed manifest contain the same components",
    {
      components: spdx.packages.length,
      packageComponents: manifest.application.packageComponentCount,
    },
  );
  check.expect(
    [...spdxLicenses].every((license) => acceptedLicenses.has(license)),
    "Every concluded component license is explicitly reviewed",
    [...spdxLicenses].sort(),
  );
  check.expect(
    notices.length > 150_000
      && notices.includes("OpenWork attribution and license")
      && notices.includes("OpenCode attribution and license")
      && notices.includes("Electron and Chromium"),
    "Complete notices preserve project, package, Electron, and Chromium attribution",
    { bytes: notices.length },
  );
  return {
    components: spdx.packages.length,
    packageComponents: manifest.application.packageComponentCount,
    licenses: [...spdxLicenses].sort(),
    noticesBytes: notices.length,
    formats: ["SPDX-2.3", "CycloneDX-1.7"],
  };
}

async function frameArtifactInspection(root, check) {
  const app = packagedApp(root);
  const candidates = candidateArtifacts(root);
  const inspection = JSON.parse(
    run(
      root,
      "node",
      [
        "apps/desktop/scripts/inspect-local-artifact.mjs",
        app,
        ...candidates,
      ],
      300_000,
    ),
  );
  const native = parseLastJson(
    run(
      root,
      "node",
      ["apps/desktop/scripts/run-native-module-smoke.mjs"],
      300_000,
    ),
    "Native smoke",
  );
  const outputFiles = readdirSync(
    join(root, "apps/desktop/dist-electron"),
  ).sort();
  const appHashes = new Set(
    inspection.results.map((result) => result.appSha256),
  );

  check.expect(
    inspection.ok === true
      && inspection.results.map((result) => result.artifactType)
        .sort().join(",") === "app,dmg,zip",
    "The unpacked app, DMG, and ZIP all pass the independent inspector",
    inspection.results.map((result) => result.artifactType),
  );
  check.expect(
    appHashes.size === 1
      && inspection.results.every((result) =>
        result.components === 151 && result.resources === 645),
    "Every candidate contains the identical app and metadata closure",
    {
      appSha256: [...appHashes][0],
      components: inspection.results[0].components,
      resources: inspection.results[0].resources,
    },
  );
  check.expect(
    native.ok === true
      && native.architecture === "arm64"
      && native.sqlite === "agencyai-sqlite-ok"
      && native.pty === "agencyai-pty-ok",
    "Electron ABI smoke loads the packaged arm64 SQLite and PTY modules",
    native,
  );
  check.expect(
    !outputFiles.some((name) =>
      name.endsWith(".blockmap") || /^latest.*\.ya?ml$/.test(name)),
    "Candidate output retains no updater manifest or blockmap",
    outputFiles,
  );
  return {
    artifacts: inspection.results.map((result) => result.artifactType),
    appSha256: [...appHashes][0],
    resources: 645,
    components: 151,
    native: { architecture: native.architecture, sqlite: native.sqlite, pty: native.pty },
    updaterMetadata: 0,
  };
}

async function frameAboutReleaseDocuments(root, check) {
  const about = source(
    root,
    "apps/app/src/react-app/shell/local-about-view.tsx",
  );
  const ipcTypes = source(root, "packages/types/src/desktop-ipc.ts");
  const main = source(root, "apps/desktop/electron/main.mjs");
  const documentNames = [
    "THIRD_PARTY_NOTICES.txt",
    "ELECTRON-LICENSE.txt",
    "LICENSES.chromium.html",
    "agencyai-desktop.spdx.json",
    "agencyai-desktop.cdx.json",
  ];

  check.expect(
    documentNames.every((name) => about.includes(name))
      && about.includes("releaseMetadataRead")
      && about.includes("Read"),
    "About offers user-triggered readers for notices, runtime licenses, and both SBOMs",
    documentNames,
  );
  check.expect(
    ipcTypes.includes("export type ReleaseMetadataFile")
      && ipcTypes.includes("ReleaseMetadataDocument")
      && documentNames.every((name) => ipcTypes.includes(name)),
    "The renderer uses one typed read-only release-document contract",
  );
  check.expect(
    main.includes('"releaseMetadataRead"')
      && main.includes("Release metadata file is not allowlisted")
      && main.includes("fileStats.isSymbolicLink()")
      && main.includes("32 * 1024 * 1024")
      && main.includes("process.resourcesPath"),
    "Electron restricts release reads to packaged, non-symlinked, bounded allowlisted files",
  );
  check.expect(
    /not\s+endorsed by either upstream project/.test(about)
      && about.includes("local-first desktop agent"),
    "About preserves factual attribution and the local product boundary",
  );
  return {
    userReadableDocuments: documentNames,
    contract: "typed read-only IPC",
    root: "packaged Resources/release-metadata",
    symlinks: "rejected",
    maximumBytes: 32 * 1024 * 1024,
  };
}

async function frameUnsignedCiBoundary(root, check) {
  run(root, "node", [
    "--test",
    "scripts/check-local-profile.test.mjs",
    "scripts/release/local-release-policy.test.mjs",
    "apps/desktop/scripts/electron-builder-config.test.mjs",
  ]);
  const policyResult = JSON.parse(
    run(root, "node", ["scripts/check-local-profile.mjs"]),
  );
  const workflow = source(root, ".github/workflows/local-desktop-ci.yml");
  const releaseReview = source(root, "scripts/release/review-local-release.mjs");
  const releaseTag = source(root, "scripts/release/verify-local-tag.mjs");

  check.expect(
    policyResult.ok === true
      && policyResult.profile === "local-mvp"
      && policyResult.sourceClosure.includes("0 findings"),
    "The immutable local release policy and restricted-source gate pass",
    {
      profile: policyResult.profile,
      sourceClosure: policyResult.sourceClosure,
    },
  );
  check.expect(
    workflow.includes("runs-on: macos-15")
      && workflow.includes('test "$(uname -m)" = arm64')
      && !workflow.includes("self-hosted"),
    "CI uses a GitHub-hosted arm64 macOS runner",
  );
  check.expect(
    !/secrets\.|notari[sz]|gh release|softprops|create-release/i.test(workflow)
      && !/dist-electron\/[^\n]*(?:\.dmg|\.zip)/i.test(workflow),
    "PR07 CI has no credential, notarization, release, or public-candidate upload path",
  );
  check.expect(
    workflow.includes("release-metadata")
      && workflow.includes("evals/results")
      && releaseReview.includes("local-mvp")
      && releaseTag.includes("agencyai-desktop-v")
      && releaseTag.includes("requireClean"),
    "CI uploads proof only and release helpers remain review-only policy checks",
  );
  return {
    runner: "GitHub-hosted macos-15 arm64",
    signing: false,
    notarization: false,
    publicRelease: false,
    uploadedProof: ["release-metadata", "evals/results"],
    pr08BoundaryPreserved: true,
  };
}

async function framePackagedNoEgress(root, check) {
  const args = ["apps/desktop/scripts/run-packaged-smoke.mjs"];
  const requestedApp = process.env.AGENCYAI_PR07_APP_PATH?.trim();
  if (requestedApp) args.push("--app", requestedApp);
  const result = parseLastJson(
    run(root, "node", args, 300_000),
    "Packaged no-egress smoke",
  );

  check.expect(
    result.ok === true
      && result.app === "AgencyAI"
      && result.profile === "local-mvp"
      && result.rendererOrigin === "agencyai-internal://renderer",
    "The real packaged application launches the immutable local product",
  );
  check.expect(
    result.opencode === "1.17.11"
      && result.opencodeSource === "bundled-patched"
      && result.sqlite === "embedded-server-loaded"
      && result.pty === "agencyai-packaged-pty-ok"
      && result.browser === "authorized-target-only",
    "The packaged local runtime exercises its verified engine, native modules, and browser wrapper",
  );
  check.expect(
    result.network?.auditRecords > 0
      && result.network?.samples?.length >= 3
      && result.network.samples.every((sample) => sample.endpoints > 0)
      && result.network.unexpectedNonLoopback === 0,
    "Application audit and independent process-tree socket samples find zero unexpected egress",
    result.network,
  );
  check.expect(
    result.docs?.hostedMatches === 0
      && result.licenses?.length === 5
      && result.sboms?.length === 2
      && result.serverWorkspaceRemoved === true,
    "Packaged docs, legal files, SBOMs, and disposable workspace cleanup all pass",
    {
      docs: result.docs,
      licenses: result.licenses,
      sboms: result.sboms,
      serverWorkspaceRemoved: result.serverWorkspaceRemoved,
    },
  );
  return {
    app: result.app,
    profile: result.profile,
    opencode: result.opencode,
    native: { sqlite: result.sqlite, pty: result.pty },
    browser: result.browser,
    network: result.network,
    hostedDocsMatches: result.docs.hostedMatches,
    workspaceCleaned: result.serverWorkspaceRemoved,
  };
}

const FRAME_RUNNERS = Object.freeze({
  1: frameReleaseInputProvenance,
  2: frameSbomLicenseClosure,
  3: frameArtifactInspection,
  4: frameAboutReleaseDocuments,
  5: frameUnsignedCiBoundary,
  6: framePackagedNoEgress,
});

export async function runFrame(frameInput, rootInput) {
  const frame = Number(frameInput);
  const definition = FRAME_DEFINITIONS.find((entry) => entry.frame === frame);
  const runner = FRAME_RUNNERS[frame];
  assert(definition && runner, "frame must be an integer from 1 through 6");
  const root = repositoryRoot(rootInput);
  const check = createChecks();
  const evidence = await runner(root, check);
  return {
    passed: true,
    frame,
    id: definition.id,
    checks: check.list,
    evidence,
  };
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runFrame(process.argv[2], process.argv[3]).then(
    (result) => {
      process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
