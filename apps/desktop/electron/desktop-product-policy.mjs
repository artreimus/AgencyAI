import { resolveAppIdentifier } from "./dev-profile.mjs";

/**
 * Remove development-only launch state before any packaged local-mvp module
 * can read or forward it. Upstream and unpackaged development retain their
 * existing behavior behind the explicit profile boundary.
 *
 * @param {{
 *   productProfile: DesktopProductPolicyProfile,
 *   isPackaged: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function applyDesktopProductEnvironmentPolicy({
  productProfile,
  isPackaged,
  env = process.env,
}) {
  if (productProfile.profile === "local-mvp" && isPackaged) {
    delete env.OPENWORK_DEV_MODE;
  }
  return env;
}

/**
 * @typedef {{
 *   profile: string,
 *   brand: {
 *     name: string,
 *     appId: string,
 *     devAppId: string,
 *     protocol: string | null,
 *   },
 *   features: {
 *     connectLinks: boolean,
 *   },
 * }} DesktopProductPolicyProfile
 */

/**
 * @param {{
 *   productProfile: DesktopProductPolicyProfile,
 *   appRootPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   isDevMode?: boolean,
 *   isPackaged?: boolean,
 * }} options
 */
export function resolveDesktopProductPolicy({
  productProfile,
  appRootPath,
  env = process.env,
  isDevMode = false,
  isPackaged = false,
}) {
  const productionAppIdentifier = productProfile.brand.appId;
  const devAppIdentifier = productProfile.brand.devAppId;
  const allowIdentityOverrides = productProfile.profile !== "local-mvp" || !isPackaged;
  const effectiveDevMode = isDevMode &&
    (productProfile.profile !== "local-mvp" || !isPackaged);
  const baseAppIdentifier = effectiveDevMode
    ? devAppIdentifier
    : productionAppIdentifier;
  const appIdentifier = resolveAppIdentifier({
    appIdentifierOverride: allowIdentityOverrides
      ? env.OPENWORK_ELECTRON_APP_IDENTIFIER
      : undefined,
    appRootPath,
    baseAppIdentifier,
    devAppIdentifier,
    devProfile: env.OPENWORK_DEV_PROFILE,
    isDevMode: effectiveDevMode,
    isPackaged,
  });
  const explicitAppName = allowIdentityOverrides
    ? env.OPENWORK_ELECTRON_APP_NAME?.trim()
    : "";
  const appName = explicitAppName ||
    (effectiveDevMode
      ? `${productProfile.brand.name} - Dev`
      : productProfile.brand.name);
  const protocol = productProfile.features.connectLinks
    ? productProfile.brand.protocol
    : null;

  return Object.freeze({
    appName,
    productionAppIdentifier,
    devAppIdentifier,
    appIdentifier,
    appUserModelId: appIdentifier,
    protocol,
    publicDeepLinksEnabled: typeof protocol === "string" && protocol.length > 0,
    allowIdentityOverrides,
  });
}

/**
 * @param {string[]} argv
 * @param {string | null} protocol
 * @returns {string[]}
 */
export function forwardedProductDeepLinks(argv, protocol) {
  if (!protocol) return [];
  const protocolPrefix = `${protocol}://`;
  const devProtocolPrefix = `${protocol}-dev://`;
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith(protocolPrefix) ||
        entry.startsWith(devProtocolPrefix) ||
        entry.startsWith("https://") ||
        entry.startsWith("http://"),
    );
}

export function productFeatureDisabledResult() {
  return Object.freeze({
    ok: false,
    code: "feature_disabled",
  });
}
