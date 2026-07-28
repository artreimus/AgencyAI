import { describe, expect, test } from "bun:test";
import {
  AgencyAiLocalCapabilities,
  agencyAiLocalCapabilitiesPrompt,
} from "./agencyai-local-capabilities.js";

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

describe("AgencyAI local capabilities plugin", () => {
  test("injects local guidance with no hosted-product steering", async () => {
    const prompt = agencyAiLocalCapabilitiesPrompt();
    expect(prompt).toContain("AgencyAI");
    expect(prompt).toContain("local workspace");
    expect(prompt).toContain("MCP servers");
    expect(prompt).toContain("Skills");
    expect(prompt).toContain("artifacts");
    for (const forbidden of FORBIDDEN_LOCAL_STEERING) {
      expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    const plugin = await AgencyAiLocalCapabilities();
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({}, output);
    expect(output.system).toEqual([prompt]);
  });
});
