import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENCYAI_LOCAL_OPENCODE_PLUGIN_NAMES } from "@openwork/product-config";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function openworkPluginPath(
  name: string,
  here?: string,
  options: { allowEnvironmentOverride?: boolean } = {},
): string {
  const pluginDir = options.allowEnvironmentOverride === false
    ? undefined
    : process.env.OPENWORK_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const openworkExtensionsPreviewPluginPath = () => openworkPluginPath("openwork-extensions-preview");
export const openworkCapabilitiesKnowledgePluginPath = () => openworkPluginPath("openwork-capabilities-knowledge");
export const openworkAnthropicAdaptiveThinkingPluginPath = () => openworkPluginPath("openwork-anthropic-adaptive-thinking");
export const openworkAnthropicToolSchemaPluginPath = () => openworkPluginPath("openwork-anthropic-tool-schema");
export const openworkOfficeAttachmentsPluginPath = () => openworkPluginPath("openwork-office-attachments");

export const AGENCYAI_LOCAL_PLUGIN_NAMES =
  AGENCYAI_LOCAL_OPENCODE_PLUGIN_NAMES;

export function isAllowedAgencyAiLocalPluginSpec(
  spec: string,
  packageRoot: string,
): boolean {
  let candidate: string;
  try {
    const url = new URL(spec);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    candidate = resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  let root: string;
  let candidatePath: string;
  try {
    const candidateStat = lstatSync(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return false;
    root = realpathSync(resolve(packageRoot));
    candidatePath = realpathSync(candidate);
  } catch {
    return false;
  }
  const relativePath = relative(root, candidatePath);
  if (
    !relativePath
    || relativePath.startsWith("..")
    || relativePath.includes("/")
    || relativePath.includes("\\")
  ) {
    return false;
  }
  const extension = relativePath.endsWith(".js")
    ? ".js"
    : relativePath.endsWith(".ts")
      ? ".ts"
      : "";
  if (!extension) return false;
  return AGENCYAI_LOCAL_PLUGIN_NAMES.includes(
    relativePath.slice(0, -extension.length) as typeof AGENCYAI_LOCAL_PLUGIN_NAMES[number],
  );
}

export function agencyAiLocalPluginUrls(here?: string): string[] {
  const paths = AGENCYAI_LOCAL_PLUGIN_NAMES.map((name) =>
    openworkPluginPath(name, here, { allowEnvironmentOverride: false }));
  const packageRoot = dirname(paths[0] ?? "");
  const specs = paths.map((pluginPath) => pathToFileURL(pluginPath).href);
  for (const spec of specs) {
    if (!isAllowedAgencyAiLocalPluginSpec(spec, packageRoot)) {
      throw new Error(`AgencyAI rejected unpackaged OpenCode plugin spec: ${spec}`);
    }
  }
  return specs;
}
