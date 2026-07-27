import {
  deepFreezeProductProfile,
  getBuildProductProfile,
  narrowFeatures,
  type ProductProfile,
} from "@openwork/product-config";

function readProductProfileCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object") return null;
  return Reflect.get(value, "productProfile");
}

function readOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function readRuntimeFeatures(value: unknown): Partial<ProductProfile["features"]> {
  return {
    openworkCloud: readOptionalBoolean(value, "openworkCloud"),
    cloudBootstrap: readOptionalBoolean(value, "cloudBootstrap"),
    connectLinks: readOptionalBoolean(value, "connectLinks"),
    dynamicOrgBranding: readOptionalBoolean(value, "dynamicOrgBranding"),
    analytics: readOptionalBoolean(value, "analytics"),
    automaticUpdates: readOptionalBoolean(value, "automaticUpdates"),
    runtimeDownloads: readOptionalBoolean(value, "runtimeDownloads"),
    runtimePluginInstall: readOptionalBoolean(value, "runtimePluginInstall"),
    remoteAssetFetches: readOptionalBoolean(value, "remoteAssetFetches"),
    hostedWebSearch: readOptionalBoolean(value, "hostedWebSearch"),
    remoteWorkspaces: readOptionalBoolean(value, "remoteWorkspaces"),
    remoteAccess: readOptionalBoolean(value, "remoteAccess"),
    workspaceSharing: readOptionalBoolean(value, "workspaceSharing"),
    legacyOpenWorkImport: readOptionalBoolean(value, "legacyOpenWorkImport"),
    freshStart: readOptionalBoolean(value, "freshStart"),
    openworkModels: readOptionalBoolean(value, "openworkModels"),
    voice: readOptionalBoolean(value, "voice"),
    googleWorkspace: readOptionalBoolean(value, "googleWorkspace"),
    browserAutomation: readOptionalBoolean(value, "browserAutomation"),
    computerUse: readOptionalBoolean(value, "computerUse"),
  };
}

function readMatchingCandidateFeatures(
  value: unknown,
  build: ProductProfile,
): Partial<ProductProfile["features"]> | null {
  const candidate = readProductProfileCandidate(value);
  if (candidate === null || typeof candidate !== "object") return null;
  if (Reflect.get(candidate, "schemaVersion") !== build.schemaVersion) return null;
  if (Reflect.get(candidate, "profile") !== build.profile) return null;

  const features = Reflect.get(candidate, "features");
  if (features === null || typeof features !== "object") return null;
  return readRuntimeFeatures(features);
}

export function getCompiledRendererProductProfile(): ProductProfile {
  return getBuildProductProfile();
}

export function projectRendererProductProfile(
  appBuildInfo?: unknown,
  runtimeFeatures?: unknown,
): ProductProfile {
  const build = getBuildProductProfile();
  const ipcFeatures = readMatchingCandidateFeatures(appBuildInfo, build);
  const ipcNarrowed = narrowFeatures(build.features, ipcFeatures ?? undefined);
  const effectiveFeatures = narrowFeatures(ipcNarrowed, readRuntimeFeatures(runtimeFeatures));

  return deepFreezeProductProfile({
    ...build,
    brand: build.brand,
    features: effectiveFeatures,
  });
}
