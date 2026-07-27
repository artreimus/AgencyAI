import { z } from "zod"

import {
  LOCAL_MVP_FEATURES,
  PRODUCT_FEATURES,
  PRODUCT_PROFILE_NAMES,
  type ProductFeature,
  type ProductProfile,
  type ProductProfileName,
} from "./contract.js"

export * from "./contract.js"

const nullableUrlSchema = z.union([z.string().url(), z.null()])
const nullableEmailSchema = z.union([z.string().email(), z.null()])
const bundleIdentifierSchema = z.string().regex(
  /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/,
  "Expected a stable reverse-DNS identifier",
)
const schemeSchema = z.string().regex(
  /^[a-z][a-z0-9+.-]*$/,
  "Expected a lowercase URI scheme",
)
const nsisGuidSchema = z.string().regex(
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
  "Expected a stable uppercase NSIS GUID",
)

const repositorySchema = z.strictObject({
  owner: z.string().min(1),
  name: z.string().min(1),
})

const productBrandSchema = z.strictObject({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  companyName: z.string().min(1),
  appId: bundleIdentifierSchema,
  devAppId: bundleIdentifierSchema,
  executableName: z.string().regex(/^[a-z][a-z0-9-]*$/),
  artifactPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
  rendererScheme: schemeSchema,
  protocol: z.union([schemeSchema, z.null()]),
  nsisGuid: nsisGuidSchema,
  linuxDesktopName: z.string().regex(/^[a-z][a-z0-9-]*\.desktop$/),
  supportEmail: nullableEmailSchema,
  docsUrl: nullableUrlSchema,
  feedbackUrl: nullableUrlSchema,
  issueUrl: nullableUrlSchema,
  repository: z.union([repositorySchema, z.null()]),
  computerUse: z.strictObject({
    displayName: z.string().min(1),
    bundleName: z.string().regex(/^[^/\\]+\.app$/),
    bundleId: bundleIdentifierSchema,
  }),
})

const productFeaturesSchema = z.strictObject({
  openworkCloud: z.boolean(),
  cloudBootstrap: z.boolean(),
  connectLinks: z.boolean(),
  dynamicOrgBranding: z.boolean(),
  analytics: z.boolean(),
  automaticUpdates: z.boolean(),
  runtimeDownloads: z.boolean(),
  runtimePluginInstall: z.boolean(),
  remoteAssetFetches: z.boolean(),
  hostedWebSearch: z.boolean(),
  remoteWorkspaces: z.boolean(),
  remoteAccess: z.boolean(),
  workspaceSharing: z.boolean(),
  legacyOpenWorkImport: z.boolean(),
  freshStart: z.boolean(),
  openworkModels: z.boolean(),
  voice: z.boolean(),
  googleWorkspace: z.boolean(),
  browserAutomation: z.boolean(),
  computerUse: z.boolean(),
})

const LOCAL_MVP_BRAND_FIELDS = [
  ["name", "AgencyAI"],
  ["slug", "agencyai"],
  ["companyName", "AgencyAI"],
  ["appId", "com.artreimus.agencyai"],
  ["devAppId", "com.artreimus.agencyai.dev"],
  ["executableName", "agencyai"],
  ["artifactPrefix", "agencyai"],
  ["rendererScheme", "agencyai-internal"],
  ["protocol", null],
  ["nsisGuid", "866CE9A3-13BF-49B0-9D56-C9C43706CB0E"],
  ["linuxDesktopName", "agencyai.desktop"],
  ["supportEmail", null],
  ["docsUrl", null],
  ["feedbackUrl", null],
  ["issueUrl", "https://github.com/artreimus/AgencyAI/issues"],
] as const

const CLOUD_SUBFEATURES = [
  "cloudBootstrap",
  "connectLinks",
  "dynamicOrgBranding",
  "remoteWorkspaces",
  "remoteAccess",
  "workspaceSharing",
  "freshStart",
  "openworkModels",
  "googleWorkspace",
] as const satisfies readonly ProductFeature[]

const FORBIDDEN_LOCAL_IDENTITY_FRAGMENTS = [
  "com.differentai",
  "openworklabs.com",
  "github.com/different-ai/openwork",
] as const

const OWNED_UPDATE_REPOSITORIES = {
  "local-mvp": { owner: "artreimus", name: "AgencyAI" },
  upstream: { owner: "different-ai", name: "openwork" },
} as const satisfies Record<ProductProfileName, { owner: string; name: string }>

function addCustomIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message })
}

