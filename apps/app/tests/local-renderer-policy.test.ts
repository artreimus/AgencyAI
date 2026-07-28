import { describe, expect, test } from "bun:test";

import {
  LOCAL_CONTROL_ACTION_IDS,
  LOCAL_DISABLED_SETTINGS_TABS,
  LOCAL_SETTINGS_TABS,
  isLocalControlActionId,
  neutralMonogram,
  projectLocalNotifications,
  projectLocalWorkspaces,
  resolveLocalRendererRedirect,
  resolveLocalSettingsTab,
} from "../src/react-app/shell/local-renderer-policy";

describe("local renderer policy", () => {
  test("defines an exact duplicate-free action inventory with no cloud surfaces", () => {
    expect(new Set(LOCAL_CONTROL_ACTION_IDS).size).toBe(LOCAL_CONTROL_ACTION_IDS.length);
    expect(LOCAL_CONTROL_ACTION_IDS).toContain("composer.send");
    expect(LOCAL_CONTROL_ACTION_IDS).toContain("settings.provider.add");
    expect(LOCAL_CONTROL_ACTION_IDS).not.toContain("auth.status");
    expect(LOCAL_CONTROL_ACTION_IDS).not.toContain("auth.exchange-grant");
    expect(LOCAL_CONTROL_ACTION_IDS.some((id) => id.startsWith("voice."))).toBe(false);
    expect(LOCAL_CONTROL_ACTION_IDS.some((id) => id.includes("cloud"))).toBe(false);
    expect(isLocalControlActionId("composer.send")).toBe(true);
    expect(isLocalControlActionId("auth.status")).toBe(false);
  });

  test("keeps local settings separate from every disabled cloud/update tab", () => {
    expect(LOCAL_SETTINGS_TABS).toContain("ai");
    expect(LOCAL_SETTINGS_TABS).toContain("extensions");
    expect(LOCAL_SETTINGS_TABS).not.toContain("updates");
    expect(LOCAL_DISABLED_SETTINGS_TABS).toEqual([
      "cloud-account",
      "connect",
      "cloud-marketplaces",
      "cloud-providers",
      "debug",
      "environment",
      "memory",
      "preferences",
      "recovery",
      "shell",
      "skills",
      "updates",
      "advanced",
    ]);
  });

  test("redirects legacy and cloud routes without evaluating their destination", () => {
    expect(resolveLocalRendererRedirect("/signin")).toBe("/session");
    expect(resolveLocalRendererRedirect("/onboarding/team")).toBe("/session");
    expect(resolveLocalRendererRedirect("/settings/connect")).toBe("/settings/general");
    expect(resolveLocalRendererRedirect("/workspace/local-1/settings/cloud-account")).toBe(
      "/workspace/local-1/settings/general",
    );
    expect(resolveLocalRendererRedirect("/settings/ai")).toBeNull();
    expect(resolveLocalSettingsTab("/settings/connect")).toBe("general");
    expect(resolveLocalSettingsTab("/settings/ai")).toBe("ai");
    expect(resolveLocalSettingsTab("/settings/not-real")).toBe("general");
  });

  test("projects persisted remote records and disabled notifications without mutation", () => {
    const remote = { id: "remote", workspaceType: "remote" };
    const local = { id: "local", workspaceType: "local" };
    const workspaces = Object.freeze([remote, local]);
    expect(projectLocalWorkspaces(workspaces)).toEqual([local]);
    expect(workspaces).toEqual([remote, local]);

    const notifications = [
      { id: "cloud", kind: "cloud" },
      { id: "update", kind: "update" },
      { id: "marketplace", kind: "system", action: { type: "install-marketplace-plugin" } },
      { id: "provider", kind: "providers", action: { type: "open-model-picker" } },
    ];
    expect(projectLocalNotifications(notifications).map((entry) => entry.id)).toEqual([
      "provider",
    ]);
    expect(notifications).toHaveLength(4);
  });

  test("creates bundled neutral monograms without remote asset URLs", () => {
    expect(neutralMonogram("Model Context Protocol")).toBe("MC");
    expect(neutralMonogram("Notion")).toBe("N");
    expect(neutralMonogram("")).toBe("AI");
  });
});
