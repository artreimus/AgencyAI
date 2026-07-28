const { basename } = require("node:path");

const PRODUCT_PROFILE_SELECTOR = "local-mvp";
const MACOS_MINIMUM_VERSION = "14.0";
const LOCAL_OPENCODE_PLUGIN_FILES = Object.freeze([
  "agencyai-local-extensions.js",
  "agencyai-local-capabilities.js",
  "openwork-office-attachments.js",
  "openwork-anthropic-adaptive-thinking.js",
  "openwork-anthropic-tool-schema.js",
  "agencyai-browser-automation.js",
  "agencyai-local-policy.js",
]);
const AGENCYAI_DOC_FILES = Object.freeze([
  "browser-and-computer-use.mdx",
  "docs.json",
  "getting-started.mdx",
  "mcp-and-skills.mdx",
  "privacy-and-security.mdx",
  "providers.mdx",
  "troubleshooting.mdx",
]);

function helperBundleIds(appId) {
  const helperBundleId = `${appId}.helper`;
  return {
    helperBundleId,
    helperRendererBundleId: `${helperBundleId}.renderer`,
    helperPluginBundleId: `${helperBundleId}.plugin`,
    helperGPUBundleId: `${helperBundleId}.gpu`,
    helperEHBundleId: `${helperBundleId}.eh`,
    helperNPBundleId: `${helperBundleId}.np`,
  };
}

function protocolConfiguration(profile) {
  if (profile.brand.protocol === null) return {};
  return {
    protocols: [{
      name: profile.brand.name,
      schemes: [profile.brand.protocol],
    }],
  };
}

function publishConfiguration(profile) {
  // electron-builder 26.15.3 infers a GitHub provider from repository metadata
  // or GH_TOKEN when this key is absent. `null` is its fail-closed sentinel:
  // no provider, updater config, latest*.yml, or blockmap metadata.
  if (!profile.features.automaticUpdates) return { publish: null };
  if (profile.brand.repository === null) {
    throw new Error("Automatic updates require a product-owned repository");
  }
  return {
    publish: [{
      provider: "github",
      owner: profile.brand.repository.owner,
      repo: profile.brand.repository.name,
      releaseType: "release",
    }],
  };
}

function macSigningConfiguration(env = process.env) {
  const configuredIdentity = [
    env.CSC_LINK,
    env.CSC_NAME,
    env.APPLE_CODESIGN_IDENTITY,
    env.OPENWORK_COMPUTER_USE_CODESIGN_IDENTITY,
  ].some((value) => typeof value === "string" && value.trim());
  return {
    sign: "scripts/electron-sign.cjs",
    ...(configuredIdentity ? {} : { identity: "-" }),
  };
}

