import { enforceAgencyAiLocalRuntimePolicy } from "../opencode-runtime-product-policy.js";

type MutableOpenCodeConfig = {
  autoupdate?: unknown;
  share?: unknown;
  disabled_providers?: unknown;
  provider?: unknown;
  mcp?: Record<string, unknown>;
  experimental?: unknown;
  instructions?: unknown;
  skills?: unknown;
};

function enforceAgencyAiLocalMcpPolicy(config: MutableOpenCodeConfig): void {
  enforceAgencyAiLocalRuntimePolicy(config);
}

/**
 * This plugin must remain last in the local runtime plugin list. OpenCode
 * invokes config hooks after merging its config layers, so this guard also
 * removes a blocked MCP supplied by project or user-level configuration.
 */
export const AgencyAiLocalPolicy = async () => ({
  config: async (input: MutableOpenCodeConfig) => {
    enforceAgencyAiLocalRuntimePolicy(input);
  },
});
