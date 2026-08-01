import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const desktopRequire = createRequire(import.meta.url);
const configModule = desktopRequire("../electron-builder.config.cjs");
const afterAllArtifactBuild = desktopRequire(
  "./electron-after-all-artifact-build.cjs",
);
const afterPack = desktopRequire("./electron-after-pack.cjs");
const afterSign = desktopRequire("./electron-after-sign.cjs");
const electronSign = desktopRequire("./electron-sign.cjs");
const electronBuilderRequire = createRequire(
  desktopRequire.resolve("electron-builder/package.json"),
);
const { getConfig, validateConfiguration } = electronBuilderRequire(
  "app-builder-lib/out/util/config/config.js",
);
const { getPublishConfigs } = electronBuilderRequire(
  "app-builder-lib/out/publish/PublishManager.js",
);

function schemaDebugLogger() {
  return {
    isEnabled: false,
    add() {},
  };
}

test("local-mvp builder identity is derived from the immutable AgencyAI profile", async () => {
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);

  assert.equal(profile.brand.appId, "com.artreimus.agencyai");
  assert.equal(profile.brand.devAppId, "com.artreimus.agencyai.dev");
  assert.equal(config.appId, profile.brand.appId);
  assert.equal(config.productName, profile.brand.name);
  assert.equal(config.executableName, profile.brand.executableName);
  assert.equal(config.artifactName, "agencyai-${os}-${arch}-${version}.${ext}");
  assert.equal(config.extraMetadata.author.name, profile.brand.companyName);
  assert.equal(config.extraMetadata.desktopName, profile.brand.linuxDesktopName);
});

test("local-mvp omits public protocol and fails closed without an updater provider", async () => {
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);

  assert.equal(profile.brand.protocol, null);
  assert.equal(profile.features.automaticUpdates, false);
  assert.equal(Object.hasOwn(config, "protocols"), false);
  assert.equal(config.publish, null);
  assert.equal(Object.hasOwn(config.mac, "protocols"), false);
  assert.equal(Object.hasOwn(config.win, "protocols"), false);
  assert.equal(Object.hasOwn(config.linux, "protocols"), false);
});

test("local-mvp deterministically rebuilds native modules and applies hardened Electron fuses", async () => {
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);

  assert.equal(config.files.includes("!electron/**/*.test.*"), true);
  assert.equal(config.npmRebuild, true);
  assert.equal(config.nativeRebuilder, "sequential");
  assert.equal(
    config.asarUnpack.some((entry) => entry.includes("better-sqlite3")),
    true,
  );
  assert.equal(
    config.asarUnpack.some((entry) => entry.includes("node-pty")),
    true,
  );
  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  });
});

test("local-mvp packages only the reviewed OpenCode plugin allowlist", async () => {
  const productConfig = await import("@openwork/product-config");
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);
  const pluginResource = config.extraResources.find(
    (entry) => entry.to === "opencode-plugins",
  );
  const expectedFiles = productConfig.AGENCYAI_LOCAL_OPENCODE_PLUGIN_NAMES
    .map((name) => `${name}.js`);

  assert.deepEqual(
    configModule.LOCAL_OPENCODE_PLUGIN_FILES,
    expectedFiles,
  );
  assert.deepEqual(pluginResource?.filter, expectedFiles);
  assert.equal(pluginResource?.filter.includes("*.js"), false);
});

test("local-mvp packages only curated AgencyAI docs and the two project licenses", async () => {
  const { AGENCYAI_DOC_FILES } = await import("./stage-agencyai-docs.mjs");
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);
  const docsResource = config.extraResources.find(
    (entry) => entry.to === "agencyai-docs",
  );
  const licenseResources = config.extraResources
    .filter((entry) => String(entry.to).startsWith("licenses/"))
    .map((entry) => ({ from: entry.from, to: entry.to }));

  assert.deepEqual(configModule.AGENCYAI_DOC_FILES, AGENCYAI_DOC_FILES);
  assert.deepEqual(docsResource, {
    from: ".generated/agencyai-docs",
    to: "agencyai-docs",
    filter: [...AGENCYAI_DOC_FILES],
  });
  assert.equal(
    config.extraResources.some((entry) => entry.to === "openwork-docs"),
    false,
  );
  assert.deepEqual(licenseResources, [
    {
      from: "resources/licenses/OPENWORK-LICENSE.txt",
      to: "licenses/OPENWORK-LICENSE.txt",
    },
    {
      from: "resources/licenses/OPENCODE-LICENSE.txt",
      to: "licenses/OPENCODE-LICENSE.txt",
    },
  ]);
});

