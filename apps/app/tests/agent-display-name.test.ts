import { describe, expect, test } from "bun:test";

import { agentDisplayName } from "../src/react-app/kernel/agent-display-name";

describe("agentDisplayName", () => {
  test("uses the Agency Agent brand for the internal agencyai profile", () => {
    expect(agentDisplayName("agencyai")).toBe("Agency Agent");
    expect(agentDisplayName("AgencyAI")).toBe("Agency Agent");
  });

  test("preserves the existing capitalization behavior for other agents", () => {
    expect(agentDisplayName("build")).toBe("Build");
    expect(agentDisplayName("plan")).toBe("Plan");
    expect(agentDisplayName("")).toBe("");
  });
});
