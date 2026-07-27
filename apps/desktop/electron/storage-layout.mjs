import { mkdir } from "node:fs/promises";
import path from "node:path";

const STORAGE_LAYOUT_ENVIRONMENT_KEYS = Object.freeze([
  "OPENWORK_CACHE_DIR",
  "OPENWORK_DATA_DIR",
  "OPENWORK_DESKTOP_BOOTSTRAP_PATH",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_STORAGE_ROOT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

/**
 * @typedef {Readonly<{
 *   root: string,
 *   userData: string,
 *   sessionData: string,
 *   logs: string,
 *   crashDumps: string,
 *   openworkConfig: string,
 *   openworkData: string,
 *   openworkCache: string,
 *   runtimeDb: string,
 *   bootstrap: string,
 *   opencodeConfig: string,
 *   opencodeData: string,
 *   opencodeCache: string,
 *   opencodeState: string,
 *   mcpAuth: string,
 * }>} StorageLayout
 */

/**
 * @typedef {Readonly<{
 *   root: string,
 *   environment: Readonly<Record<string, string>>,
 * }>} StorageRuntimeProjection
 */

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function layoutPathApi(layout) {
  return /^[A-Za-z]:[\\/]/.test(layout.root) || layout.root.startsWith("\\\\")
    ? path.win32
    : path.posix;
}

function optionalPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireAbsolutePath(value, label, paths) {
  const normalized = optionalPath(value);
  if (!normalized || !paths.isAbsolute(normalized)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return paths.normalize(normalized);
}

function requireAppIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("appIdentifier must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function isPathInside(root, candidate, paths) {
  const relative = paths.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

/**
 * Resolve every application-owned path from one root. Overrides are inputs to
 * this pure function; callers decide whether the current runtime is allowed to
 * supply them.
 *
 * @param {{
 *   appDataPath: string,
 *   appIdentifier: string,
 *   platform?: NodeJS.Platform,
 *   storageRootOverride?: string | null,
 *   userDataOverride?: string | null,
 * }} options
 * @returns {StorageLayout}
 */
export function resolveStorageLayout({
  appDataPath,
  appIdentifier,
  platform = process.platform,
  storageRootOverride = null,
  userDataOverride = null,
}) {
  const paths = pathApi(platform);
  const appData = requireAbsolutePath(appDataPath, "appDataPath", paths);
  const identifier = requireAppIdentifier(appIdentifier);
  const explicitRoot = optionalPath(storageRootOverride);
  const explicitUserData = optionalPath(userDataOverride);
  const root = explicitRoot
    ? requireAbsolutePath(explicitRoot, "storageRootOverride", paths)
    : explicitUserData
      ? requireAbsolutePath(explicitUserData, "userDataOverride", paths)
      : paths.join(appData, identifier);
  const userData = explicitUserData
    ? requireAbsolutePath(explicitUserData, "userDataOverride", paths)
    : paths.join(root, "electron", "user-data");

  if (!isPathInside(root, userData, paths)) {
    throw new Error("userDataOverride must be inside storageRootOverride");
  }

  const configRoot = paths.join(root, "config");
  const dataRoot = paths.join(root, "data");
  const cacheRoot = paths.join(root, "cache");
  const stateRoot = paths.join(root, "state");
  const openworkConfig = paths.join(configRoot, "openwork");
  const openworkData = paths.join(dataRoot, "openwork");
  const opencodeData = paths.join(dataRoot, "opencode");

  return Object.freeze({
    root,
    userData,
    sessionData: paths.join(root, "electron", "session-data"),
    logs: paths.join(root, "logs"),
    crashDumps: paths.join(root, "crash-dumps"),
    openworkConfig,
    openworkData,
    openworkCache: paths.join(cacheRoot, "openwork"),
    runtimeDb: paths.join(openworkData, "runtime.sqlite"),
    bootstrap: paths.join(openworkConfig, "desktop-bootstrap.json"),
    opencodeConfig: paths.join(configRoot, "opencode"),
    opencodeData,
    opencodeCache: paths.join(cacheRoot, "opencode"),
    opencodeState: paths.join(stateRoot, "opencode"),
    mcpAuth: paths.join(opencodeData, "mcp-auth.json"),
  });
}

/**
 * Production local-mvp builds intentionally ignore inherited path overrides.
 * Unpackaged development/tests may opt into either explicit override.
 *
 * @param {{
 *   appDataPath: string,
 *   appIdentifier: string,
 *   env?: NodeJS.ProcessEnv,
 *   isPackaged?: boolean,
 *   productProfile?: string,
 *   platform?: NodeJS.Platform,
 * }} options
 * @returns {StorageLayout}
 */
export function resolveElectronStorageLayout({
  appDataPath,
  appIdentifier,
  env = process.env,
  isPackaged = false,
  productProfile = "upstream",
  platform = process.platform,
}) {
  const allowOverrides = productProfile !== "local-mvp" || !isPackaged;
  return resolveStorageLayout({
    appDataPath,
    appIdentifier,
    platform,
    storageRootOverride: allowOverrides ? env.OPENWORK_ELECTRON_STORAGE_ROOT : null,
    userDataOverride: allowOverrides ? env.OPENWORK_ELECTRON_USERDATA : null,
  });
}

/**
 * @param {StorageLayout} layout
 * @returns {Readonly<Record<string, string>>}
 */
export function storageLayoutEnvironment(layout) {
  const paths = layoutPathApi(layout);
  const configRoot = paths.dirname(layout.openworkConfig);
  const dataRoot = paths.dirname(layout.openworkData);
  const cacheRoot = paths.dirname(layout.openworkCache);
  const stateRoot = paths.dirname(layout.opencodeState);

  return Object.freeze({
    OPENWORK_CACHE_DIR: layout.openworkCache,
    OPENWORK_DATA_DIR: layout.openworkData,
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: layout.bootstrap,
    OPENWORK_ENV_STORE: paths.join(layout.openworkConfig, "env.json"),
    OPENWORK_MCP_AUTH_PATH: layout.mcpAuth,
    OPENWORK_RUNTIME_DB: layout.runtimeDb,
    OPENWORK_SERVER_CONFIG: paths.join(layout.openworkConfig, "server.json"),
    OPENWORK_STORAGE_ROOT: layout.root,
    OPENCODE_CONFIG_DIR: layout.opencodeConfig,
    OPENCODE_DB: paths.join(layout.opencodeData, "opencode.db"),
    XDG_CACHE_HOME: cacheRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_STATE_HOME: stateRoot,
  });
}

/**
 * Overwrite every application-owned path without replacing HOME/USERPROFILE.
 *
 * @param {NodeJS.ProcessEnv} target
 * @param {StorageLayout} layout
 * @returns {NodeJS.ProcessEnv}
 */
export function applyStorageLayoutEnvironment(target, layout) {
  Object.assign(target, storageLayoutEnvironment(layout));
  return target;
}

/**
 * Produce the non-secret runtime proof surface. General environment variables
 * are never copied, even when the caller passes them alongside the allowlist.
 *
 * @param {StorageLayout} layout
 * @param {NodeJS.ProcessEnv | Readonly<Record<string, string>>} environment
 * @returns {StorageRuntimeProjection}
 */
export function createStorageRuntimeProjection(layout, environment) {
  /** @type {Record<string, string>} */
  const environmentProjection = {};
  for (const key of STORAGE_LAYOUT_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string") environmentProjection[key] = value;
  }
  return Object.freeze({
    root: layout.root,
    environment: Object.freeze(environmentProjection),
  });
}

/**
 * @param {StorageLayout} layout
 * @param {{ mkdirFn?: typeof mkdir }} [options]
 * @returns {Promise<StorageLayout>}
 */
export async function ensureStorageLayout(layout, { mkdirFn = mkdir } = {}) {
  const paths = layoutPathApi(layout);
  const directories = new Set([
    layout.root,
    layout.userData,
    layout.sessionData,
    layout.logs,
    layout.crashDumps,
    layout.openworkConfig,
    layout.openworkData,
    layout.openworkCache,
    paths.dirname(layout.runtimeDb),
    paths.dirname(layout.bootstrap),
    layout.opencodeConfig,
    layout.opencodeData,
    layout.opencodeCache,
    layout.opencodeState,
    paths.dirname(layout.mcpAuth),
  ]);
  await Promise.all(
    Array.from(directories, (directory) =>
      mkdirFn(directory, { recursive: true, mode: 0o700 })),
  );
  return layout;
}

export { STORAGE_LAYOUT_ENVIRONMENT_KEYS };
