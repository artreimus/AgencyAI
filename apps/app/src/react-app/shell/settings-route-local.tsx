/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ProviderAuthAuthorization,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";
import {
  Bot,
  FolderLock,
  Paintbrush,
  Plug,
  Settings,
  X,
} from "lucide-react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { t, currentLocale, setLocale, type Language } from "@/i18n";
import type { McpDirectoryInfo } from "@/app/constants";
import {
  openworkServerInfo,
  workspaceBootstrap,
  workspaceSetSelected,
  type WorkspaceInfo,
} from "@/app/lib/desktop";
import { createClient, unwrap, waitForHealthy } from "@/app/lib/opencode";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  type OpenworkMcpItem,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { getCompiledRendererProductProfile } from "@/app/lib/product-profile";
import type {
  Client,
  McpServerConfig,
  McpServerEntry,
  McpStatus,
  McpStatusMap,
  ProviderListItem,
  SettingsTab,
} from "@/app/types";
import { getInitialThemeMode, setThemeMode, type ThemeMode } from "@/app/theme";
import { fetchProviderList, getConnectedProviderItems } from "@/react-app/infra/provider-list-query";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import type {
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderOAuthStartResult,
} from "@/react-app/domains/connections/provider-auth/types";
import { LOCAL_MCP_QUICK_CONNECT } from "@/react-app/domains/connections/local-mcp-catalog";
import { AddMcpModal } from "@/react-app/domains/connections/modals/add-mcp-modal";
import { McpAuthModal } from "@/react-app/domains/connections/mcp-auth-modal";
import { AuthorizedFoldersPanel } from "@/react-app/domains/settings/panels/authorized-folders-panel";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useBootState } from "./boot-state";
import {
  LOCAL_SETTINGS_TABS,
  isLocalSettingsTab,
  neutralMonogram,
  projectLocalWorkspaces,
  resolveLocalRendererRedirect,
  resolveLocalSettingsTab,
} from "./local-renderer-policy";
import { resolveOpenworkConnection } from "./openwork-connection";
import { readActiveWorkspaceId, writeActiveWorkspaceId } from "./session-memory";
import { workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";

const PRODUCT = getCompiledRendererProductProfile();
const LOCAL_CAPABILITIES: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};
const DISABLED_MCP_NAMES: ReadonlySet<string> = new Set([
  "openwork-cloud",
  "openwork-voice",
  "google-workspace",
]);

export type LocalSettingsSurfaceProps = {
  embedded?: boolean;
  initialPath?: string;
  workspaceId?: string;
  onClose?: () => void;
};

type LocalRuntime = {
  workspaces: WorkspaceInfo[];
  selectedWorkspace: WorkspaceInfo | null;
  serverClient: OpenworkServerClient | null;
  opencodeClient: Client | null;
  baseUrl: string;
  token: string;
  error: string | null;
};

const EMPTY_RUNTIME: LocalRuntime = {
  workspaces: [],
  selectedWorkspace: null,
  serverClient: null,
  opencodeClient: null,
  baseUrl: "",
  token: "",
  error: null,
};

function providerAuthMethod(value: unknown, methodIndex: number): ProviderAuthMethod | null {
  if (!value || typeof value !== "object") return null;
  const type = Reflect.get(value, "type");
  if (type !== "oauth" && type !== "api") return null;
  const label = Reflect.get(value, "label");
  return {
    type,
    label: typeof label === "string" && label.trim()
      ? label
      : type === "oauth"
        ? "OAuth"
        : "API key",
    methodIndex,
  };
}