test("platform identity, helper IDs, NSIS identity, and Linux desktop filename are stable", async () => {
  const profile = await configModule.loadSelectedProductProfile();
  const config = configModule.createElectronBuilderConfig(profile);
  const helperId = `${profile.brand.appId}.helper`;

  assert.equal(config.mac.appId, profile.brand.appId);
  assert.equal(config.mac.helperBundleId, helperId);
  assert.equal(config.mac.helperRendererBundleId, `${helperId}.renderer`);
  assert.equal(config.mac.helperPluginBundleId, `${helperId}.plugin`);
  assert.equal(config.mac.helperGPUBundleId, `${helperId}.gpu`);
  assert.equal(config.mac.helperEHBundleId, `${helperId}.eh`);
  assert.equal(config.mac.helperNPBundleId, `${helperId}.np`);
  assert.equal(config.mac.minimumSystemVersion, "14.0");
  assert.equal(config.mac.sign, "scripts/electron-sign.cjs");
  assert.equal(Object.hasOwn(config.mac, "signIgnore"), false);
  assert.deepEqual(config.mac.extendInfo.NSAppTransportSecurity, {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true,
    NSExceptionDomains: {
      "127.0.0.1": {
        NSIncludesSubdomains: false,
        NSTemporaryExceptionAllowsInsecureHTTPLoads: true,
      },
      localhost: {
        NSIncludesSubdomains: false,
        NSTemporaryExceptionAllowsInsecureHTTPLoads: true,
      },
    },
  });
  assert.equal(
    config.mac.extendInfo.NSMicrophoneUsageDescription,
    profile.features.voice
      ? "AgencyAI uses the microphone when you start Voice Mode so you can speak commands to your agent."
      : undefined,
  );
  assert.deepEqual(configModule.macSigningConfiguration({}), {
    sign: "scripts/electron-sign.cjs",
    identity: "-",
  });
  assert.deepEqual(
    configModule.macSigningConfiguration({ CSC_LINK: "certificate" }),
    { sign: "scripts/electron-sign.cjs" },
  );
  assert.deepEqual(config.mac.extraResources.at(-1).filter, [
    `${profile.brand.computerUse.bundleName}/**`,
  ]);

  assert.equal(config.win.appId, profile.brand.appId);
  assert.equal(
    config.win.signtoolOptions.publisherName,
    profile.brand.companyName,
  );
  assert.equal(config.nsis.guid, profile.brand.nsisGuid);
  assert.equal(config.nsis.shortcutName, profile.brand.name);
  assert.equal(config.nsis.uninstallDisplayName, profile.brand.name);
  assert.equal(config.nsis.differentialPackage, false);

  assert.equal(config.linux.appId, profile.brand.appId);
  assert.equal(config.linux.executableName, profile.brand.executableName);
  assert.equal(config.linux.syncDesktopName, true);
  assert.equal(config.extraMetadata.desktopName, profile.brand.linuxDesktopName);
  assert.equal(config.linux.desktop.entry.StartupWMClass, profile.brand.slug);
});

test("installed electron-builder loads and validates the CJS config", async () => {
  const config = await getConfig(
    desktopDirectory,
    "electron-builder.config.cjs",
    null,
  );

  await assert.doesNotReject(
    validateConfiguration(config, schemaDebugLogger()),
  );
  assert.equal(config.appId, "com.artreimus.agencyai");
  assert.equal(config.publish, null);
  assert.equal(Object.hasOwn(config, "protocols"), false);
  assert.equal(
    config.afterAllArtifactBuild,
    "scripts/electron-after-all-artifact-build.cjs",
  );
});

