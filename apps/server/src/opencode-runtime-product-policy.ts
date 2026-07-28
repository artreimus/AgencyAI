import { isOpenworkCloudMcpName } from "./mcp-product-policy.js";

export const LOCAL_MVP_HOSTED_PROVIDER_ID = "opencode";

type MutableLocalOpencodeConfig = {
  autoupdate?: unknown;
  share?: unknown;
  disabled_providers?: unknown;
  provider?: unknown;
  mcp?: unknown;
  experimental?: unknown;
  instructions?: unknown;
  skills?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRestrictedProviderId(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isLocalMvpBlockedProviderId(value: string): boolean {
  const providerId = normalizeRestrictedProviderId(value);
  return providerId === "openwork" || providerId.startsWith("lpr_");
}

export function withoutLocalMvpBlockedProviders(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([providerId]) => !isLocalMvpBlockedProviderId(providerId),
    ),
  );
}

export function withLocalMvpRequiredDisabledProviders(
  value: unknown,
): string[] {
  const providers = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const normalized = new Set(
    providers.map((providerId) => normalizeRestrictedProviderId(providerId)),
  );
  return normalized.has(LOCAL_MVP_HOSTED_PROVIDER_ID)
    ? providers
    : [...providers, LOCAL_MVP_HOSTED_PROVIDER_ID];
}

function isRemoteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function withoutRemoteInstructionUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && !isRemoteHttpUrl(entry),
  );
}

export function withoutRemoteSkillUrls(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const paths = Array.isArray(value.paths)
    ? value.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return paths.length ? { paths } : {};
}

/**
 * Final defense-in-depth hook for OpenCode's fully merged config. The wrapper
 * also validates its own write APIs, but config files may predate AgencyAI or
 * be edited outside the app.
 */
export function enforceAgencyAiLocalRuntimePolicy(
  config: MutableLocalOpencodeConfig,
): void {
  config.autoupdate = false;
  config.share = "disabled";
  config.disabled_providers = withLocalMvpRequiredDisabledProviders(
    config.disabled_providers,
  );
  config.provider = withoutLocalMvpBlockedProviders(config.provider);
  config.instructions = withoutRemoteInstructionUrls(config.instructions);
  config.skills = withoutRemoteSkillUrls(config.skills);

  if (isRecord(config.mcp)) {
    for (const name of Object.keys(config.mcp)) {
      if (isOpenworkCloudMcpName(name)) delete config.mcp[name];
    }
  }

  const experimental = isRecord(config.experimental)
    ? config.experimental
    : {};
  config.experimental = {
    ...experimental,
    openTelemetry: false,
  };
}
