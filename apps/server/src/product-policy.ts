import {
  getBuildProductProfile,
  type ProductProfile,
  type ProductProfileName,
} from "@openwork/product-config";

export type ServerProductPolicy = Readonly<{
  profile: ProductProfileName;
  features: Pick<ProductProfile["features"], "legacyOpenWorkImport">;
}>;

export function resolveServerProductPolicy(
  policy?: ServerProductPolicy,
): ServerProductPolicy {
  return policy ?? getBuildProductProfile();
}

export function isLocalMvpProduct(
  policy?: ServerProductPolicy,
): boolean {
  return resolveServerProductPolicy(policy).profile === "local-mvp";
}

export function legacyOpenWorkImportEnabled(
  policy?: ServerProductPolicy,
): boolean {
  return resolveServerProductPolicy(policy).features.legacyOpenWorkImport;
}
