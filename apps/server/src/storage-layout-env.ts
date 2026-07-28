import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  globalOpencodeConfigDir,
  opencodeDataDirs,
  resolveGlobalOpencodeConfigPath,
} from "@openwork/paths";
import {
  isLocalMvpProduct,
  resolveServerProductPolicy,
  type ServerProductPolicy,
} from "./product-policy.js";

export const LOCAL_STORAGE_LAYOUT_PATH_KEYS = [
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_ENV_STORE",
  "OPENWORK_DATA_DIR",
  "OPENWORK_CACHE_DIR",
  "OPENWORK_DESKTOP_BOOTSTRAP_PATH",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_MCP_AUTH_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
] as const;

export type LocalStorageLayoutPathKey =
  (typeof LOCAL_STORAGE_LAYOUT_PATH_KEYS)[number];

export type LocalStorageLayoutAttestation = Readonly<{
  root: string;
  environment: Readonly<Record<string, string>>;
}>;

type StorageEnvironment = Readonly<Record<string, string | undefined>>;

type StoragePolicyOptions = Readonly<{
  env?: StorageEnvironment;
  productPolicy?: ServerProductPolicy;
}>;

export class LocalStorageLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStorageLayoutError";
  }
}

function optionEnv(options?: StoragePolicyOptions): StorageEnvironment {
  return options?.env ?? process.env;
}

function normalizedEnvValue(
  env: StorageEnvironment,
  key: string,
): string {
  return env[key]?.trim() ?? "";
}

function requireAbsolutePath(
  env: StorageEnvironment,
  key: string,
): string {
  const value = normalizedEnvValue(env, key);
  if (!value) {
    throw new LocalStorageLayoutError(
      `local-mvp requires ${key} from the StorageLayout environment`,
    );
  }
  if (!isAbsolute(value)) {
    throw new LocalStorageLayoutError(
      `local-mvp requires ${key} to be an absolute path`,
    );
  }
  return resolve(value);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === ""
    || (
      child !== ".."
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child)
    );
}

function requirePathInsideRoot(
  env: StorageEnvironment,
  key: LocalStorageLayoutPathKey,
  root: string,
): string {
  const candidate = requireAbsolutePath(env, key);
  if (!isInsideRoot(root, candidate)) {
    throw new LocalStorageLayoutError(
      `local-mvp requires ${key} to stay inside OPENWORK_STORAGE_ROOT`,
    );
  }
  return candidate;
}

function expectedLocalStorageLayoutEnvironment(
  root: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    OPENWORK_CACHE_DIR: join(root, "cache", "openwork"),
    OPENWORK_DATA_DIR: join(root, "data", "openwork"),
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: join(
      root,
      "config",
      "openwork",
      "desktop-bootstrap.json",
    ),
    OPENWORK_ENV_STORE: join(root, "config", "openwork", "env.json"),
    OPENWORK_MCP_AUTH_PATH: join(root, "data", "opencode", "mcp-auth.json"),
    OPENWORK_RUNTIME_DB: join(root, "data", "openwork", "runtime.sqlite"),
    OPENWORK_SERVER_CONFIG: join(root, "config", "openwork", "server.json"),
    OPENWORK_STORAGE_ROOT: root,
    OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
    OPENCODE_DB: join(root, "data", "opencode", "opencode.db"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
  });
}

/**
 * Validates the complete Electron-to-server storage contract before the
 * embedded server resolves config or touches the filesystem. The returned
 * attestation is built from the values the server actually validated; it is
 * safe to expose because the allowlist contains paths only.
 */
export function assertLocalStorageLayoutEnvironment(
  options?: StoragePolicyOptions,
): LocalStorageLayoutAttestation | null {
  const policy = resolveServerProductPolicy(options?.productPolicy);
  if (!isLocalMvpProduct(policy)) return null;

  const env = optionEnv(options);
  const root = requireAbsolutePath(env, "OPENWORK_STORAGE_ROOT");
  const expected = expectedLocalStorageLayoutEnvironment(root);
  for (const key of LOCAL_STORAGE_LAYOUT_PATH_KEYS) {
    const actual = requirePathInsideRoot(env, key, root);
    if (actual !== expected[key]) {
      throw new LocalStorageLayoutError(
        `local-mvp requires ${key} to match the exact StorageLayout path ${expected[key]}`,
      );
    }
  }
  return Object.freeze({
    root,
    environment: expected,
  });
}

/**
 * Returns a validated product-owned path once the local StorageLayout marker
 * is present. Direct unit-level server composition without that launch marker
 * retains upstream-compatible fallbacks; the public local launch entrypoints
 * call assertLocalStorageLayoutEnvironment first and therefore cannot do so.
 */
export function resolveLocalStorageLayoutPath(
  key: LocalStorageLayoutPathKey,
  options?: StoragePolicyOptions,
): string | null {
  const policy = resolveServerProductPolicy(options?.productPolicy);
  if (!isLocalMvpProduct(policy)) return null;

  const env = optionEnv(options);
  const configuredRoot = normalizedEnvValue(env, "OPENWORK_STORAGE_ROOT");
  if (!configuredRoot) return null;
  if (!isAbsolute(configuredRoot)) {
    throw new LocalStorageLayoutError(
      "local-mvp requires OPENWORK_STORAGE_ROOT to be an absolute path",
    );
  }
  return requirePathInsideRoot(env, key, resolve(configuredRoot));
}

export function resolveProfileGlobalOpencodeConfigDir(
  options?: StoragePolicyOptions,
): string {
  const env = optionEnv(options);
  return resolveLocalStorageLayoutPath("OPENCODE_CONFIG_DIR", options)
    ?? globalOpencodeConfigDir({ env });
}

export function resolveProfileGlobalOpencodeConfigPath(
  options?: StoragePolicyOptions,
): string {
  const env = optionEnv(options);
  const localConfigDir = resolveLocalStorageLayoutPath(
    "OPENCODE_CONFIG_DIR",
    options,
  );
  return resolveGlobalOpencodeConfigPath({
    env: localConfigDir
      ? { ...env, OPENCODE_CONFIG_DIR: localConfigDir }
      : env,
  });
}

export function resolveMcpAuthStorePath(
  options?: StoragePolicyOptions,
): string {
  const env = optionEnv(options);
  const localPath = resolveLocalStorageLayoutPath(
    "OPENWORK_MCP_AUTH_PATH",
    options,
  );
  if (localPath) return localPath;

  const override = normalizedEnvValue(env, "OPENWORK_MCP_AUTH_PATH");
  if (override) {
    if (!isAbsolute(override)) {
      throw new LocalStorageLayoutError(
        "OPENWORK_MCP_AUTH_PATH must be an absolute path",
      );
    }
    return resolve(override);
  }

  const dataDir = opencodeDataDirs({ env })[0];
  if (!dataDir) {
    throw new LocalStorageLayoutError(
      "Unable to resolve the OpenCode data directory for MCP authentication",
    );
  }
  return resolve(dataDir, "mcp-auth.json");
}
