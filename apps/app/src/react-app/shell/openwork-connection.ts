import {
  isLoopbackOpenworkServerUrl,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { openworkServerInfo, type OpenworkServerInfo } from "../../app/lib/desktop";
import { getCompiledRendererProductProfile } from "../../app/lib/product-profile";
import { isDesktopRuntime } from "../../app/utils";

export type OpenworkConnectionSource = "desktop-runtime" | "stored-settings" | "same-origin" | "empty";

export type ResolvedOpenworkConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  resolvedHostToken: string;
  hostInfo: OpenworkServerInfo | null;
  source: OpenworkConnectionSource;
};

export type WaitForOpenworkConnectionOptions = {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  resolveConnection?: () => Promise<ResolvedOpenworkConnection>;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
};

function hasUsableConnection(url: string, token: string) {
  return url.trim().length > 0 && token.trim().length > 0;
}

function emptyConnection(): ResolvedOpenworkConnection {
  return {
    normalizedBaseUrl: "",
    resolvedToken: "",
    resolvedHostToken: "",
    hostInfo: null,
    source: "empty",
  };
}

export function projectLocalDesktopRuntimeConnection(
  info: OpenworkServerInfo | null | undefined,
): ResolvedOpenworkConnection {
  const normalizedBaseUrl = normalizeOpenworkServerUrl(info?.baseUrl ?? "") ?? "";
  const resolvedToken =
    info?.ownerToken?.trim() || info?.clientToken?.trim() || "";
  if (
    info?.running !== true ||
    !isLoopbackOpenworkServerUrl(normalizedBaseUrl) ||
    !hasUsableConnection(normalizedBaseUrl, resolvedToken)
  ) {
    return emptyConnection();
  }
  return {
    normalizedBaseUrl,
    resolvedToken,
    resolvedHostToken: info.hostToken?.trim() || "",
    hostInfo: info,
    source: "desktop-runtime",
  };
}

/**
 * Resolve the OpenWork server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveOpenworkConnection(): Promise<ResolvedOpenworkConnection> {
  const product = getCompiledRendererProductProfile();
  if (!product.features.openworkCloud) {
    if (!isDesktopRuntime()) return emptyConnection();
    try {
      return projectLocalDesktopRuntimeConnection(
        await openworkServerInfo() as OpenworkServerInfo,
      );
    } catch {
      return emptyConnection();
    }
  }

  let staleDesktopRuntimeBaseUrl = "";

  if (isDesktopRuntime()) {
    try {
      const info = await openworkServerInfo() as OpenworkServerInfo;
      const normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.baseUrl ?? info.connectUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (info.running === true && hasUsableConnection(normalizedBaseUrl, resolvedToken)) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          resolvedHostToken: info.hostToken?.trim() || "",
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
      staleDesktopRuntimeBaseUrl = normalizedBaseUrl;
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readOpenworkServerSettings();
  const normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  const sameOriginBaseUrl =
    !normalizedBaseUrl && !isDesktopRuntime() && isWebDeployment() && typeof window !== "undefined"
      ? normalizeOpenworkServerUrl(window.location.origin) ?? ""
      : "";
  const resolvedToken = settings.token?.trim() ?? "";
  const resolvedHostToken =
    normalizedBaseUrl && isLoopbackOpenworkServerUrl(normalizedBaseUrl)
      ? settings.hostToken?.trim() ?? ""
      : "";
  const storedConnectionIsStaleDesktopRuntime = Boolean(
    isDesktopRuntime() &&
      staleDesktopRuntimeBaseUrl &&
      normalizedBaseUrl === staleDesktopRuntimeBaseUrl,
  );
  const source =
    !storedConnectionIsStaleDesktopRuntime && hasUsableConnection(normalizedBaseUrl, resolvedToken)
      ? "stored-settings"
      : hasUsableConnection(sameOriginBaseUrl, resolvedToken)
        ? "same-origin"
        : "empty";

  return {
    normalizedBaseUrl: source === "same-origin"
      ? sameOriginBaseUrl
      : source === "empty"
        ? ""
        : normalizedBaseUrl,
    resolvedToken: source === "empty" ? "" : resolvedToken,
    resolvedHostToken: source === "empty" ? "" : resolvedHostToken,
    hostInfo: null,
    source,
  };
}

/**
 * Wait briefly for the desktop bridge to publish a usable local runtime.
 *
 * Electron starts the renderer and the embedded server concurrently. A
 * one-shot probe can therefore report "disconnected" even though the server
 * becomes ready a few milliseconds later. Keep retries bounded so a genuinely
 * unavailable runtime still fails promptly and the UI never hangs forever.
 */
export async function waitForOpenworkConnection(
  options: WaitForOpenworkConnectionOptions = {},
): Promise<ResolvedOpenworkConnection> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 12_000);
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 100);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 1_000);
  const resolveConnection = options.resolveConnection ?? resolveOpenworkConnection;
  const sleep = options.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let delayMs = initialDelayMs;
  let lastConnection = emptyConnection();

  while (true) {
    try {
      lastConnection = await resolveConnection();
    } catch {
      lastConnection = emptyConnection();
    }

    if (hasUsableConnection(
      lastConnection.normalizedBaseUrl,
      lastConnection.resolvedToken,
    )) {
      return lastConnection;
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) return lastConnection;

    const nextDelayMs = Math.min(delayMs, remainingMs);
    await sleep(nextDelayMs);
    delayMs = Math.min(maxDelayMs, delayMs * 2);
  }
}
