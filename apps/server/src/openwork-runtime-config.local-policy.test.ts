import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  buildOpenworkRuntimeConfigObjectFromSnapshot,
} from "./openwork-runtime-config.js";
import { agencyAiLocalCapabilitiesPrompt } from "./opencode-plugins/agencyai-local-capabilities.js";

const FORBIDDEN_LOCAL_STEERING = [
  "OpenWork Cloud",
  "OpenWork Connect",
  "openwork-cloud",
  "Memory Bank",
  "search_capabilities",
  "execute_capability",
  "Google Workspace",
  "Voice Mode",
  "OpenAI Realtime",
  "Settings > Connect",
  "app.openworklabs.com",
  "api.openworklabs.com",
  "models.openworklabs.com",
  "/mcp/agent",
  "Den sign-in",
];

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeObject();
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  return (value as unknown[]).filter((item): item is string => typeof item === "string");
}

describe("local-mvp generated OpenCode config", () => {
  test("uses AgencyAI guidance and a local-only built-in plugin composition", () => {
    const generated = buildOpenworkRuntimeConfigObjectFromSnapshot({
      default_agent: "openwork",
      disabled_providers: ["unused-provider"],
      provider: {
        local: {
          name: "Local provider",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
        },
      },
      permission: {
        external_directory: {
          "/authorized/**": "allow",
        },
      },
      experimental: {
        allowedLocalSetting: "preserved",
        openTelemetry: true,
      },
      instructions: [
        "./LOCAL.md",
        "/absolute/local.md",
        "https://instructions.invalid/AGENTS.md",
        "HTTP://instructions.invalid/mixed-case",
      ],
      skills: {
        paths: ["./.opencode/skills", "/absolute/local-skills"],
        urls: [
          "https://skills.invalid/.well-known/skills/",
          "http://127.0.0.1:43210/skills",
        ],
      },
      plugin: [
        "/plugins/user-plugin.ts",
        "/plugins/openwork-extensions-preview.ts",
        "C:\\plugins\\OPENWORK-CAPABILITIES-KNOWLEDGE.js?stale=1",
      ],
      mcp: {
        "openwork-cloud": { type: "remote", url: "https://blocked.example/mcp" },
        " OpenWork-Cloud ": { type: "remote", url: "https://blocked-2.example/mcp" },
        ordinary: { type: "local", command: ["ordinary"] },
        "openwork-cloud-dev": { type: "local", command: ["near-match"] },
      },
    }, true);

    expect(generated.default_agent).toBe("agencyai");
    const agent = record(record(generated.agent).agencyai);
    const prompt = typeof agent.prompt === "string" ? agent.prompt : "";
    const plugins = strings(generated.plugin);
    const pluginNames = plugins.map((plugin) => basename(plugin.replace(/\\/g, "/")));

    expect(prompt).toContain("You are AgencyAI.");
    expect(prompt).toContain("current local workspace");
    expect(prompt).toContain("MCP servers");
    expect(prompt).toContain("Artifacts");
    expect(pluginNames).toContain("agencyai-local-capabilities.ts");
    expect(pluginNames).toContain("openwork-office-attachments.ts");
    expect(pluginNames).not.toContain("user-plugin.ts");
    expect(pluginNames).not.toContain("openwork-extensions-preview.ts");
    expect(pluginNames).not.toContain("openwork-capabilities-knowledge.ts");
    expect(pluginNames.at(-1)).toBe("agencyai-local-policy.ts");
    expect(generated.disabled_providers).toEqual(["unused-provider", "opencode"]);
    expect(generated.experimental).toEqual({
      allowedLocalSetting: "preserved",
      openTelemetry: false,
    });
    expect(generated.instructions).toEqual([
      "./LOCAL.md",
      "/absolute/local.md",
    ]);
    expect(generated.skills).toEqual({
      paths: ["./.opencode/skills", "/absolute/local-skills"],
    });
    expect(generated.provider).toEqual({
      local: {
        name: "Local provider",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
      },
    });
    expect(record(record(generated.permission).external_directory)["/authorized/**"]).toBe("allow");
    expect(generated.mcp).toEqual({
      ordinary: { type: "local", command: ["ordinary"] },
      "openwork-cloud-dev": { type: "local", command: ["near-match"] },
    });

    const localGuidance = `${prompt}\n${agencyAiLocalCapabilitiesPrompt()}`;
    for (const forbidden of FORBIDDEN_LOCAL_STEERING) {
      expect(localGuidance.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("keeps the upstream snapshot composition unchanged when local policy is off", () => {
    const cloud = { type: "remote", url: "https://blocked.example/mcp" };
    const generated = buildOpenworkRuntimeConfigObjectFromSnapshot({
      mcp: {
        "openwork-cloud": cloud,
        ordinary: { type: "local", command: ["ordinary"] },
      },
    }, false);

    expect(generated.default_agent).toBe("openwork");
    const agent = record(record(generated.agent).openwork);
    expect(agent.prompt).toContain("## Memory Bank");
    const plugins = strings(generated.plugin).join("\n");
    expect(plugins).toContain("openwork-extensions-preview");
    expect(plugins).toContain("openwork-capabilities-knowledge");
    expect(record(generated.mcp)["openwork-cloud"]).toBe(cloud);
  });
});
