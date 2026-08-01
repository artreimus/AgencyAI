import { describe, expect, test } from "bun:test";

import { DEFAULT_MODEL } from "../src/app/constants";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { resolveFirstConnectedModel } from "../src/react-app/infra/provider-list-query";
import { resolveProductDefaultModel } from "../src/react-app/kernel/model-config";
import { resolveLocalRuntimeStatus } from "../src/react-app/domains/session/sidebar/local-account-status-menu";

describe("AgencyAI local model readiness", () => {
  test("does not seed the hosted OpenCode model into the local-only product", () => {
    expect(resolveProductDefaultModel(DEFAULT_MODEL, "local-mvp")).toBeNull();
    expect(resolveProductDefaultModel(null, "local-mvp")).toBeNull();
    expect(resolveProductDefaultModel(
      { providerID: "openai", modelID: "gpt-5" },
      "local-mvp",
    )).toEqual({ providerID: "openai", modelID: "gpt-5" });
  });

  test("preserves the upstream hosted-model fallback", () => {
    expect(resolveProductDefaultModel(null, "upstream")).toEqual(DEFAULT_MODEL);
  });

  test("selects a connected provider default after first authentication", () => {
    const providers = {
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet-4-5" },
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          env: [],
          options: {},
          models: {
            "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
            "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          },
        },
      ],
    } as unknown as ProviderListResponse;

    expect(resolveFirstConnectedModel(providers)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  test("reports a ready workspace separately from model setup", () => {
    expect(resolveLocalRuntimeStatus({
      clientConnected: true,
      loading: false,
      reloadBusy: false,
      reloadError: null,
      providerConnectedIds: [],
    })).toEqual({
      state: "connected",
      label: "Workspace ready — connect a provider",
    });
  });
});
