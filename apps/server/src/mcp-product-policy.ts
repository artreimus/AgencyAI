export const OPENWORK_CLOUD_MCP_POLICY_NAME = "openwork-cloud";

export type McpOriginalEnabledState =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: unknown }>;

export type DisabledCloudMcpProjection = Readonly<{
  mcp: Record<string, Record<string, unknown>>;
  originalEnabledByName: Readonly<Record<string, McpOriginalEnabledState>>;
  changed: boolean;
}>;

export function normalizeMcpPolicyName(name: string): string {
  return name.trim().toLowerCase();
}

export function isOpenworkCloudMcpName(name: string): boolean {
  return normalizeMcpPolicyName(name) === OPENWORK_CLOUD_MCP_POLICY_NAME;
}

export function withoutOpenworkCloudMcp(
  mcp: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  if (!Object.keys(mcp).some(isOpenworkCloudMcpName)) return mcp;
  return Object.fromEntries(
    Object.entries(mcp).filter(([name]) => !isOpenworkCloudMcpName(name)),
  );
}

export function disableOpenworkCloudMcp(
  mcp: Record<string, Record<string, unknown>>,
): DisabledCloudMcpProjection {
  let changed = false;
  const next: Record<string, Record<string, unknown>> = {};
  const originalEnabledByName: Record<string, McpOriginalEnabledState> = {};

  for (const [name, entry] of Object.entries(mcp)) {
    if (!isOpenworkCloudMcpName(name)) {
      next[name] = entry;
      continue;
    }

    originalEnabledByName[name] = Object.hasOwn(entry, "enabled")
      ? { present: true, value: entry.enabled }
      : { present: false };
    if (entry.enabled === false) {
      next[name] = entry;
      continue;
    }
    changed = true;
    next[name] = { ...entry, enabled: false };
  }

  return {
    mcp: changed ? next : mcp,
    originalEnabledByName,
    changed,
  };
}
