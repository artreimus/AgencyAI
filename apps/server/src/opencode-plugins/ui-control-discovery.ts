import { homedir, platform } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  legacyOpenWorkImportEnabled,
  type ServerProductPolicy,
} from "../product-policy.js";

type UiControlDiscoveryOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  productPolicy?: ServerProductPolicy;
}>;

function userAppDataDir(options?: UiControlDiscoveryOptions): string {
  const env = options?.env ?? process.env;
  const currentPlatform = options?.platform ?? platform();
  const currentHome = options?.homeDir ?? homedir();
  if (currentPlatform === "darwin") {
    return join(currentHome, "Library", "Application Support");
  }
  if (currentPlatform === "win32") {
    return env.APPDATA || join(currentHome, "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME || join(currentHome, ".config");
}

export function uiControlDiscoveryPaths(
  options?: UiControlDiscoveryOptions,
): string[] {
  const env = options?.env ?? process.env;
  const explicit = env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  if (!legacyOpenWorkImportEnabled(options?.productPolicy)) {
    const storageRoot = env.OPENWORK_STORAGE_ROOT?.trim();
    if (
      !explicit
      || !storageRoot
      || !isAbsolute(explicit)
      || !isAbsolute(storageRoot)
    ) {
      return [];
    }
    const root = resolve(storageRoot);
    const candidate = resolve(explicit);
    const child = relative(root, candidate);
    if (
      child === ".."
      || child.startsWith(`..${sep}`)
      || isAbsolute(child)
    ) {
      return [];
    }
    return [candidate];
  }

  return [
    explicit,
    join(
      userAppDataDir(options),
      "com.differentai.openwork",
      "openwork-ui-control.json",
    ),
    join(
      userAppDataDir(options),
      "com.differentai.openwork.dev",
      "openwork-ui-control.json",
    ),
  ].filter((path): path is string => Boolean(path));
}
