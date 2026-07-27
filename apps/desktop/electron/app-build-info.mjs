import { getBuildProductProfile } from "@openwork/product-config";

/**
 * @typedef {import("@openwork/types/desktop-ipc").AppBuildInfo} AppBuildInfo
 * @typedef {{
 *   appVersion?: string,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string | null,
 *   arch?: string | null,
 * }} AppBuildInfoOptions
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

/**
 * @param {AppBuildInfoOptions} [options]
 * @returns {Readonly<AppBuildInfo>}
 */
export function createAppBuildInfo({
  appVersion = "",
  env = {},
  platform = null,
  arch = null,
} = {}) {
  return Object.freeze({
    version: typeof appVersion === "string" && appVersion.trim()
      ? appVersion.trim()
      : "0.0.0",
    gitSha: optionalString(env.OPENWORK_GIT_SHA),
    buildEpoch: optionalString(env.OPENWORK_BUILD_EPOCH),
    openworkDevMode: env.OPENWORK_DEV_MODE === "1",
    os: optionalString(platform),
    arch: optionalString(arch),
    productProfile: getBuildProductProfile(),
  });
}
