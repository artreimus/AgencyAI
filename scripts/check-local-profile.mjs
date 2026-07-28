import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRestrictedRepositoryPath } from "./check-source-closure.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const FALSE_FEATURES = Object.freeze([
  "openworkCloud",
  "cloudBootstrap",
  "connectLinks",
  "dynamicOrgBranding",
  "analytics",
  "automaticUpdates",
  "runtimeDownloads",
  "runtimePluginInstall",
  "remoteAssetFetches",
  "hostedWebSearch",
  "remoteWorkspaces",
  "remoteAccess",
  "workspaceSharing",
  "legacyOpenWorkImport",
  "freshStart",
  "openworkModels",
  "voice",
  "googleWorkspace",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENWORK_PRODUCT_PROFILE: "local-mvp",
      VITE_OPENWORK_PRODUCT_PROFILE: "local-mvp",
    },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${script} failed:\n${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

export function validateLocalProfile(profile) {
  invariant(profile?.schemaVersion === 1, "Product profile schema must be 1");
  invariant(profile.profile === "local-mvp", "Product profile must be local-mvp");
  invariant(profile.brand?.name === "AgencyAI", "Product name must be AgencyAI");
  invariant(
    profile.brand?.appId === "com.artreimus.agencyai",
    "Product app ID must be fork-owned",
  );
  invariant(profile.brand?.protocol === null, "Public protocol must be disabled");
  invariant(
    profile.networkPolicy === "user-authorized",
    "MVP network policy must require user authorization",
  );
  for (const feature of FALSE_FEATURES) {
    invariant(
      profile.features?.[feature] === false,
      `local-mvp feature ${feature} must remain false`,
    );
  }
  invariant(
    profile.features?.browserAutomation === true
      && profile.features?.computerUse === true,
    "Local browser and computer-use capabilities must remain enabled",
  );
  return true;
}

export function validateBuilderConfig(config, profile) {
  invariant(config.appId === profile.brand.appId, "Builder app ID mismatch");
  invariant(config.productName === profile.brand.name, "Builder product name mismatch");
  invariant(config.executableName === profile.brand.executableName, "Builder executable mismatch");
  invariant(config.publish === null, "Builder publish provider must be disabled");
  invariant(config.protocols === undefined, "Builder public protocols must be absent");
  invariant(
    JSON.stringify(config.mac?.target) === JSON.stringify(["dmg", "zip"]),
    "macOS candidate targets must be DMG and ZIP",
  );
  invariant(config.mac?.notarize === false, "PR07 must not notarize artifacts");
  const configPaths = [];
  const visit = (value) => {
    if (typeof value === "string") configPaths.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(config);
  invariant(
    !configPaths.some(isRestrictedRepositoryPath),
    "Builder configuration references the restricted enterprise source tree",
  );
  return true;
}

export async function checkLocalProfile() {
  const profile = JSON.parse(
    readFileSync(
      resolve(repoRoot, "packages/product-config/profiles/local-mvp.json"),
      "utf8",
    ),
  );
  validateLocalProfile(profile);
  const builderModule = await import(
    new URL("../apps/desktop/electron-builder.config.cjs", import.meta.url)
  );
  const createConfig =
    builderModule.createElectronBuilderConfig
    ?? builderModule.default?.createElectronBuilderConfig;
  invariant(typeof createConfig === "function", "Builder config factory is unavailable");
  validateBuilderConfig(createConfig(profile), profile);

  const distribution = JSON.parse(
    readFileSync(resolve(repoRoot, "opencode-distribution.json"), "utf8"),
  );
  invariant(
    distribution.sourceRepository
      === "https://github.com/artreimus/AgencyAI-OpenCode",
    "OpenCode distribution must use the reviewed fork",
  );
  invariant(
    distribution.targetAssets?.["aarch64-apple-darwin"],
    "OpenCode distribution is missing the MVP target",
  );
  invariant(
    distribution.toolchain?.ripgrep?.targetAssets
      ?.["aarch64-apple-darwin"],
    "ripgrep distribution is missing the MVP target",
  );
  const componentPolicy = JSON.parse(
    readFileSync(
      resolve(repoRoot, "apps/desktop/release-component-policy.json"),
      "utf8",
    ),
  );
  invariant(componentPolicy.schemaVersion === 1, "Release component policy schema mismatch");
  invariant(
    componentPolicy.electronRuntime?.electron === "43.2.0",
    "Release policy Electron version drifted",
  );

  const requiredBuildOutputs = [
    "apps/app/dist",
    "apps/server/dist",
    "apps/desktop/.generated/agencyai-docs",
  ];
  for (const output of requiredBuildOutputs) {
    invariant(
      existsSync(resolve(repoRoot, output)),
      `Required local-profile build output is missing: ${output}`,
    );
  }
  const sourceClosure = runNode(
    resolve(repoRoot, "scripts/check-source-closure.mjs"),
  );
  const productSurface = runNode(
    resolve(
      repoRoot,
      "apps/desktop/scripts/check-agencyai-product-surface.mjs",
    ),
  );
  return {
    ok: true,
    profile: profile.profile,
    sourceClosure,
    productSurface: JSON.parse(productSurface),
  };
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    process.stdout.write(
      `${JSON.stringify(await checkLocalProfile(), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[local-profile-check] ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
