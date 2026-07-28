import { homedir, platform } from "node:os";
import {
  join,
} from "node:path";
import {
  legacyOpenWorkImportEnabled,
  type ServerProductPolicy,
} from "../product-policy.js";
import { getBuildProductProfile } from "@openwork/product-config";
import { localUiControlDiscoveryPaths } from "./local-ui-control-discovery.js";

type UiControlDiscoveryOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  productPolicy?: ServerProductPolicy;
  localOnly?: boolean;
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
  if (
    options?.localOnly === true
    || !legacyOpenWorkImportEnabled(options?.productPolicy)
  ) {
    return localUiControlDiscoveryPaths({ env });
  }

  const brand = getBuildProductProfile().brand;
  return [
    explicit,
    join(
      userAppDataDir(options),
      brand.appId,
      "openwork-ui-control.json",
    ),
    join(
      userAppDataDir(options),
      brand.devAppId,
      "openwork-ui-control.json",
    ),
  ].filter((path): path is string => Boolean(path));
}
