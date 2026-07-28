import { describe, expect, test } from "bun:test";
import {
  disableOpenworkCloudMcp,
  isOpenworkCloudMcpName,
  normalizeMcpPolicyName,
  withoutOpenworkCloudMcp,
} from "./mcp-product-policy.js";

describe("MCP product policy", () => {
  test("normalizes only casing and outer whitespace for the exact blocked name", () => {
    expect(normalizeMcpPolicyName("  OpenWork-Cloud  ")).toBe("openwork-cloud");
    expect([
      "openwork-cloud",
      " OpenWork-Cloud ",
      "\tOPENWORK-CLOUD\n",
    ].every(isOpenworkCloudMcpName)).toBe(true);
    expect([
      "openwork-cloud-dev",
      "my-openwork-cloud",
      "openwork_cloud",
      "openwork-cloud/",
      "openwork- cloud",
      "",
    ].some(isOpenworkCloudMcpName)).toBe(false);
  });

  test("removes every exact normalized match while preserving ordinary entries", () => {
    const ordinary = { type: "remote", url: "https://ordinary.example/mcp", enabled: true };
    const projected = withoutOpenworkCloudMcp({
      "openwork-cloud": { type: "remote", url: "https://blocked.example/mcp" },
      " OPENWORK-CLOUD ": { type: "remote", url: "https://blocked-2.example/mcp" },
      "openwork-cloud-dev": ordinary,
      posthog: ordinary,
    });

    expect(projected).toEqual({
      "openwork-cloud-dev": ordinary,
      posthog: ordinary,
    });
    expect(projected.posthog).toBe(ordinary);
  });

  test("disables exact matches without deleting payloads and records original enabled state", () => {
    const enabled = {
      type: "remote",
      url: "https://blocked.example/mcp",
      enabled: true,
      headers: { authorization: "Bearer retained" },
    };
    const absent = {
      type: "remote",
      url: "https://blocked-2.example/mcp",
      headers: { "x-retained": "yes" },
    };
    const ordinary = { type: "remote", url: "https://ordinary.example/mcp", enabled: true };
    const result = disableOpenworkCloudMcp({
      "openwork-cloud": enabled,
      " OpenWork-Cloud ": absent,
      "openwork-cloud-dev": ordinary,
    });

    expect(result.changed).toBe(true);
    expect(result.mcp["openwork-cloud"]).toEqual({ ...enabled, enabled: false });
    expect(result.mcp[" OpenWork-Cloud "]).toEqual({ ...absent, enabled: false });
    expect(result.mcp["openwork-cloud-dev"]).toBe(ordinary);
    expect(result.originalEnabledByName).toEqual({
      "openwork-cloud": { present: true, value: true },
      " OpenWork-Cloud ": { present: false },
    });
  });
});