test("installed electron-builder cannot infer an updater provider from CI tokens", async () => {
  const config = await configModule();
  const previousGhToken = process.env.GH_TOKEN;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_TOKEN = "test-token";

  try {
    const publishConfigs = await getPublishConfigs(
      {
        config,
        platformSpecificBuildOptions: config.mac,
      },
      null,
      0,
      false,
    );
    assert.equal(publishConfigs, null);
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
  }
});

test("desktop packaging no longer references the removed YAML config or upstream cleanup", async () => {
  const files = [
    "package.json",
    "build/installer.nsh",
    "../../.github/workflows/build-electron-desktop.yml",
    "../../.github/workflows/release-macos-aarch64.yml",
    "../../.github/workflows/alpha-macos-aarch64.yml",
  ];

  for (const relativePath of files) {
    const source = await readFile(resolve(desktopDirectory, relativePath), "utf8");
    assert.doesNotMatch(source, /electron-builder\.yml/);
  }

  const packageMetadata = JSON.parse(
    await readFile(resolve(desktopDirectory, "package.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(packageMetadata, "repository"), false);
  assert.match(
    packageMetadata.scripts["package:electron"],
    /electron-builder\.config\.cjs/,
  );
  assert.match(
    packageMetadata.scripts["package:electron"],
    /electron-build\.mjs --release/,
  );
  assert.match(
    packageMetadata.scripts["package:electron:dir"],
    /electron-builder\.config\.cjs/,
  );
  assert.match(
    packageMetadata.scripts["package:electron:dir"],
    /electron-build\.mjs --release/,
  );

  const electronBuildSource = await readFile(
    resolve(desktopDirectory, "scripts/electron-build.mjs"),
    "utf8",
  );
  assert.match(
    electronBuildSource,
    /AGENCYAI_RELEASE_INPUTS_DIR: releaseInputsRoot/,
  );
  assert.match(
    electronBuildSource,
    /\.\.\.\(releaseBuild \? \{ OPENWORK_RELEASE_BUILD: "1" \} : \{\}\)/,
  );

  const installer = await readFile(
    resolve(desktopDirectory, "build/installer.nsh"),
    "utf8",
  );
  assert.doesNotMatch(installer, /com\.differentai\.openwork/i);
  assert.doesNotMatch(installer, /OpenWork/i);
  assert.doesNotMatch(installer, /FileOpen/);
});

test("desktop release workflows use AgencyAI artifacts without updater manifests", async () => {
  const workflowPaths = [
    "../../.github/workflows/build-electron-desktop.yml",
    "../../.github/workflows/release-macos-aarch64.yml",
    "../../.github/workflows/alpha-macos-aarch64.yml",
  ];
  const workflows = await Promise.all(
    workflowPaths.map((relativePath) =>
      readFile(resolve(desktopDirectory, relativePath), "utf8")
    ),
  );

  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /electron-builder\.yml/);
    assert.doesNotMatch(workflow, /dist-electron\/openwork-/);
    assert.doesNotMatch(workflow, /dist-electron\/latest[^/\s]*\.yml/);
    assert.doesNotMatch(workflow, /dist-electron\/[^\s]*\.blockmap/);
    assert.doesNotMatch(workflow, /publish-electron-assets\.mjs/);
    assert.match(workflow, /OPENWORK_RELEASE_BUILD/);
  }

  assert.match(workflows[0], /agencyai-electron-/);
  assert.match(workflows[1], /dist-electron\/agencyai-/);
  assert.match(workflows[2], /dist-electron\/agencyai-\*\.dmg/);
  assert.match(workflows[2], /dist-electron\/agencyai-\*\.zip/);
});

test("AgencyAI PR07 CI uses isolated hosted arm64 runners without release credentials", async () => {
  const workflow = await readFile(
    resolve(
      desktopDirectory,
      "../../.github/workflows/local-desktop-ci.yml",
    ),
    "utf8",
  );
  const buildScript = await readFile(
    resolve(
      desktopDirectory,
      "../../scripts/release/build-pinned-opencode-macos.sh",
    ),
    "utf8",
  );
  assert.doesNotMatch(workflow, /runs-on: macos-14/);
  assert.equal(workflow.match(/runs-on: macos-15/g)?.length, 2);
  assert.match(workflow, /test "\$\(uname -m\)" = arm64/);
  assert.match(
    workflow,
    /run: bash scripts\/release\/build-pinned-opencode-macos\.sh/,
  );
  assert.match(
    buildScript,
    /git -C "\$source_root" fetch --depth=1 origin "\$source_commit"/,
  );
  assert.match(workflow, /OPENCODE_VERSION: "1\.17\.11"/);
  assert.match(
    buildScript,
    /test "\$\{OPENCODE_VERSION:-\}" = "\$binary_version"/,
  );
  assert.match(
    buildScript,
    /\/Users\/runner\/work\/AgencyAI-OpenCode\/AgencyAI-OpenCode/,
  );
  assert.match(buildScript, /models-dev-snapshot\.json/);
  assert.match(buildScript, /\.dependencies\.modelsDev\.sha256/);
  assert.match(
    buildScript,
    /export MODELS_DEV_API_JSON="\$models_snapshot"/,
  );
  assert.match(
    buildScript,
    /shasum -a 256 "\$models_snapshot"/,
  );
  assert.match(buildScript, /sourceBinarySha256/);
  assert.match(buildScript, /AGENCYAI_VERIFIED_OPENCODE_BINARY_PATH/);
  assert.match(
    workflow,
    /env -u GITHUB_BASE_REF pnpm package:local:dir/,
  );
  assert.match(workflow, /pnpm --filter @openwork\/desktop smoke:packaged/);
  assert.doesNotMatch(
    workflow,
    /self-hosted|CSC_|APPLE_|notari[sz]e|secrets\.|GH_TOKEN|github\.token/i,
  );
  assert.doesNotMatch(
    workflow,
    /gh release|contents:\s*write|release-desktop|MACOS_NOTARIZE/i,
  );
});

test("local-mvp artifact hook removes only generated blockmaps", async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), "agencyai-artifacts-"));
  try {
    const nested = resolve(outDir, "nested");
    await mkdir(nested);
    const artifact = resolve(outDir, "agencyai-mac-arm64-0.1.0.zip");
    const macBlockmap = `${artifact}.blockmap`;
    const windowsBlockmap = resolve(
      nested,
      "agencyai-win-x64-0.1.0.exe.blockmap",
    );
    await Promise.all([
      writeFile(artifact, "zip-fixture"),
      writeFile(macBlockmap, "mac-blockmap"),
      writeFile(windowsBlockmap, "windows-blockmap"),
    ]);

    assert.deepEqual(
      await afterAllArtifactBuild({
        outDir,
        artifactPaths: [artifact],
        platformToTargets: new Map(),
        configuration: {},
      }),
      [],
    );
    await access(artifact);
    await assert.rejects(access(macBlockmap), /ENOENT/);
    await assert.rejects(access(windowsBlockmap), /ENOENT/);
    assert.deepEqual(await readdir(outDir), [
      "agencyai-mac-arm64-0.1.0.zip",
      "nested",
    ]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("afterPack consumes builder Arch enums and keeps only shipped sidecars", async () => {
  assert.deepEqual(afterPack.sidecarBases, [
    "opencode",
    "openwork-orchestrator",
  ]);
  assert.equal(afterPack.normalizeArch(1), "x64");
  assert.equal(afterPack.normalizeArch(3), "arm64");
  assert.equal(
    afterPack.targetTriple("linux", 1),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    afterPack.targetTriple("darwin", 3),
    "aarch64-apple-darwin",
  );

  const appOutDir = await mkdtemp(resolve(tmpdir(), "agencyai-after-pack-"));
  try {
    const resources = resolve(appOutDir, "resources");
    const sidecars = resolve(resources, "sidecars");
    const toolchain = resolve(
      resources,
      "toolchain",
      "x86_64-unknown-linux-gnu",
    );
    await Promise.all([
      mkdir(sidecars, { recursive: true }),
      mkdir(toolchain, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        resolve(resources, "opencode-distribution.json"),
        '{"schemaVersion":1}\n',
      ),
      writeFile(
        resolve(sidecars, "opencode-x86_64-unknown-linux-gnu"),
        "opencode-x64",
      ),
      writeFile(
        resolve(
          sidecars,
          "openwork-orchestrator-x86_64-unknown-linux-gnu",
        ),
        "orchestrator-x64",
      ),
      writeFile(
        resolve(sidecars, "versions.json-x86_64-unknown-linux-gnu"),
        "{}",
      ),
      writeFile(
        resolve(sidecars, "opencode-aarch64-unknown-linux-gnu"),
        "opencode-arm64",
      ),
      writeFile(resolve(sidecars, "stale-sidecar"), "stale"),
      writeFile(resolve(toolchain, "rg"), "ripgrep-x64"),
      writeFile(resolve(toolchain, "LICENSE-ripgrep"), "MIT"),
    ]);

    await afterPack({
      electronPlatformName: "linux",
      arch: 1,
      appOutDir,
      packager: { appInfo: { productFilename: "AgencyAI" } },
    });

    assert.deepEqual((await readdir(sidecars)).sort(), [
      "opencode",
      "opencode-x86_64-unknown-linux-gnu",
      "openwork-orchestrator",
      "openwork-orchestrator-x86_64-unknown-linux-gnu",
      "versions.json",
      "versions.json-x86_64-unknown-linux-gnu",
    ]);
    assert.equal(await readFile(resolve(sidecars, "opencode"), "utf8"), "opencode-x64");
    assert.equal(
      await readFile(resolve(sidecars, "openwork-orchestrator"), "utf8"),
      "orchestrator-x64",
    );
    const integrity = JSON.parse(
      await readFile(
        resolve(resources, "packaged-runtime-integrity.json"),
        "utf8",
      ),
    );
    assert.equal(integrity.hashPhase, "post-nested-signing");
    assert.equal(integrity.target, "x86_64-unknown-linux-gnu");
    assert.deepEqual(
      integrity.files.map((entry) => entry.path),
      [
        "sidecars/opencode",
        "sidecars/opencode-x86_64-unknown-linux-gnu",
        "toolchain/x86_64-unknown-linux-gnu/rg",
        "toolchain/x86_64-unknown-linux-gnu/LICENSE-ripgrep",
      ],
    );
  } finally {
    await rm(appOutDir, { recursive: true, force: true });
  }
});

test("afterPack reverses electron-builder's updater-only arbitrary-load override", async () => {
  const appOutDir = await mkdtemp(resolve(tmpdir(), "agencyai-after-pack-ats-"));
  const infoPlistPath = resolve(
    appOutDir,
    "AgencyAI.app",
    "Contents",
    "Info.plist",
  );
  try {
    await mkdir(dirname(infoPlistPath), { recursive: true });
    await writeFile(infoPlistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key><dict>
      <key>127.0.0.1</key><dict>
        <key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
      <key>localhost</key><dict>
        <key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
    </dict>
  </dict>
</dict></plist>
`);

    assert.equal(
      afterPack.enforceMacTransportSecurity({
        electronPlatformName: "darwin",
        appOutDir,
        packager: { appInfo: { productFilename: "AgencyAI" } },
      }).NSAllowsArbitraryLoads,
      false,
    );
    const transportSecurity = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-extract",
      "NSAppTransportSecurity",
      "json",
      "-o",
      "-",
      infoPlistPath,
    ], { encoding: "utf8" }));
    assert.equal(transportSecurity.NSAllowsArbitraryLoads, false);
    assert.equal(transportSecurity.NSAllowsLocalNetworking, true);
  } finally {
    await rm(appOutDir, { recursive: true, force: true });
  }
});

test("custom signing ignores only exact pre-signed runtime paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "agencyai-sign-ignore-"));
  try {
    const exact = resolve(root, "AgencyAI.app", "Contents", "Resources", "sidecars", "opencode");
    const sibling = `${exact}-unexpected`;
    const nested = resolve(
      root,
      "AgencyAI.app",
      "Contents",
      "Resources",
      "helpers",
      "Evil.app",
      "Contents",
      "Resources",
      "sidecars",
      "opencode",
    );
    await Promise.all([
      mkdir(dirname(exact), { recursive: true }),
      mkdir(dirname(nested), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(exact, "exact"),
      writeFile(sibling, "sibling"),
      writeFile(nested, "nested"),
    ]);

    const ignore = electronSign.canonicalExactIgnore([exact]);
    assert.equal(ignore(exact), true);
    assert.equal(ignore(sibling), false);
    assert.equal(ignore(nested), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notarization accepts only Developer ID metadata with a Team ID", () => {
  assert.deepEqual(
    afterSign.parseSignatureMetadata(
      [
        "Authority=Developer ID Application: AgencyAI LLC (A1B2C3D4E5)",
        "TeamIdentifier=A1B2C3D4E5",
      ].join("\n"),
      "AgencyAI app",
      true,
    ),
    { teamIdentifier: "A1B2C3D4E5" },
  );
  assert.throws(
    () =>
      afterSign.parseSignatureMetadata(
        "Signature=adhoc\nTeamIdentifier=not set",
        "AgencyAI app",
        true,
      ),
    /ad-hoc signed/,
  );
  assert.throws(
    () =>
      afterSign.parseSignatureMetadata(
        "Authority=Apple Development: Example\nTeamIdentifier=A1B2C3D4E5",
        "AgencyAI app",
        true,
      ),
    /not signed by a Developer ID Application/,
  );
});

test("inherited publish workflows are manual-only and cannot publish from AgencyAI", async () => {
  const workflowPaths = [
    "../../.github/workflows/release-macos-aarch64.yml",
    "../../.github/workflows/alpha-macos-aarch64.yml",
  ];
  const workflows = await Promise.all(
    workflowPaths.map((relativePath) =>
      readFile(resolve(desktopDirectory, relativePath), "utf8")
    ),
  );

  for (const workflow of workflows) {
    const triggerEnd = workflow.indexOf("\npermissions:");
    assert.notEqual(triggerEnd, -1);
    const triggers = workflow.slice(0, triggerEnd);
    assert.match(triggers, /^  workflow_dispatch:/m);
    assert.doesNotMatch(triggers, /^  push:/m);
    assert.doesNotMatch(triggers, /^  pull_request:/m);
    assert.match(triggers, /enable_legacy_upstream_publish:/);
    assert.match(
      triggers,
      /enable_legacy_upstream_publish:[\s\S]*?default: false/,
    );

    const allowlistedRepository = workflow.match(
      /github\.repository == '([^']+)'/,
    )?.[1];
    assert.equal(allowlistedRepository, "different-ai/openwork");
    assert.notEqual(allowlistedRepository, "artreimus/AgencyAI");
    assert.match(
      workflow,
      /inputs\.enable_legacy_upstream_publish == true/,
    );
  }

  assert.match(
    workflows[0],
    /legacy-upstream-release-guard:[\s\S]*?resolve-release:[\s\S]*?needs: legacy-upstream-release-guard/,
  );
  assert.match(
    workflows[1],
    /publish-alpha-macos-aarch64:[\s\S]*?if: >-[\s\S]*?github\.repository == 'different-ai\/openwork'/,
  );
});

test("every inherited public mutation is upstream-guarded", async () => {
  const workflowDirectory = resolve(desktopDirectory, "../../.github/workflows");
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const workflows = new Map(
    await Promise.all(
      workflowFiles.map(async (name) => [
        name,
        parseYaml(await readFile(resolve(workflowDirectory, name), "utf8")),
      ]),
    ),
  );
  const upstreamGuard =
    /github\.repository\s*==\s*['"]different-ai\/openwork['"]/;
  const agencyGuard =
    /github\.repository\s*==\s*['"]artreimus\/AgencyAI['"]/;
  const agencyPublicationAllowlist = new Set([
    "release-desktop-local.yml:release",
  ]);
  const observedAgencyPublications = new Set();

  function jobNeeds(job) {
    if (Array.isArray(job?.needs)) return job.needs;
    return typeof job?.needs === "string" ? [job.needs] : [];
  }

  function guardedJob(jobs, name, visiting = new Set()) {
    if (visiting.has(name)) return false;
    const job = jobs[name];
    if (!job) return false;
    if (upstreamGuard.test(String(job.if ?? ""))) return true;
    const nextVisiting = new Set(visiting).add(name);
    const guardedDependencies = jobNeeds(job).filter((dependency) =>
      guardedJob(jobs, dependency, nextVisiting)
    );
    if (guardedDependencies.length === 0) return false;
    const condition = String(job.if ?? "");
    if (!condition.includes("always()")) return true;
    return guardedDependencies.some((dependency) =>
      condition.includes(`needs.${dependency}.result == 'success'`) ||
      condition.includes(`needs.${dependency}.result == "success"`)
    );
  }

  function isPublicMutation(value) {
    const source = JSON.stringify(value);
    return /gh release (?:create|upload|edit|delete)/.test(source) ||
      (
        /(?:npm|pnpm[^"\\n]*) publish(?:[:\\w-]+)?/.test(source) &&
        !/publish --dry-run/.test(source)
      ) ||
      /git push/.test(source) ||
      /release-generic-installer\.yml/.test(source) ||
      /"push":true/.test(source);
  }

  for (const [fileName, workflow] of workflows) {
    const jobs = workflow.jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const jobKey = `${fileName}:${jobName}`;
      const isAgencyPublisher = agencyPublicationAllowlist.has(jobKey);
      if (isAgencyPublisher) {
        assert.equal(
          agencyGuard.test(String(job.if ?? "")),
          true,
          `${jobKey} must be AgencyAI-repository-guarded`,
        );
      }
      if (typeof job.uses === "string" && isPublicMutation(job)) {
        if (isAgencyPublisher) {
          observedAgencyPublications.add(jobKey);
          continue;
        }
        assert.equal(
          upstreamGuard.test(String(job.if ?? "")) ||
            guardedJob(jobs, jobName),
          true,
          `${jobKey} reusable publisher must be upstream-guarded`,
        );
      }
      for (const step of job.steps ?? []) {
        if (!isPublicMutation(step)) continue;
        if (isAgencyPublisher) {
          observedAgencyPublications.add(jobKey);
          continue;
        }
        assert.equal(
          upstreamGuard.test(String(step.if ?? "")) ||
            guardedJob(jobs, jobName),
          true,
          `${jobKey} public mutation must be upstream-guarded`,
        );
      }
    }
  }

  assert.deepEqual(
    observedAgencyPublications,
    agencyPublicationAllowlist,
  );
});

test("computer-use helper callsites consume the selected product identity", async () => {
  const callsitePaths = [
    "../electron/computer-use.mjs",
    "prepare-computer-use-helper.mjs",
    "electron-sign.cjs",
    "electron-after-sign.cjs",
    "../../../packages/handsfree/native/HandsFree/Sources/ComputerUse/PermissionSetupApp.swift",
    "../../../packages/handsfree/test/e2e/run.mjs",
  ];
  const callsites = await Promise.all(
    callsitePaths.map((relativePath) =>
      readFile(resolve(scriptDirectory, relativePath), "utf8")
    ),
  );

  for (const callsite of callsites) {
    assert.doesNotMatch(callsite, /OpenWork Computer Use/);
    assert.doesNotMatch(
      callsite,
      /com\.differentai\.openwork\.computer-use/,
    );
  }

  for (const callsite of callsites.slice(0, 4)) {
    assert.match(callsite, /getBuildProductProfile/);
  }
  assert.match(callsites[0], /brand\.computerUse\.bundleName/);
  assert.match(callsites[1], /brand\.computerUse\.bundleId/);
  assert.match(callsites[4], /ComputerUseParentProductName/);
  assert.match(callsites[5], /brand\.computerUse\.bundleName/);
});