export const ProductProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.enum(PRODUCT_PROFILE_NAMES),
  brand: productBrandSchema,
  features: productFeaturesSchema,
  networkPolicy: z.enum(["user-authorized", "air-gapped"]),
}).superRefine((profile, context) => {
  if (profile.brand.rendererScheme !== `${profile.brand.slug}-internal`) {
    addCustomIssue(
      context,
      ["brand", "rendererScheme"],
      "The internal renderer scheme must be owned by the selected product",
    )
  }

  if (profile.brand.devAppId !== `${profile.brand.appId}.dev`) {
    addCustomIssue(
      context,
      ["brand", "devAppId"],
      "The development application identifier must be stable and derived from appId",
    )
  }

  if (profile.brand.computerUse.bundleId !== `${profile.brand.appId}.computer-use`) {
    addCustomIssue(
      context,
      ["brand", "computerUse", "bundleId"],
      "The computer-use helper identifier must be stable and derived from appId",
    )
  }

  if (
    profile.brand.executableName !== profile.brand.slug
    || profile.brand.artifactPrefix !== profile.brand.slug
    || profile.brand.linuxDesktopName !== `${profile.brand.slug}.desktop`
  ) {
    addCustomIssue(
      context,
      ["brand"],
      "Executable, artifact, and Linux desktop identifiers must be stable and product-owned",
    )
  }

  if (profile.brand.protocol !== null && profile.brand.protocol !== profile.brand.slug) {
    addCustomIssue(
      context,
      ["brand", "protocol"],
      "A public OS protocol must use a product-owned scheme",
    )
  }

  if (!profile.features.openworkCloud) {
    for (const feature of CLOUD_SUBFEATURES) {
      if (profile.features[feature]) {
        addCustomIssue(
          context,
          ["features", feature],
          `${feature} requires openworkCloud`,
        )
      }
    }
  }

  if (profile.features.automaticUpdates) {
    const expected = OWNED_UPDATE_REPOSITORIES[profile.profile]
    if (
      profile.brand.repository?.owner !== expected.owner
      || profile.brand.repository.name !== expected.name
    ) {
      addCustomIssue(
        context,
        ["features", "automaticUpdates"],
        "Automatic updates require the selected product's owned delivery repository and feed",
      )
    }
  }

  if (profile.features.connectLinks && profile.brand.protocol === null) {
    addCustomIssue(
      context,
      ["features", "connectLinks"],
      "Connect links require a product-owned public protocol",
    )
  }

  if (profile.profile !== "local-mvp") return

  const serializedBrand = JSON.stringify(profile.brand).toLowerCase()
  for (const fragment of FORBIDDEN_LOCAL_IDENTITY_FRAGMENTS) {
    if (serializedBrand.includes(fragment)) {
      addCustomIssue(
        context,
        ["brand"],
        `local-mvp identity contains forbidden upstream fragment: ${fragment}`,
      )
    }
  }

  for (const [field, expected] of LOCAL_MVP_BRAND_FIELDS) {
    if (profile.brand[field] !== expected) {
      addCustomIssue(
        context,
        ["brand", field],
        `local-mvp brand field ${field} is immutable`,
      )
    }
  }

  if (
    profile.brand.repository?.owner !== "artreimus"
    || profile.brand.repository.name !== "AgencyAI"
  ) {
    addCustomIssue(
      context,
      ["brand", "repository"],
      "local-mvp repository is immutable",
    )
  }

  if (
    profile.brand.computerUse.displayName !== "AgencyAI Computer Use"
    || profile.brand.computerUse.bundleName !== "AgencyAI Computer Use.app"
    || profile.brand.computerUse.bundleId !== "com.artreimus.agencyai.computer-use"
  ) {
    addCustomIssue(
      context,
      ["brand", "computerUse"],
      "local-mvp computer-use identity is immutable",
    )
  }

  for (const feature of PRODUCT_FEATURES) {
    if (profile.features[feature] !== LOCAL_MVP_FEATURES[feature]) {
      addCustomIssue(
        context,
        ["features", feature],
        `local-mvp build feature ${feature} is immutable`,
      )
    }
  }

  if (profile.networkPolicy !== "user-authorized") {
    addCustomIssue(
      context,
      ["networkPolicy"],
      "local-mvp network policy is immutable",
    )
  }
})

export function parseProductProfileName(value: unknown): ProductProfileName {
  if (value !== "local-mvp" && value !== "upstream") {
    throw new Error(
      `Invalid OPENWORK_PRODUCT_PROFILE selector: ${JSON.stringify(value)}`,
    )
  }
  return value
}

export function parseProductProfile(input: unknown): ProductProfile {
  return ProductProfileSchema.parse(input)
}
