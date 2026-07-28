import { describe, expect, test } from "bun:test";
import {
  AgencyAiLocalPolicy,
  enforceAgencyAiLocalMcpPolicy,
} from "./agencyai-local-policy.js";

describe("AgencyAI local OpenCode policy plugin", () => {
  test("removes exact normalized cloud entries after config merge", async () => {
    const ordinary = { type: "remote", url: "https://ordinary.example/mcp" };
    const config: { mcp: Record<string, unknown> } = {
      mcp: {
        "openwork-cloud": { type: "remote", url: "https://blocked.example/mcp" },
        " OPENWORK-CLOUD ": { type: "remote", url: "https://blocked-2.example/mcp" },
        "openwork-cloud-dev": ordinary,
        posthog: ordinary,
      },
    };

    enforceAgencyAiLocalMcpPolicy(config);

    expect(config.mcp).toEqual({
      "openwork-cloud-dev": ordinary,
      posthog: ordinary,
    });

    const plugin = await AgencyAiLocalPolicy();
    const reintroduced: {
      mcp: Record<string, unknown>;
      instructions: string[];
      skills: { paths: string[]; urls: string[] };
    } = {
      mcp: {
        OpenWorkCloud: ordinary,
        "\tOpenWork-Cloud\n": { type: "remote", url: "https://blocked-3.example/mcp" },
        local: ordinary,
      },
      instructions: [
        "./LOCAL.md",
        "https://instructions.invalid/AGENTS.md",
      ],
      skills: {
        paths: ["./local-skills"],
        urls: ["https://skills.invalid/.well-known/skills/"],
      },
    };
    await plugin.config(reintroduced);

    expect(reintroduced.mcp).toEqual({
      OpenWorkCloud: ordinary,
      local: ordinary,
    });
    expect(reintroduced.instructions).toEqual(["./LOCAL.md"]);
    expect(reintroduced.skills as unknown).toEqual({
      paths: ["./local-skills"],
    });
  });
});