function createElectronBuilderConfig(profile) {
  const { brand } = profile;
  const artifactName = `${brand.artifactPrefix}-\${os}-\${arch}-\${version}.\${ext}`;
  const helperIds = helperBundleIds(brand.appId);
  const linuxDesktopBaseName = basename(brand.linuxDesktopName, ".desktop");

  return {
    appId: brand.appId,
    productName: brand.name,
    executableName: brand.executableName,
    artifactName,
    directories: {
      output: "dist-electron",
    },
    toolsets: {
      appimage: "1.0.3",
    },
    files: [
      "electron/**/*",
      "!electron/**/*.test.*",
      "server/**/*",
      "!server/dist/opencode-plugins/**",
      "package.json",
    ],
    extraResources: [
      {
        from: "../../opencode-distribution.json",
        to: "opencode-distribution.json",
      },
      {
        from: "../app/dist",
        to: "app-dist",
      },
      {
        from: "server/dist/opencode-plugins",
        to: "opencode-plugins",
        filter: [...LOCAL_OPENCODE_PLUGIN_FILES],
      },
      {
        from: ".generated/agencyai-docs",
        to: "agencyai-docs",
        filter: [...AGENCYAI_DOC_FILES],
      },
      {
        from: "resources/licenses/OPENWORK-LICENSE.txt",
        to: "licenses/OPENWORK-LICENSE.txt",
      },
      {
        from: "resources/licenses/OPENCODE-LICENSE.txt",
        to: "licenses/OPENCODE-LICENSE.txt",
      },
    ],
    extraMetadata: {
      productName: brand.name,
      desktopName: brand.linuxDesktopName,
      description: `${brand.name} local-first desktop agent`,
      author: {
        name: brand.companyName,
        ...(brand.supportEmail === null ? {} : { email: brand.supportEmail }),
      },
    },
    asar: true,
    asarUnpack: [
      "node_modules/.pnpm/better-sqlite3*/**",
      "node_modules/better-sqlite3/**",
      "node_modules/.pnpm/@lydell+node-pty*/**",
      "node_modules/node-pty/**",
    ],
    npmRebuild: true,
    nativeRebuilder: "sequential",
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    afterPack: "scripts/electron-after-pack.cjs",
    afterSign: "scripts/electron-after-sign.cjs",
    afterAllArtifactBuild:
      "scripts/electron-after-all-artifact-build.cjs",
    mac: {
      appId: brand.appId,
      executableName: brand.executableName,
      icon: "resources/icons/icon.icns",
      category: "public.app-category.developer-tools",
      minimumSystemVersion: MACOS_MINIMUM_VERSION,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      notarize: false,
      ...macSigningConfiguration(),
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      ...helperIds,
      extendInfo: {
        NSAppTransportSecurity: {
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
        },
        ...(profile.features.voice
          ? {
              NSMicrophoneUsageDescription: `${brand.name} uses the microphone when you start Voice Mode so you can speak commands to your agent.`,
            }
          : {}),
      },
      extraResources: [
        {
          from: "resources/toolchain/aarch64-apple-darwin",
          to: "toolchain/aarch64-apple-darwin",
          filter: ["rg", "LICENSE-ripgrep"],
        },
        {
          from: "resources/sidecars",
          to: "sidecars",
          filter: [
            "opencode",
            "opencode-aarch64-apple-darwin",
            "opencode-x86_64-apple-darwin",
            "openwork-orchestrator",
            "openwork-orchestrator-aarch64-apple-darwin",
            "openwork-orchestrator-x86_64-apple-darwin",
            "versions.json",
            "versions.json-aarch64-apple-darwin",
            "versions.json-x86_64-apple-darwin",
          ],
        },
        {
          from: "resources/helpers",
          to: "helpers",
          filter: [`${brand.computerUse.bundleName}/**`],
        },
      ],
      target: ["dmg", "zip"],
    },
    linux: {
      appId: brand.appId,
      executableName: brand.executableName,
      icon: "resources/icons/icon.png",
      vendor: brand.companyName,
      maintainer: brand.companyName,
      syncDesktopName: true,
      desktop: {
        entry: {
          Name: brand.name,
          StartupWMClass: linuxDesktopBaseName,
        },
      },
      extraResources: [
        {
          from: "resources/sidecars",
          to: "sidecars",
          filter: [
            "opencode",
            "opencode-aarch64-unknown-linux-gnu",
            "opencode-x86_64-unknown-linux-gnu",
            "openwork-orchestrator",
            "openwork-orchestrator-aarch64-unknown-linux-gnu",
            "openwork-orchestrator-x86_64-unknown-linux-gnu",
            "versions.json",
            "versions.json-aarch64-unknown-linux-gnu",
            "versions.json-x86_64-unknown-linux-gnu",
          ],
        },
      ],
      target: ["AppImage", "tar.gz"],
    },
    win: {
      appId: brand.appId,
      executableName: brand.executableName,
      icon: "resources/icons/icon.ico",
      signtoolOptions: {
        publisherName: brand.companyName,
      },
      extraResources: [
        {
          from: "resources/sidecars",
          to: "sidecars",
          filter: [
            "opencode.exe",
            "opencode-aarch64-pc-windows-msvc.exe",
            "opencode-x86_64-pc-windows-msvc.exe",
            "openwork-orchestrator.exe",
            "openwork-orchestrator-aarch64-pc-windows-msvc.exe",
            "openwork-orchestrator-x86_64-pc-windows-msvc.exe",
            "versions.json",
            "versions.json-aarch64-pc-windows-msvc.exe",
            "versions.json-x86_64-pc-windows-msvc.exe",
          ],
        },
      ],
      target: ["nsis"],
    },
    nsis: {
      guid: brand.nsisGuid,
      shortcutName: brand.name,
      uninstallDisplayName: brand.name,
      include: "build/installer.nsh",
      differentialPackage: false,
    },
    ...protocolConfiguration(profile),
    ...publishConfiguration(profile),
  };
}

async function loadSelectedProductProfile() {
  const productConfig = await import("@openwork/product-config");
  const profile = productConfig.getBuildProductProfile();
  const selectedProfile = process.env.OPENWORK_PRODUCT_PROFILE ?? PRODUCT_PROFILE_SELECTOR;

  if (selectedProfile !== profile.profile) {
    throw new Error(
      `Electron Builder selected ${selectedProfile} but @openwork/product-config was compiled for ${profile.profile}`,
    );
  }
  if (!Object.isFrozen(profile) || !Object.isFrozen(profile.brand)) {
    throw new Error("Electron Builder requires an immutable compiled product profile");
  }
  return profile;
}

async function electronBuilderConfig() {
  return createElectronBuilderConfig(await loadSelectedProductProfile());
}

module.exports = electronBuilderConfig;
module.exports.createElectronBuilderConfig = createElectronBuilderConfig;
module.exports.loadSelectedProductProfile = loadSelectedProductProfile;
module.exports.macSigningConfiguration = macSigningConfiguration;
module.exports.LOCAL_OPENCODE_PLUGIN_FILES = LOCAL_OPENCODE_PLUGIN_FILES;
module.exports.AGENCYAI_DOC_FILES = AGENCYAI_DOC_FILES;
