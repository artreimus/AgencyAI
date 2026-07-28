import {
  getBuildProductProfile,
  narrowFeatures,
  PRODUCT_FEATURES,
  type ProductFeatures,
  type ProductProfile,
  type ProductProfileName,
} from "@openwork/product-config";

export type ServerProductPolicy = Readonly<{
  profile: ProductProfileName;
  features: ProductFeatures;
  networkPolicy: ProductProfile["networkPolicy"];
  rendererOrigin: string;
}>;

const UPSTREAM_COMPATIBILITY_POLICY: ServerProductPolicy = Object.freeze({
  profile: "upstream",
  features: Object.freeze(Object.fromEntries(
    PRODUCT_FEATURES.map((feature) => [feature, true]),
  )) as ProductFeatures,
  networkPolicy: "user-authorized",
  rendererOrigin: "openwork-internal://renderer",
});

export function resolveServerProductPolicy(
  policy?: ServerProductPolicy,
): ServerProductPolicy {
  const build = getBuildProductProfile();
  if (policy && policy.profile !== build.profile) {
    throw new Error(
      `Server product profile ${policy.profile} cannot replace compiled profile ${build.profile}`,
    );
  }
  return Object.freeze({
    profile: build.profile,
    features: narrowFeatures(build.features, policy?.features),
    networkPolicy: build.networkPolicy,
    rendererOrigin: `${build.brand.rendererScheme}://renderer`,
  });
}

export function isLocalMvpProduct(
  policy?: ServerProductPolicy,
): boolean {
  // Direct ServerConfig fixtures predating the product-policy contract retain
  // upstream behavior. Production config resolution always supplies a policy.
  return policy?.profile === "local-mvp";
}

export function effectiveServerProductPolicy(
  policy?: ServerProductPolicy,
): ServerProductPolicy {
  return policy ?? UPSTREAM_COMPATIBILITY_POLICY;
}

export function legacyOpenWorkImportEnabled(
  policy?: ServerProductPolicy,
): boolean {
  return resolveServerProductPolicy(policy).features.legacyOpenWorkImport;
}

export function serverFeatureEnabled(
  feature: keyof ProductFeatures,
  policy?: ServerProductPolicy,
): boolean {
  return effectiveServerProductPolicy(policy).features[feature];
}
