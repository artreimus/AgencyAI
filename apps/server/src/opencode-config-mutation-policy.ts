import { parse, printParseErrorCode } from "jsonc-parser";

import { ApiError } from "./errors.js";
import { isOpenworkCloudMcpName } from "./mcp-product-policy.js";
import { isLocalMvpBlockedProviderId } from "./opencode-runtime-product-policy.js";
import {
  isLocalMvpProduct,
  type ServerProductPolicy,
} from "./product-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function featureDisabled(message: string): never {
  throw new ApiError(404, "feature_disabled", message);
}

function assertPluginMutationAllowed(value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  featureDisabled("Runtime plugin installation is disabled");
}

function assertProviderMutationAllowed(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [providerId, provider] of Object.entries(value)) {
    // Explicit null is the per-provider deletion contract.
    if (provider !== null && isLocalMvpBlockedProviderId(providerId)) {
      featureDisabled(`Provider ${providerId.trim()} is disabled`);
    }
  }
}

function assertMcpMutationAllowed(value: unknown): void {
  if (!isRecord(value)) return;
  for (const name of Object.keys(value)) {
    if (isOpenworkCloudMcpName(name)) {
      featureDisabled("OpenWork Cloud MCP is disabled");
    }
  }
}

/**
 * Validate the subset accepted by PATCH /workspace/:id/config. Empty plugin
 * arrays and provider null-deletes remain allowed because they only remove
 * state.
 */
export function assertRuntimeOpencodeMutationAllowed(
  productPolicy: ServerProductPolicy | undefined,
  update: Record<string, unknown>,
): void {
  if (!isLocalMvpProduct(productPolicy)) return;
  if (Object.hasOwn(update, "plugin")) {
    assertPluginMutationAllowed(update.plugin);
  }
  assertProviderMutationAllowed(update.provider);
  assertMcpMutationAllowed(update.mcp);
}

function parseJsoncObject(content: string): Record<string, unknown> {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const value: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ApiError(
      422,
      "invalid_jsonc",
      "Failed to parse JSONC",
      errors.map((error) => ({
        code: printParseErrorCode(error.error),
        offset: error.offset,
        length: error.length,
      })),
    );
  }
  if (!isRecord(value)) {
    throw new ApiError(
      422,
      "invalid_jsonc",
      "OpenCode config must be a JSON object",
    );
  }
  return value;
}

/**
 * Raw config writes are a privileged escape hatch. Local-MVP keeps project
 * writes for ordinary local configuration, but global writes and any field
 * that can re-enable a compiled-out capability fail before approval or disk
 * mutation.
 */
export function assertRawOpencodeConfigMutationAllowed(
  productPolicy: ServerProductPolicy | undefined,
  scope: "project" | "global",
  content: string,
): void {
  if (!isLocalMvpProduct(productPolicy)) return;
  if (scope === "global") {
    featureDisabled("Global OpenCode config writes are disabled");
  }

  const config = parseJsoncObject(content);
  assertRuntimeOpencodeMutationAllowed(productPolicy, config);

  if (Object.hasOwn(config, "autoupdate") && config.autoupdate !== false) {
    featureDisabled("OpenCode automatic updates are disabled");
  }
  if (Object.hasOwn(config, "share") && config.share !== "disabled") {
    featureDisabled("Remote session sharing is disabled");
  }
  const experimental = isRecord(config.experimental)
    ? config.experimental
    : null;
  if (
    experimental
    && Object.hasOwn(experimental, "openTelemetry")
    && experimental.openTelemetry !== false
  ) {
    featureDisabled("OpenCode telemetry is disabled");
  }
}