function projectLocalProviderAuthMethods(
  value: unknown,
  providers: readonly ProviderListItem[],
): Record<string, ProviderAuthMethod[]> {
  const result: Record<string, ProviderAuthMethod[]> = {};
  if (value && typeof value === "object") {
    for (const [providerId, rawMethods] of Object.entries(value)) {
      if (/^lpr_/i.test(providerId) || providerId === "openwork") continue;
      const methods = Array.isArray(rawMethods)
        ? rawMethods.flatMap((method, index) => {
            const parsed = providerAuthMethod(method, index);
            return parsed ? [parsed] : [];
          })
        : [];
      if (methods.length > 0) result[providerId] = methods;
    }
  }
  for (const provider of providers) {
    if (/^lpr_/i.test(provider.id) || provider.id === "openwork") continue;
    if (!Array.isArray(provider.env) || provider.env.length === 0) continue;
    const existing = result[provider.id] ?? [];
    if (existing.some((method) => method.type === "api")) continue;
    result[provider.id] = [...existing, { type: "api", label: "API key" }];
  }
  return result;
}

function providerAuthProviders(
  providers: readonly ProviderListItem[],
): ProviderAuthProvider[] {
  return providers.flatMap((provider) => {
    if (/^lpr_/i.test(provider.id) || provider.id === "openwork") return [];
    return [{
      id: provider.id,
      name: provider.name,
      env: Array.isArray(provider.env) ? provider.env : [],
    }];
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" ? [[key, entry] as const] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry) => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

function mcpConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== "object") return null;
  const type = Reflect.get(value, "type");
  if (type !== "remote" && type !== "local") return null;
  const url = Reflect.get(value, "url");
  const enabled = Reflect.get(value, "enabled");
  const oauth = Reflect.get(value, "oauth");
  const timeout = Reflect.get(value, "timeout");
  return {
    type,
    url: typeof url === "string" ? url : undefined,
    command: stringArray(Reflect.get(value, "command")),
    enabled: typeof enabled === "boolean" ? enabled : undefined,
    headers: stringRecord(Reflect.get(value, "headers")),
    environment: stringRecord(Reflect.get(value, "environment")),
    oauth:
      oauth === false
        ? false
        : oauth && typeof oauth === "object"
          ? stringRecord(oauth) ?? {}
          : undefined,
    timeout: typeof timeout === "number" ? timeout : undefined,
  };
}

function projectMcpItems(items: readonly OpenworkMcpItem[]): McpServerEntry[] {
  return items.flatMap((item) => {
    const normalizedName = item.name.trim().toLowerCase();
    if (DISABLED_MCP_NAMES.has(normalizedName)) return [];
    const config = mcpConfig(item.config);
    if (!config) return [];
    return [{ name: item.name, config, source: item.source }];
  });
}

function projectMcpStatuses(value: unknown, allowedNames: ReadonlySet<string>): McpStatusMap {
  if (!value || typeof value !== "object") return {};
  const result: McpStatusMap = {};
  for (const [name, rawStatus] of Object.entries(value)) {
    if (!allowedNames.has(name) || !rawStatus || typeof rawStatus !== "object") continue;
    const status = Reflect.get(rawStatus, "status");
    if (status === "connected" || status === "disabled" || status === "needs_auth") {
      result[name] = { status };
      continue;
    }
    const error = Reflect.get(rawStatus, "error");
    if (status === "needs_client_registration") {
      result[name] = {
        status,
        error: typeof error === "string" ? error : "Client registration is required.",
      };
      continue;
    }
    if (status === "failed") {
      result[name] = {
        status,
        error: typeof error === "string" ? error : "Connection failed.",
      };
    }
  }
  return result;
}

function mcpServerName(entry: McpDirectoryInfo): string {
  const source = entry.serverName?.trim() || entry.name.trim();
  return source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "mcp";
}

function mcpDirectoryInfo(entry: McpServerEntry): McpDirectoryInfo {
  return {
    name: entry.name,
    serverName: entry.name,
    description: "",
    type: entry.config.type,
    url: entry.config.url,
    command: entry.config.command,
    oauth: entry.config.oauth !== false,
  };
}

function tabIcon(tab: SettingsTab) {
  if (tab === "ai") return Bot;
  if (tab === "permissions") return FolderLock;
  if (tab === "extensions") return Plug;
  if (tab === "appearance") return Paintbrush;
  return Settings;
}

function tabLabel(tab: SettingsTab) {
  if (tab === "ai") return "AI Providers";
  if (tab === "permissions") return "Authorized folders";
  if (tab === "extensions") return "Extensions";
  if (tab === "appearance") return "Appearance";
  return "General";
}

function SettingsCard(props: {
  icon: typeof Settings;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-3 rounded-2xl border border-border p-4 text-left transition-colors hover:bg-muted"
    >
      <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
        <props.icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.title}</span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </button>
  );
}

