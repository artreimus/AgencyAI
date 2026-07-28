export const LOCAL_SETTINGS_TABS = Object.freeze([
  "general",
  "ai",
  "permissions",
  "extensions",
  "appearance",
] as const);

export type LocalSettingsTab = (typeof LOCAL_SETTINGS_TABS)[number];

export const LOCAL_DISABLED_SETTINGS_TABS = Object.freeze([
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
] as const);

export const LOCAL_CONTROL_ACTION_IDS = Object.freeze([
  "browser.open_url",
  "browser.set_proxy",
  "command_palette.open",
  "composer.send",
  "composer.set_text",
  "composer.stop",
  "diagnostics.copy",
  "diagnostics.export",
  "eval.app.relaunch",
  "eval.artifact_tabs.seed_overflow",
  "eval.artifact_tabs.seed_pdf",
  "eval.chat_transcript.seed",
  "eval.markdown_primitive.seed_artifact",
  "eval.markdown_primitive.seed_chat",
  "eval.model_not_available.seed",
  "eval.session_sidebar.seed_active",
  "help.capabilities",
  "notifications.list",
  "reload-opencode-config",
  "route.back",
  "route.forward",
  "route.session",
  "route.settings.appearance",
  "route.settings.authorized_folders",
  "route.settings.general",
  "route.settings.providers",
  "route.settings.skills",
  "session.archive",
  "session.create_task",
  "session.delete",
  "session-find.open",
  "session.group.create",
  "session.group.list",
  "session.group.move",
  "session.group.remove",
  "session.latest_message",
  "session.list_sessions",
  "session.model_picker.open",
  "session.open",
  "session.pin",
  "session.read_transcript",
  "session.rename",
  "session.scroll_bottom",
  "session.scroll_top",
  "session-search.open",
  "session-tab.next",
  "session-tab.previous",
  "settings.panel.open",
  "settings.provider.add",
  "status.settings.open",
  "terminal.toggle",
  "workbench.session.focus",
  "workspace.create",
] as const);

export type LocalControlActionId = (typeof LOCAL_CONTROL_ACTION_IDS)[number];

export const LOCAL_CONTROL_ACTION_ID_SET: ReadonlySet<string> = new Set(
  LOCAL_CONTROL_ACTION_IDS,
);
const LOCAL_SETTINGS_TAB_SET: ReadonlySet<string> = new Set(LOCAL_SETTINGS_TABS);
const LOCAL_DISABLED_SETTINGS_TAB_SET: ReadonlySet<string> = new Set(
  LOCAL_DISABLED_SETTINGS_TABS,
);

export type RendererWorkspaceRecord = {
  workspaceType?: string | null;
};

export type RendererNotificationRecord = {
  kind?: string | null;
  action?: { type?: string | null } | null;
};

export function isLocalControlActionId(value: string): value is LocalControlActionId {
  return LOCAL_CONTROL_ACTION_ID_SET.has(value);
}

export function isLocalSettingsTab(value: string): value is LocalSettingsTab {
  return LOCAL_SETTINGS_TAB_SET.has(value);
}

export function projectLocalWorkspaces<T extends RendererWorkspaceRecord>(
  workspaces: readonly T[],
): T[] {
  return workspaces.filter((workspace) => workspace.workspaceType !== "remote");
}

export function projectLocalNotifications<T extends RendererNotificationRecord>(
  notifications: readonly T[],
): T[] {
  return notifications.filter((notification) => {
    if (notification.kind === "cloud" || notification.kind === "update") return false;
    const actionType = notification.action?.type ?? "";
    return (
      actionType !== "open-extensions-marketplace" &&
      actionType !== "install-marketplace-plugin"
    );
  });
}

function normalizePathname(pathname: string): string {
  const value = pathname.trim().split(/[?#]/, 1)[0] ?? "";
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

export function resolveLocalRendererRedirect(pathname: string): string | null {
  const normalized = normalizePathname(pathname).toLowerCase();
  if (
    normalized === "/signin" ||
    normalized.startsWith("/signin/") ||
    normalized === "/onboarding" ||
    normalized.startsWith("/onboarding/")
  ) {
    return "/session";
  }

  const segments = normalized.split("/").filter(Boolean);
  const settingsIndex = segments.indexOf("settings");
  if (settingsIndex === -1) return null;
  const requestedTab = segments[settingsIndex + 1] ?? "general";
  if (LOCAL_DISABLED_SETTINGS_TAB_SET.has(requestedTab)) {
    return settingsIndex === 0
      ? "/settings/general"
      : `/${segments.slice(0, settingsIndex).join("/")}/settings/general`;
  }
  return null;
}

export function resolveLocalSettingsTab(pathname: string): LocalSettingsTab {
  const redirect = resolveLocalRendererRedirect(pathname);
  if (redirect) return "general";
  const normalized = normalizePathname(pathname).toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const settingsIndex = segments.indexOf("settings");
  const requestedTab = settingsIndex === -1
    ? "general"
    : segments[settingsIndex + 1] ?? "general";
  return isLocalSettingsTab(requestedTab) ? requestedTab : "general";
}

export function neutralMonogram(value: string | null | undefined): string {
  const words = (value ?? "")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
  return initials || "AI";
}
