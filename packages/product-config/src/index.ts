import {
  deepFreezeProductProfile,
  type ProductFeature,
  type ProductProfile,
} from "./contract.js"

declare const __OPENWORK_COMPILED_PRODUCT_PROFILE__: ProductProfile

const BUILD_PRODUCT_PROFILE = deepFreezeProductProfile(
  __OPENWORK_COMPILED_PRODUCT_PROFILE__,
)

export function getBuildProductProfile(): ProductProfile {
  return BUILD_PRODUCT_PROFILE
}

export function isProductFeatureEnabled(feature: ProductFeature): boolean {
  return BUILD_PRODUCT_PROFILE.features[feature]
}

export * from "./contract.js"
export * from "./environment-policy.js"
export * from "./opencode-policy.js"
