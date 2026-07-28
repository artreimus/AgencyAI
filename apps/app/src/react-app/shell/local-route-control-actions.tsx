/** @jsxImportSource react */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import {
  LOCAL_SETTINGS_TABS,
  isLocalSettingsTab,
} from "./local-renderer-policy";
import {
  useControlActions,
  type OpenworkControlAction,
} from "./control/control-provider";

export function LocalRouteControlActions() {
  const navigate = useNavigate();
  const actions = useMemo<OpenworkControlAction[]>(() => [
    {
      id: "route.session",
      label: "Open tasks",
      description: "Navigate to the local task view.",
      sideEffect: "navigation",
      execute: () => navigate("/session"),
    },
    {
      id: "route.settings.general",
      label: "Open settings",
      description: "Navigate to local settings.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/general"),
    },
    {
      id: "route.settings.skills",
      label: "Open extensions",
      description: "Browse local skills and MCP servers.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/extensions/skills"),
    },
    {
      id: "route.settings.providers",
      label: "Open provider settings",
      description: "Configure user-owned AI model providers.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/ai"),
    },
    {
      id: "route.settings.authorized_folders",
      label: "Open authorized folders",
      description: "Review local workspace file access.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/permissions"),
    },
    {
      id: "route.settings.appearance",
      label: "Open appearance settings",
      description: "Configure local appearance.",
      sideEffect: "navigation",
      execute: () => navigate("/settings/appearance"),
    },
    {
      id: "settings.panel.open",
      label: "Open a settings panel",
      description: "Navigate to a reviewed local settings panel.",
      sideEffect: "navigation",
      requiresArgs: true,
      args: [
        {
          name: "panel",
          type: "string",
          required: true,
          description: `Settings panel: ${LOCAL_SETTINGS_TABS.join(" | ")}`,
        },
      ],
      previewArgs: { panel: "ai" },
      execute: (args) => {
        const requested =
          args && typeof args === "object"
            ? Reflect.get(args, "panel")
            : null;
        const panel = typeof requested === "string" ? requested.trim() : "";
        if (!isLocalSettingsTab(panel)) {
          return {
            ok: false,
            error: `Disabled or unknown local settings panel: ${panel || "(empty)"}.`,
          };
        }
        navigate(`/settings/${panel}`);
        return { ok: true, panel };
      },
    },
    {
      id: "route.back",
      label: "Go back",
      description: "Navigate back one entry in history.",
      sideEffect: "navigation",
      execute: () => navigate(-1),
    },
    {
      id: "route.forward",
      label: "Go forward",
      description: "Navigate forward one entry in history.",
      sideEffect: "navigation",
      execute: () => navigate(1),
    },
    {
      id: "help.capabilities",
      label: "What can AgencyAI do?",
      description: "List the enabled local desktop capabilities.",
      kind: "query",
      effects: { data: "read", ui: "none", external: false },
      sideEffect: "none",
      execute: () => ({
        capabilities: [
          { id: "tasks", label: "Local tasks" },
          { id: "providers", label: "User-owned AI providers" },
          { id: "extensions", label: "Local skills and MCP servers" },
          { id: "files", label: "Workspace file management" },
          { id: "browser", label: "Browser automation" },
          { id: "computer-use", label: "Computer use" },
        ],
      }),
    },
  ], [navigate]);

  useControlActions(actions);
  return null;
}
