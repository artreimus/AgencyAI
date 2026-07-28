export const PRODUCT_PROFILE_NAMES = ["local-mvp", "upstream"] as const

export type ProductProfileName = (typeof PRODUCT_PROFILE_NAMES)[number]

export const PRODUCT_FEATURES = [
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
  "browserAutomation",
  "computerUse",
] as const

export type ProductFeature = (typeof PRODUCT_FEATURES)[number]

export type ProductBrand = Readonly<{
  name: string
  slug: string
  companyName: string
  appId: string
  devAppId: string
  executableName: string
  artifactPrefix: string
  rendererScheme: string
  protocol: string | null
  nsisGuid: string
  linuxDesktopName: string
  supportEmail: string | null
  docsUrl: string | null
  feedbackUrl: string | null
  issueUrl: string | null
  repository: Readonly<{ owner: string; name: string }> | null
  computerUse: Readonly<{
    displayName: string
    bundleName: string
    bundleId: string
  }>
}>

export type ProductFeatures = Readonly<Record<ProductFeature, boolean>>

export type ProductProfile = Readonly<{
  schemaVersion: 1
  profile: ProductProfileName
  brand: ProductBrand
  features: ProductFeatures
  networkPolicy: "user-authorized" | "air-gapped"
}>

export const LOCAL_MVP_FEATURES = Object.freeze({
  openworkCloud: false,
  cloudBootstrap: false,
  connectLinks: false,
  dynamicOrgBranding: false,
  analytics: false,
  automaticUpdates: false,
  runtimeDownloads: false,
  runtimePluginInstall: false,
  remoteAssetFetches: false,
  hostedWebSearch: false,
  remoteWorkspaces: false,
  remoteAccess: false,
  workspaceSharing: false,
  legacyOpenWorkImport: false,
  freshStart: false,
  openworkModels: false,
  voice: false,
  googleWorkspace: false,
  browserAutomation: true,
  computerUse: true,
}) satisfies ProductFeatures

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen)
  }
  if (!Object.isFrozen(value)) Object.freeze(value)
}

export function deepFreezeProductProfile(profile: ProductProfile): ProductProfile {
  deepFreeze(profile)
  return profile
}

export function narrowFeatures(
  build: ProductProfile["features"],
  runtime?: Partial<ProductProfile["features"]>,
): ProductProfile["features"] {
  return Object.freeze({
    openworkCloud: build.openworkCloud && runtime?.openworkCloud !== false,
    cloudBootstrap: build.cloudBootstrap && runtime?.cloudBootstrap !== false,
    connectLinks: build.connectLinks && runtime?.connectLinks !== false,
    dynamicOrgBranding: build.dynamicOrgBranding && runtime?.dynamicOrgBranding !== false,
    analytics: build.analytics && runtime?.analytics !== false,
    automaticUpdates: build.automaticUpdates && runtime?.automaticUpdates !== false,
    runtimeDownloads: build.runtimeDownloads && runtime?.runtimeDownloads !== false,
    runtimePluginInstall: build.runtimePluginInstall && runtime?.runtimePluginInstall !== false,
    remoteAssetFetches: build.remoteAssetFetches && runtime?.remoteAssetFetches !== false,
    hostedWebSearch: build.hostedWebSearch && runtime?.hostedWebSearch !== false,
    remoteWorkspaces: build.remoteWorkspaces && runtime?.remoteWorkspaces !== false,
    remoteAccess: build.remoteAccess && runtime?.remoteAccess !== false,
    workspaceSharing: build.workspaceSharing && runtime?.workspaceSharing !== false,
    legacyOpenWorkImport: build.legacyOpenWorkImport && runtime?.legacyOpenWorkImport !== false,
    freshStart: build.freshStart && runtime?.freshStart !== false,
    openworkModels: build.openworkModels && runtime?.openworkModels !== false,
    voice: build.voice && runtime?.voice !== false,
    googleWorkspace: build.googleWorkspace && runtime?.googleWorkspace !== false,
    browserAutomation: build.browserAutomation && runtime?.browserAutomation !== false,
    computerUse: build.computerUse && runtime?.computerUse !== false,
  })
}