function LocalSettingsComposition(props: LocalSettingsSurfaceProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const local = useLocal();
  const { markRouteReady } = useBootState();
  const requestedWorkspaceId =
    props.workspaceId?.trim() ||
    params.workspaceId?.trim() ||
    readActiveWorkspaceId() ||
    "";
  const [embeddedTab, setEmbeddedTab] = useState<SettingsTab>(() =>
    resolveLocalSettingsTab(`/settings/${props.initialPath ?? "general"}`),
  );
  const activeTab = props.embedded
    ? embeddedTab
    : resolveLocalSettingsTab(location.pathname);
  const redirect = props.embedded
    ? null
    : resolveLocalRendererRedirect(location.pathname);
  const [runtime, setRuntime] = useState<LocalRuntime>(EMPTY_RUNTIME);
  const [loading, setLoading] = useState(true);
  const [providerData, setProviderData] = useState<ProviderListResponse | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerMethods, setProviderMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [disconnectingProviderId, setDisconnectingProviderId] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>({});
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<string | null>(null);
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [mcpAuthEntry, setMcpAuthEntry] = useState<McpDirectoryInfo | null>(null);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode);
  const [hideTitlebar, setHideTitlebar] = useState(false);

  const navigateTab = useCallback((tab: SettingsTab) => {
    if (!isLocalSettingsTab(tab)) return;
    if (props.embedded) {
      setEmbeddedTab(tab);
      return;
    }
    const workspaceId = runtime.selectedWorkspace?.id ?? requestedWorkspaceId;
    navigate(
      workspaceId
        ? workspaceSettingsRoute(workspaceId, tab)
        : `/settings/${tab}`,
    );
  }, [navigate, props.embedded, requestedWorkspaceId, runtime.selectedWorkspace?.id]);

  const refreshRuntime = useCallback(async () => {
    setLoading(true);
    try {
      const desktopList = await workspaceBootstrap();
      const workspaces = projectLocalWorkspaces(desktopList.workspaces ?? []);
      const selectedWorkspace =
        workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??
        workspaces.find((workspace) => workspace.id === desktopList.activeId) ??
        workspaces[0] ??
        null;
      const connection = await resolveOpenworkConnection();
      if (
        !selectedWorkspace ||
        !connection.normalizedBaseUrl ||
        !connection.resolvedToken
      ) {
        setRuntime({
          ...EMPTY_RUNTIME,
          workspaces,
          selectedWorkspace,
          error: selectedWorkspace
            ? "The local AgencyAI runtime is not ready."
            : "Create a local workspace first.",
        });
        return;
      }
      const serverClient = createOpenworkServerClient({
        baseUrl: connection.normalizedBaseUrl,
        token: connection.resolvedToken,
        hostToken: connection.resolvedHostToken || undefined,
      });
      const mounted =
        buildOpenworkWorkspaceBaseUrl(
          connection.normalizedBaseUrl,
          selectedWorkspace.id,
        ) ?? connection.normalizedBaseUrl;
      const opencodeClient = createClient(
        `${mounted.replace(/\/+$/, "")}/opencode`,
        selectedWorkspace.path?.trim() || undefined,
        { token: connection.resolvedToken, mode: "openwork" },
      );
      setRuntime({
        workspaces,
        selectedWorkspace,
        serverClient,
        opencodeClient,
        baseUrl: connection.normalizedBaseUrl,
        token: connection.resolvedToken,
        error: null,
      });
      writeActiveWorkspaceId(selectedWorkspace.id);
    } catch (error) {
      setRuntime({
        ...EMPTY_RUNTIME,
        error: error instanceof Error ? error.message : "Failed to load local settings.",
      });
    } finally {
      setLoading(false);
      markRouteReady();
    }
  }, [markRouteReady, requestedWorkspaceId]);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const refreshProviders = useCallback(async () => {
    if (!runtime.opencodeClient) {
      setProviderData(null);
      return null;
    }
    const next = await fetchProviderList({
      client: runtime.opencodeClient,
      baseUrl: runtime.baseUrl,
      directory: runtime.selectedWorkspace?.path ?? undefined,
    });
    const filtered: ProviderListResponse = {
      ...next,
      all: (next.all ?? []).filter(
        (provider) => !/^lpr_/i.test(provider.id) && provider.id !== "openwork",
      ),
      connected: (next.connected ?? []).filter(
        (providerId) => !/^lpr_/i.test(providerId) && providerId !== "openwork",
      ),
      default: Object.fromEntries(
        Object.entries(next.default ?? {}).filter(
          ([providerId]) => !/^lpr_/i.test(providerId) && providerId !== "openwork",
        ),
      ),
    };
    setProviderData(filtered);
    return filtered;
  }, [runtime.baseUrl, runtime.opencodeClient, runtime.selectedWorkspace?.path]);

  useEffect(() => {
    void refreshProviders().catch((error) => {
      setProviderError(error instanceof Error ? error.message : "Failed to load providers.");
    });
  }, [refreshProviders]);

  const refreshMcp = useCallback(async () => {
    const workspaceId = runtime.selectedWorkspace?.id ?? "";
    if (!runtime.serverClient || !runtime.opencodeClient || !workspaceId) {
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }
    const listed = await runtime.serverClient.listMcp(workspaceId);
    const servers = projectMcpItems(listed.items);
    setMcpServers(servers);
    const allowedNames = new Set(servers.map((entry) => entry.name));
    try {
      const status = unwrap(
        await runtime.opencodeClient.mcp.status({
          directory: runtime.selectedWorkspace?.path?.trim() || undefined,
        }),
      );
      setMcpStatuses(projectMcpStatuses(status, allowedNames));
    } catch {
      setMcpStatuses({});
    }
  }, [runtime.opencodeClient, runtime.selectedWorkspace?.id, runtime.selectedWorkspace?.path, runtime.serverClient]);

  useEffect(() => {
    void refreshMcp().catch((error) => {
      setMcpStatus(error instanceof Error ? error.message : "Failed to load extensions.");
    });
  }, [refreshMcp]);

  const openProviderModal = useCallback(async () => {
    if (!runtime.opencodeClient) return;
    setProviderBusy(true);
    setProviderError(null);
    try {
      const rawMethods = unwrap(await runtime.opencodeClient.provider.auth());
      const allProviders = providerData?.all ?? [];
      setProviderMethods(projectLocalProviderAuthMethods(rawMethods, allProviders));
      setProviderModalOpen(true);
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : "Failed to load provider methods.");
    } finally {
      setProviderBusy(false);
    }
  }, [providerData?.all, runtime.opencodeClient]);

  const startProviderAuth = useCallback(async (
    providerId: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> => {
    if (!runtime.opencodeClient) throw new Error("The local runtime is unavailable.");
    const methods = providerMethods[providerId] ?? [];
    const selected =
      methods.find((method) => method.methodIndex === methodIndex) ??
      methods.find((method) => method.type === "oauth");
    if (selected?.type !== "oauth" || selected.methodIndex === undefined) {
      throw new Error("Select an OAuth method.");
    }
    const authorization: ProviderAuthAuthorization = unwrap(
      await runtime.opencodeClient.provider.oauth.authorize({
        providerID: providerId,
        method: selected.methodIndex,
      }),
    );
    return { methodIndex: selected.methodIndex, authorization };
  }, [providerMethods, runtime.opencodeClient]);

  const reloadProviders = useCallback(async () => {
    if (!runtime.opencodeClient) return null;
    try {
      unwrap(await runtime.opencodeClient.instance.dispose());
      await waitForHealthy(runtime.opencodeClient, { timeoutMs: 8_000, pollMs: 250 });
    } catch {
      // Provider reads below are still useful if the engine restarted slowly.
    }
    return refreshProviders();
  }, [refreshProviders, runtime.opencodeClient]);

  const submitProviderApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!runtime.opencodeClient) throw new Error("The local runtime is unavailable.");
    const key = apiKey.trim();
    if (!key) throw new Error("API key is required.");
    setProviderBusy(true);
    try {
      await runtime.opencodeClient.auth.set({
        providerID: providerId,
        auth: { type: "api", key },
      });
      await reloadProviders();
      return `Connected ${providerId}`;
    } finally {
      setProviderBusy(false);
    }
  }, [reloadProviders, runtime.opencodeClient]);

  const completeProviderOAuth = useCallback(async (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => {
    if (!runtime.opencodeClient) throw new Error("The local runtime is unavailable.");
    await runtime.opencodeClient.provider.oauth.callback({
      providerID: providerId,
      method: methodIndex,
      code: code?.trim() || undefined,
    });
    const next = await reloadProviders();
    return {
      connected: next?.connected?.includes(providerId) === true,
      message: `Connected ${providerId}`,
    };
  }, [reloadProviders, runtime.opencodeClient]);

  const disconnectProvider = useCallback(async (providerId: string) => {
    if (!runtime.opencodeClient) return;
    setDisconnectingProviderId(providerId);
    setProviderError(null);
    try {
      await runtime.opencodeClient.auth.remove({ providerID: providerId });
      await reloadProviders();
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : "Failed to disconnect provider.");
    } finally {
      setDisconnectingProviderId(null);
    }
  }, [reloadProviders, runtime.opencodeClient]);

  const connectMcp = useCallback(async (entry: McpDirectoryInfo) => {
    const workspaceId = runtime.selectedWorkspace?.id ?? "";
    if (!runtime.serverClient || !workspaceId) return;
    const name = mcpServerName(entry);
    if (DISABLED_MCP_NAMES.has(name)) {
      setMcpStatus("This integration is disabled in the local MVP.");
      return;
    }
    const type = entry.type ?? "remote";
    const config: Record<string, unknown> = { type, enabled: true };
    if (type === "remote") {
      const url = entry.url?.trim() ?? "";
      if (!url) {
        setMcpStatus("MCP URL is required.");
        return;
      }
      config["url"] = url;
      if (entry.oauthConfig) config["oauth"] = entry.oauthConfig;
      else if (entry.oauth) config["oauth"] = {};
    } else {
      if (!entry.command?.length) {
        setMcpStatus("MCP command is required.");
        return;
      }
      config["command"] = entry.command;
    }
    setMcpBusy(true);
    setMcpStatus(null);
    try {
      await runtime.serverClient.addMcp(workspaceId, { name, config });
      await refreshMcp();
      if (entry.oauth) setMcpAuthEntry({ ...entry, name, serverName: name });
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : "Failed to connect MCP server.");
    } finally {
      setMcpBusy(false);
    }
  }, [refreshMcp, runtime.selectedWorkspace?.id, runtime.serverClient]);

  const removeMcp = useCallback(async (name: string) => {
    const workspaceId = runtime.selectedWorkspace?.id ?? "";
    if (!runtime.serverClient || !workspaceId) return;
    setMcpBusy(true);
    try {
      await runtime.serverClient.removeMcp(workspaceId, name);
      await refreshMcp();
    } finally {
      setMcpBusy(false);
    }
  }, [refreshMcp, runtime.selectedWorkspace?.id, runtime.serverClient]);

  const setMcpEnabled = useCallback(async (name: string, enabled: boolean) => {
    const workspaceId = runtime.selectedWorkspace?.id ?? "";
    if (!runtime.serverClient || !workspaceId) return;
    setMcpBusy(true);
    try {
      await runtime.serverClient.setMcpEnabled(workspaceId, name, enabled);
      await refreshMcp();
    } finally {
      setMcpBusy(false);
    }
  }, [refreshMcp, runtime.selectedWorkspace?.id, runtime.serverClient]);

  const connectedProviders = getConnectedProviderItems(providerData);

  const content: ReactNode = (() => {
    if (loading) {
      return <p className="text-sm text-muted-foreground">Loading local settings…</p>;
    }
    if (activeTab === "general") {
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsCard
            icon={Bot}
            title="AI Providers"
            description="Add your own model provider."
            onClick={() => navigateTab("ai")}
          />
          <SettingsCard
            icon={Plug}
            title="Extensions"
            description="Configure local skills and third-party MCP servers."
            onClick={() => navigateTab("extensions")}
          />
          <SettingsCard
            icon={FolderLock}
            title="Authorized folders"
            description="Review local workspace file access."
            onClick={() => navigateTab("permissions")}
          />
          <SettingsCard
            icon={Paintbrush}
            title="Appearance"
            description="Choose theme, language, and window preferences."
            onClick={() => navigateTab("appearance")}
          />
        </div>
      );
    }
    if (activeTab === "ai") {
      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-border p-4">
            <div>
              <h3 className="text-sm font-medium">User-owned providers</h3>
              <p className="text-xs text-muted-foreground">
                Credentials stay in your local OpenCode runtime.
              </p>
            </div>
            <Button onClick={() => void openProviderModal()} disabled={providerBusy || !runtime.opencodeClient}>
              Add provider
            </Button>
          </div>
          {providerError ? <p className="text-sm text-destructive">{providerError}</p> : null}
          {connectedProviders.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              No model provider is connected yet.
            </p>
          ) : (
            connectedProviders.map((provider) => (
              <div key={provider.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-xs font-semibold">
                    {neutralMonogram(provider.name || provider.id)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{provider.name || provider.id}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => void disconnectProvider(provider.id)}
                  disabled={disconnectingProviderId !== null || provider.source === "env"}
                >
                  {disconnectingProviderId === provider.id ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            ))
          )}
        </div>
      );
    }
    if (activeTab === "extensions") {
      return (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium">MCP servers</h3>
              <p className="text-xs text-muted-foreground">
                Connections happen only after you choose or configure them.
              </p>
            </div>
            <Button onClick={() => setAddMcpOpen(true)} disabled={mcpBusy || !runtime.serverClient}>
              Add custom MCP
            </Button>
          </div>
          {mcpStatus ? <p className="text-sm text-destructive">{mcpStatus}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {LOCAL_MCP_QUICK_CONNECT.map((entry) => (
              <SettingsCard
                key={entry.serverName}
                icon={Plug}
                title={entry.name}
                description={entry.description}
                onClick={() => void connectMcp(entry)}
              />
            ))}
          </div>
          <div className="space-y-2">
            {mcpServers.map((entry) => {
              const status: McpStatus | undefined = mcpStatuses[entry.name];
              return (
                <div key={entry.name} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-xs font-semibold">
                      {neutralMonogram(entry.name)}
                    </span>
                    <div>
                      <div className="text-sm font-medium">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {status?.status ?? (entry.config.enabled === false ? "disabled" : "configured")}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {status?.status === "needs_auth" || status?.status === "failed" ? (
                      <Button variant="outline" onClick={() => setMcpAuthEntry(mcpDirectoryInfo(entry))}>
                        Sign in
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() => void setMcpEnabled(entry.name, entry.config.enabled === false)}
                      disabled={mcpBusy}
                    >
                      {entry.config.enabled === false ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => void removeMcp(entry.name)}
                      disabled={mcpBusy}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    if (activeTab === "permissions") {
      return (
        <AuthorizedFoldersPanel
          openworkServerClient={runtime.serverClient}
          openworkServerStatus={runtime.serverClient ? "connected" : "disconnected"}
          openworkServerCapabilities={runtime.serverClient ? LOCAL_CAPABILITIES : null}
          runtimeWorkspaceId={runtime.selectedWorkspace?.id ?? null}
          selectedWorkspaceRoot={runtime.selectedWorkspace?.path ?? ""}
          activeWorkspaceType="local"
          onConfigUpdated={() => undefined}
        />
      );
    }
    if (activeTab === "appearance") {
      return (
        <AppearanceView
          busy={false}
          themeMode={themeMode}
          setThemeMode={(next) => {
            setThemeModeState(next);
            setThemeMode(next);
          }}
          language={currentLocale() as Language}
          setLanguage={setLocale}
          hideTitlebar={hideTitlebar}
          toggleHideTitlebar={() => setHideTitlebar((current) => !current)}
        />
      );
    }
    return null;
  })();

  if (redirect) {
    return <Navigate to={redirect} replace />;
  }

  const selectedWorkspaceName =
    runtime.selectedWorkspace?.displayName?.trim() ||
    runtime.selectedWorkspace?.name?.trim() ||
    runtime.selectedWorkspace?.path?.trim() ||
    "Local workspace";

  return (
    <div className={props.embedded ? "flex h-full min-h-0 bg-background" : "flex h-dvh min-h-screen bg-background"}>
      <aside className="w-56 shrink-0 border-r border-border p-3">
        <div className="mb-5 px-2 pt-2 text-sm font-semibold">{PRODUCT.brand.name}</div>
        <nav className="space-y-1">
          {LOCAL_SETTINGS_TABS.map((tab) => {
            const Icon = tabIcon(tab);
            return (
              <Button
                key={tab}
                type="button"
                variant={activeTab === tab ? "secondary" : "ghost"}
                className="w-full justify-start"
                onClick={() => navigateTab(tab)}
              >
                <Icon className="mr-2 size-4" />
                {tabLabel(tab)}
              </Button>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-background/95 px-5 backdrop-blur">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{tabLabel(activeTab)}</h1>
            <p className="truncate text-xs text-muted-foreground">{selectedWorkspaceName}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              if (props.onClose) {
                props.onClose();
                return;
              }
              navigate(
                runtime.selectedWorkspace
                  ? workspaceSessionRoute(runtime.selectedWorkspace.id)
                  : "/session",
              );
            }}
            aria-label={t("dashboard.close_settings")}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="mx-auto w-full max-w-4xl p-5 sm:p-8">
          {runtime.error ? (
            <p className="mb-4 rounded-xl border border-amber-7/40 bg-amber-2 p-3 text-sm text-amber-11">
              {runtime.error}
            </p>
          ) : null}
          {content}
        </div>
      </main>

      <ProviderAuthModal
        open={providerModalOpen}
        loading={providerBusy}
        submitting={providerBusy}
        error={providerError}
        workerType="local"
        providers={providerAuthProviders(providerData?.all ?? [])}
        connectedProviderIds={providerData?.connected ?? []}
        authMethods={providerMethods}
        onSelect={startProviderAuth}
        onSubmitApiKey={submitProviderApiKey}
        onConnectCloudProvider={async () => {
          throw new Error("Cloud-managed providers are disabled in AgencyAI.");
        }}
        onSubmitOAuth={completeProviderOAuth}
        onRefreshProviders={refreshProviders}
        showOpenWorkModelsSubscribe={false}
        onClose={() => {
          setProviderModalOpen(false);
          setProviderError(null);
        }}
      />
      <AddMcpModal
        open={addMcpOpen}
        onClose={() => setAddMcpOpen(false)}
        onAdd={(entry) => {
          setAddMcpOpen(false);
          void connectMcp(entry);
        }}
        busy={mcpBusy}
        isRemoteWorkspace={false}
      />
      <McpAuthModal
        open={mcpAuthEntry !== null}
        onClose={() => setMcpAuthEntry(null)}
        onComplete={async () => {
          setMcpAuthEntry(null);
          await refreshMcp();
        }}
        client={runtime.opencodeClient}
        entry={mcpAuthEntry}
        projectDir={runtime.selectedWorkspace?.path?.trim() ?? ""}
        isRemoteWorkspace={false}
      />
    </div>
  );
}

export function LocalSettingsRoute() {
  return <LocalSettingsComposition />;
}

export function LocalSettingsSurface(props: LocalSettingsSurfaceProps) {
  return <LocalSettingsComposition {...props} />;
}
