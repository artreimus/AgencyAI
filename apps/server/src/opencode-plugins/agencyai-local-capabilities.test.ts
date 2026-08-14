import { describe, expect, test } from "bun:test";
import { AgencyAiLocalCapabilities } from "./agencyai-local-capabilities.js";

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
    const plugin = await AgencyAiLocalCapabilities();
    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({}, output);
    const [prompt] = output.system;

    expect(prompt).toContain("AgencyAI");
    expect(prompt).toContain("local workspace");
    expect(prompt).toContain("MCP servers");
    expect(prompt).toContain("Skills");
    expect(prompt).toContain("artifacts");
    expect(prompt).toContain("agencyai_docs_search");
    expect(prompt).toContain("agencyai_docs_read");
    for (const forbidden of FORBIDDEN_LOCAL_STEERING) {
      expect(prompt.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(output.system).toEqual([prompt]);
  });

  test("searches and reads only the curated local documentation", async () => {
    const plugin = await AgencyAiLocalCapabilities();
    const search = JSON.parse(
      await plugin.tool.agencyai_docs_search.execute({
        query: "configure provider API key",
      }),
    );
    expect(search.ok).toBe(true);
    expect(search.matches[0]?.path).toBe("providers.mdx");

    const page = JSON.parse(
      await plugin.tool.agencyai_docs_read.execute({
        path: "providers.mdx",
      }),
    );
    expect(page.path).toBe("providers.mdx");
    expect(page.content).toContain("Settings → AI Providers");
    expect(page.content).not.toContain("OpenWork");

    const hosted = JSON.parse(
      await plugin.tool.agencyai_docs_search.execute({
        query: "OpenWork Cloud Den organization team",
      }),
    );
    expect(hosted.matches).toEqual([]);
  });

  test("rejects traversal and unknown documentation paths", async () => {
    const plugin = await AgencyAiLocalCapabilities();
    await expect(
      plugin.tool.agencyai_docs_read.execute({
        path: "../providers.mdx",
      }),
    ).rejects.toThrow("Invalid docs path");
    await expect(
      plugin.tool.agencyai_docs_read.execute({
        path: "missing.mdx",
      }),
    ).rejects.toThrow("AgencyAI docs page not found");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./agencyai-local-capabilities.js");
    expect(Object.keys(mod)).toEqual(["AgencyAiLocalCapabilities"]);
  });
});
