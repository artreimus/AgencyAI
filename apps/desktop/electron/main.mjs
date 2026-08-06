import { execFileSync, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalOpencodeConfigDir, workspaceOpencodeConfigCandidates } from "@openwork/paths";
import { getBuildProductProfile } from "@openwork/product-config";

import { configureFakeMediaForTests, installMediaPermissionHandlers } from "./media-permissions.mjs";
import { registerMigrationIpc } from "./migration.mjs";
import { ensureAgencyAiMemorySystem } from "./memory-system.mjs";
import { createRuntimeManager } from "./runtime.mjs";
import {
  loadOpencodeDistributionSync,
  loadPackagedRuntimeIntegritySync,
} from "./opencode-distribution.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import {
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
} from "./computer-use.mjs";
import { createUiControlServer } from "./ui-control-server.mjs";
import { createApplicationMenu } from "./app-menu.mjs";
import { applyBrandAppName } from "./brand-app-name.mjs";
import {
  BROWSER_SESSION_PARTITION,
  createBrowserPanel,
} from "./browser-panel.mjs";
import { createNetworkAuditFromEnvironment } from "./network-audit.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import {
  buildNukeManifest,
  executeNukeFreshStart,
  runPendingNukeCleanup,
} from "./nuke.mjs";
import {
  createConnectLinkReplayGuard,
  extractConnectExchange,
  resolveConnectExchangeUrl,
  verifyConnectLinkUrl,
} from "./connect-link.mjs";
import {
  applyDesktopBootstrapBrandIcon,
  persistConnectLinkBranding,
} from "./connect-link-branding.mjs";
import { resolveConnectLinkPublicKeys } from "./connect-link-keys.mjs";
import { openExternalUrl } from "./open-external.mjs";
import { authorizeLocalFileTarget } from "./local-file-access.mjs";
import {
  installInternalRendererProtocol,
  registerInternalRendererScheme,
} from "./internal-renderer-protocol.mjs";
import { fetchAgentContextDiagnosticsResponse } from "./agent-context-diagnostics-fetch.mjs";
import { createAppBuildInfo } from "./app-build-info.mjs";
import { resolveProductArchitectureInfo } from "./architecture-policy.mjs";
import {
  applyDesktopProductEnvironmentPolicy,
  forwardedProductDeepLinks,
  resolveDesktopProductPolicy,
} from "./desktop-product-policy.mjs";
import {
  applyStorageLayoutEnvironment,
  ensureStorageLayout,
  resolveElectronStorageLayout,
  storageLayoutEnvironment,
} from "./storage-layout.mjs";
import {
  applyWindowsTaskbarIcon,
  windowsBrandAppUserModelId,
  windowsBrandShortcutDetails,
  windowsBrandShortcutFileName,
  windowsInstalledShortcutFileName,
  windowsInstalledExecutablePath,
  writeWindowsBrandShortcut,
  windowsIconFromNativeImage,
} from "./brand-icon-windows.mjs";

process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error(`[agencyai:fatal] Uncaught main-process exception (${origin})`, error);
});

/* DESKTOP_APPROVAL_POLICY_HELPERS_START */
const SUPPORTED_DESKTOP_APPROVAL_OPERATIONS = Object.freeze([
  "config.runtime_migrate",
  "config.patch",
  "config.write",
  "skills.upsert",
  "skills.delete",
  "mcp.add",
  "mcp.remove",
  "mcp.enable",
  "mcp.disable",
  "commands.upsert",
  "commands.delete",
  "config.import",
  "workspace.inbox.upload",
  "workspace.files.session.ops",
  "workspace.file.write",
]);
const supportedDesktopApprovalOperations = new Set(
  SUPPORTED_DESKTOP_APPROVAL_OPERATIONS,
);

function desktopApprovalUrlOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      !url.protocol ||
      !url.host ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin === "null"
      ? `${url.protocol}//${url.host}`
      : url.origin;
  } catch {
    return null;
  }
}

function rawUrlHostname(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const schemeSeparator = raw.indexOf("://");
  if (schemeSeparator <= 0) return "";
  const authority = raw
    .slice(schemeSeparator + 3)
    .split(/[/?#]/, 1)[0];
  if (!authority || authority.includes("@")) return "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end > 0 ? authority.slice(0, end + 1).toLowerCase() : "";
  }
  const portSeparator = authority.lastIndexOf(":");
  return (portSeparator >= 0
    ? authority.slice(0, portSeparator)
    : authority).toLowerCase();
}

function exactLoopbackHttpOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const rawHostname = rawUrlHostname(value);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(rawHostname)) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   productProfile: { brand?: { rendererScheme?: string } },
 *   isPackaged: boolean,
 *   env?: Record<string, string | undefined>,
 * }} options
 */
export function resolveDesktopApprovalTrustedRendererOrigin({
  productProfile,
  isPackaged,
  env = {},
}) {
  const rendererScheme = typeof productProfile?.brand?.rendererScheme === "string"
    ? productProfile.brand.rendererScheme.trim()
    : "";
  if (!rendererScheme) {
    throw new Error("Desktop approval policy requires a renderer scheme");
  }
  const internalOrigin = `${rendererScheme}://renderer`;
  if (isPackaged) return internalOrigin;

  const startUrl =
    (typeof env.OPENWORK_ELECTRON_START_URL === "string"
      ? env.OPENWORK_ELECTRON_START_URL.trim()
      : "") ||
    (typeof env.ELECTRON_START_URL === "string"
      ? env.ELECTRON_START_URL.trim()
      : "");
  return exactLoopbackHttpOrigin(startUrl) ?? internalOrigin;
}

export function isSupportedDesktopApprovalOperation(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    supportedDesktopApprovalOperations.has(value);
}

export function assertDesktopApprovalIpcSender({
  event,
  mainWindow,
  trustedRendererOrigin,
}) {
  const trustedOrigin = desktopApprovalUrlOrigin(trustedRendererOrigin);
  if (!trustedOrigin || trustedOrigin !== trustedRendererOrigin) {
    throw new Error("Desktop approval denied: invalid trusted renderer origin");
  }
  if (
    !mainWindow ||
    typeof mainWindow.isDestroyed !== "function" ||
    mainWindow.isDestroyed()
  ) {
    throw new Error("Desktop approval denied: main window is unavailable");
  }

  const sender = event?.sender;
  const windowWebContents = mainWindow.webContents;
  if (
    !sender ||
    sender !== windowWebContents ||
    typeof sender.isDestroyed !== "function" ||
    sender.isDestroyed()
  ) {
    throw new Error("Desktop approval denied: IPC sender is not the live main window");
  }

  const senderFrame = event?.senderFrame;
  if (!senderFrame || sender.mainFrame !== senderFrame) {
    throw new Error("Desktop approval denied: IPC sender is not the main frame");
  }

  const frameOrigin = desktopApprovalUrlOrigin(senderFrame.url);
  const currentOrigin = typeof sender.getURL === "function"
    ? desktopApprovalUrlOrigin(sender.getURL())
    : null;
  if (
    frameOrigin !== trustedOrigin ||
    currentOrigin !== trustedOrigin
  ) {
    throw new Error("Desktop approval denied: renderer origin is not trusted");
  }

  const webContentsId = Number(sender.id);
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("Desktop approval denied: invalid WebContents identity");
  }
  return webContentsId;
}

function selectedLocalWorkspaceId(workspaceState) {
  const selectedId = typeof workspaceState?.selectedId === "string"
    ? workspaceState.selectedId.trim()
    : "";
  const activeId = typeof workspaceState?.activeId === "string"
    ? workspaceState.activeId.trim()
    : "";
  if (!selectedId && !activeId) {
    throw new Error("Desktop approval denied: no workspace is selected");
  }
  if (selectedId && activeId && selectedId !== activeId) {
    throw new Error("Desktop approval denied: workspace selection is stale");
  }

  const workspaceId = selectedId || activeId;
  const matches = Array.isArray(workspaceState?.workspaces)
    ? workspaceState.workspaces.filter(
        (workspace) => workspace?.id === workspaceId,
      )
    : [];
  if (matches.length !== 1) {
    throw new Error("Desktop approval denied: selected workspace is stale");
  }
  const workspace = matches[0];
  if (
    workspace.workspaceType !== "local" ||
    typeof workspace.path !== "string" ||
    !workspace.path.trim()
  ) {
    throw new Error("Desktop approval denied: selected workspace is not local");
  }
  return workspaceId;
}

function assertActiveLocalDesktopRuntime(runtimeInfo) {
  const bearerToken =
    (typeof runtimeInfo?.ownerToken === "string"
      ? runtimeInfo.ownerToken.trim()
      : "") ||
    (typeof runtimeInfo?.clientToken === "string"
      ? runtimeInfo.clientToken.trim()
      : "");
  let baseUrl;
  try {
    baseUrl = new URL(String(runtimeInfo?.baseUrl ?? ""));
  } catch {
    baseUrl = null;
  }
  if (
    runtimeInfo?.running !== true ||
    runtimeInfo?.remoteAccessEnabled !== false ||
    runtimeInfo?.host !== "127.0.0.1" ||
    !baseUrl ||
    baseUrl.protocol !== "http:" ||
    baseUrl.hostname !== "127.0.0.1" ||
    !baseUrl.port ||
    baseUrl.username ||
    baseUrl.password ||
    (baseUrl.pathname !== "" && baseUrl.pathname !== "/") ||
    baseUrl.search ||
    baseUrl.hash ||
    !bearerToken
  ) {
    throw new Error("Desktop approval denied: local runtime is not active");
  }
}

export function resolveDesktopApprovalRequestContext({
  request,
  workspaceState,
  runtimeInfo,
  webContentsId,
}) {
  const workspaceId = typeof request?.workspaceId === "string"
    ? request.workspaceId
    : "";
  if (!workspaceId || workspaceId !== workspaceId.trim()) {
    throw new Error("Desktop approval denied: invalid workspace");
  }
  const operation = request?.operation;
  if (!isSupportedDesktopApprovalOperation(operation)) {
    throw new Error("Desktop approval denied: unsupported operation");
  }
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("Desktop approval denied: invalid WebContents identity");
  }

  const selectedWorkspaceId = selectedLocalWorkspaceId(workspaceState);
  if (workspaceId !== selectedWorkspaceId) {
    throw new Error("Desktop approval denied: request does not match the selected workspace");
  }
  assertActiveLocalDesktopRuntime(runtimeInfo);

  return {
    workspaceId,
    operation,
    webContentsId,
  };
}

const AGENCYAI_DESKTOP_APPROVAL_HEADER = "X-AgencyAI-Desktop-Approval";
const DESKTOP_FETCH_MAX_ENVELOPE_BYTES = 250_000_000;
const DESKTOP_FETCH_MAX_MULTIPART_PARTS = 64;
const DESKTOP_FETCH_MAX_FIELD_BYTES = 1_000_000;
const DESKTOP_FETCH_MAX_HEADERS = 128;
const DESKTOP_FETCH_MAX_HEADER_VALUE_LENGTH = 65_536;

function normalizeDesktopFetchHeaders(value) {
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) {
    throw new Error("Desktop fetch denied: headers must be a string record");
  }
  const entries = value ? Object.entries(value) : [];
  if (entries.length > DESKTOP_FETCH_MAX_HEADERS) {
    throw new Error("Desktop fetch denied: too many headers");
  }

  const headers = new Headers();
  for (const [name, headerValue] of entries) {
    if (
      typeof headerValue !== "string" ||
      headerValue.length > DESKTOP_FETCH_MAX_HEADER_VALUE_LENGTH
    ) {
      throw new Error("Desktop fetch denied: invalid header value");
    }
    try {
      headers.set(name, headerValue);
    } catch {
      throw new Error("Desktop fetch denied: invalid header");
    }
  }
  if (headers.has(AGENCYAI_DESKTOP_APPROVAL_HEADER)) {
    throw new Error(
      "Desktop fetch denied: approval header must be injected by Electron",
    );
  }
  return headers;
}

function normalizeDesktopFetchContentType(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256 ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new Error("Desktop fetch denied: invalid content type");
  }
  const probe = new Headers();
  try {
    probe.set("Content-Type", value);
  } catch {
    throw new Error("Desktop fetch denied: invalid content type");
  }
  return value;
}

function normalizeMultipartName(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > maxLength ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new Error(`Desktop fetch denied: invalid ${label}`);
  }
  return value;
}

function copyDesktopFetchBytes(value) {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Desktop fetch denied: binary payload must be Uint8Array");
  }
  if (value.byteLength > DESKTOP_FETCH_MAX_ENVELOPE_BYTES) {
    throw new Error("Desktop fetch denied: binary payload is too large");
  }
  return new Uint8Array(value);
}

function reconstructDesktopFetchEnvelope(envelope, headers) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Desktop fetch denied: invalid body envelope");
  }

  if (envelope.kind === "binary") {
    const bytes = copyDesktopFetchBytes(envelope.bytes);
    const contentType = normalizeDesktopFetchContentType(envelope.contentType);
    const headerContentType = headers.get("Content-Type");
    if (
      contentType &&
      headerContentType &&
      headerContentType !== contentType
    ) {
      throw new Error("Desktop fetch denied: conflicting content types");
    }
    if (contentType) headers.set("Content-Type", contentType);
    headers.delete("Content-Length");
    return bytes;
  }

  if (envelope.kind !== "multipart" || !Array.isArray(envelope.parts)) {
    throw new Error("Desktop fetch denied: invalid body envelope kind");
  }
  if (
    envelope.parts.length === 0 ||
    envelope.parts.length > DESKTOP_FETCH_MAX_MULTIPART_PARTS
  ) {
    throw new Error("Desktop fetch denied: invalid multipart part count");
  }

  const form = new FormData();
  let totalBytes = 0;
  for (const part of envelope.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("Desktop fetch denied: invalid multipart part");
    }
    const name = normalizeMultipartName(part.name, "multipart field name", 256);
    if (part.kind === "field") {
      if (typeof part.value !== "string") {
        throw new Error("Desktop fetch denied: invalid multipart field value");
      }
      const fieldBytes = new TextEncoder().encode(part.value).byteLength;
      if (fieldBytes > DESKTOP_FETCH_MAX_FIELD_BYTES) {
        throw new Error("Desktop fetch denied: multipart field is too large");
      }
      totalBytes += fieldBytes;
      if (totalBytes > DESKTOP_FETCH_MAX_ENVELOPE_BYTES) {
        throw new Error("Desktop fetch denied: multipart payload is too large");
      }
      form.append(name, part.value);
      continue;
    }
    if (part.kind !== "file") {
      throw new Error("Desktop fetch denied: invalid multipart part kind");
    }
    const fileName = normalizeMultipartName(
      part.fileName,
      "multipart file name",
      4_096,
    );
    const contentType =
      normalizeDesktopFetchContentType(part.contentType) ??
      "application/octet-stream";
    const bytes = copyDesktopFetchBytes(part.bytes);
    totalBytes += bytes.byteLength;
    if (totalBytes > DESKTOP_FETCH_MAX_ENVELOPE_BYTES) {
      throw new Error("Desktop fetch denied: multipart payload is too large");
    }
    form.append(name, new Blob([bytes], { type: contentType }), fileName);
  }

  // Chromium/Undici must generate the multipart boundary from the reconstructed
  // FormData. A renderer-provided Content-Type would omit or mismatch it.
  headers.delete("Content-Type");
  headers.delete("Content-Length");
  return form;
}

/**
 * @param {{
 *   url: unknown,
 *   init?: import("@openwork/types/desktop-ipc").DesktopFetchInit,
 *   event: unknown,
 *   mainWindow: unknown,
 *   trustedRendererOrigin: string,
 *   runtimeInfo?: import("@openwork/types/desktop-ipc").OpenworkServerInfo | null,
 * }} options
 * @returns {{ url: string, requestInit: RequestInit }}
 */
export function prepareDesktopFetchRequest({
  url,
  init = {},
  event,
  mainWindow,
  trustedRendererOrigin,
  runtimeInfo = null,
}) {
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("Desktop fetch denied: invalid request options");
  }
  const requestUrl = typeof url === "string" ? url.trim() : "";
  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    throw new Error("Desktop fetch denied: URL must be absolute");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Desktop fetch denied: URL protocol is not supported");
  }

  const method = init.method === undefined ? undefined : init.method;
  if (
    method !== undefined &&
    (typeof method !== "string" ||
      !method ||
      method !== method.trim() ||
      !/^[A-Za-z]+$/.test(method))
  ) {
    throw new Error("Desktop fetch denied: invalid method");
  }
  const headers = normalizeDesktopFetchHeaders(init.headers);
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("Desktop fetch denied: text body must be a string");
  }
  if (init.body !== undefined && init.bodyEnvelope !== undefined) {
    throw new Error("Desktop fetch denied: request body is ambiguous");
  }

  const hasEnvelope = init.bodyEnvelope !== undefined;
  const hasDesktopApproval = init.desktopApprovalCredential !== undefined;
  if (hasEnvelope || hasDesktopApproval) {
    assertDesktopApprovalIpcSender({
      event,
      mainWindow,
      trustedRendererOrigin,
    });
  }

  /** @type {BodyInit | undefined} */
  let body = init.body;
  if (hasEnvelope) {
    body = reconstructDesktopFetchEnvelope(init.bodyEnvelope, headers);
  }

  /** @type {RequestRedirect | undefined} */
  let redirect;
  if (hasDesktopApproval) {
    const credential = init.desktopApprovalCredential;
    if (
      typeof credential !== "string" ||
      !/^aai_da_[A-Za-z0-9_-]{43}$/.test(credential)
    ) {
      throw new Error("Desktop fetch denied: invalid approval credential");
    }
    assertActiveLocalDesktopRuntime(runtimeInfo);
    const runtimeOrigin = desktopApprovalUrlOrigin(runtimeInfo.baseUrl);
    if (!runtimeOrigin || parsedUrl.origin !== runtimeOrigin) {
      throw new Error("Desktop fetch denied: protected target is not the active runtime");
    }

    const expectedBearer =
      (typeof runtimeInfo.ownerToken === "string"
        ? runtimeInfo.ownerToken.trim()
        : "") ||
      (typeof runtimeInfo.clientToken === "string"
        ? runtimeInfo.clientToken.trim()
        : "");
    if (headers.get("Authorization") !== `Bearer ${expectedBearer}`) {
      throw new Error("Desktop fetch denied: bearer token does not match the approval grant");
    }
    const suppliedOrigin = headers.get("Origin");
    if (
      suppliedOrigin !== null &&
      suppliedOrigin !== trustedRendererOrigin
    ) {
      throw new Error("Desktop fetch denied: renderer Origin header is not trusted");
    }

    headers.set(AGENCYAI_DESKTOP_APPROVAL_HEADER, credential);
    headers.set("Origin", trustedRendererOrigin);
    redirect = "error";
  }

  /** @type {RequestInit} */
  const requestInit = {
    method,
    headers,
    body,
    credentials: "omit",
    ...(redirect ? { redirect } : {}),
  };
  return {
    url: parsedUrl.toString(),
    requestInit,
  };
}
/* DESKTOP_APPROVAL_POLICY_HELPERS_END */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
// Keep Electron's safeStorage export lazy so isolated demo profiles do not show
// macOS's native keychain dialog before our command-line policy is installed.
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net: electronNet,
  Notification: ElectronNotification,
  protocol,
  session,
  shell,
  systemPreferences,
} = require("electron");
const pty = require(["node", "pty"].join("-"));
const PRODUCT_PROFILE = getBuildProductProfile();
const INTERNAL_RENDERER_SCHEME = PRODUCT_PROFILE.brand.rendererScheme;
const REGISTERED_INTERNAL_RENDERER_ORIGIN = registerInternalRendererScheme(
  protocol,
  INTERNAL_RENDERER_SCHEME,
);
const OPENCODE_DISTRIBUTION_RECORD = PRODUCT_PROFILE.profile === "local-mvp"
  ? loadOpencodeDistributionSync({
      desktopRoot: path.resolve(__dirname, ".."),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    })
  : null;
const OPENCODE_DISTRIBUTION = OPENCODE_DISTRIBUTION_RECORD?.manifest ?? null;
const PACKAGED_RUNTIME_INTEGRITY =
  PRODUCT_PROFILE.profile === "local-mvp" && app.isPackaged
    ? loadPackagedRuntimeIntegritySync({
        resourcesPath: process.resourcesPath,
        distributionManifestPath: OPENCODE_DISTRIBUTION_RECORD.path,
      })
    : null;
const TRUSTED_RENDERER_ORIGIN = resolveDesktopApprovalTrustedRendererOrigin({
  productProfile: PRODUCT_PROFILE,
  isPackaged: app.isPackaged,
  env: process.env,
});
if (
  app.isPackaged &&
  TRUSTED_RENDERER_ORIGIN !== REGISTERED_INTERNAL_RENDERER_ORIGIN
) {
  throw new Error("Packaged renderer origin does not match the registered internal scheme");
}
applyDesktopProductEnvironmentPolicy({
  productProfile: PRODUCT_PROFILE,
  isPackaged: app.isPackaged,
  env: process.env,
});
const DYNAMIC_BRANDING_ENABLED = Boolean(
  PRODUCT_PROFILE.features.dynamicOrgBranding &&
  PRODUCT_PROFILE.features.remoteAssetFetches,
);
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
// The product environment policy above removes the raw development flag for
// packaged local-mvp before this or any later module can read/forward it.
const isDevMode = process.env.OPENWORK_DEV_MODE === "1" &&
  (PRODUCT_PROFILE.profile !== "local-mvp" || !app.isPackaged);
const DESKTOP_PRODUCT_POLICY = resolveDesktopProductPolicy({
  productProfile: PRODUCT_PROFILE,
  appRootPath: APP_ROOT,
  env: process.env,
  isDevMode,
  isPackaged: app.isPackaged,
});
const APP_IDENTIFIER = DESKTOP_PRODUCT_POLICY.appIdentifier;
const APP_USER_MODEL_ID = DESKTOP_PRODUCT_POLICY.appUserModelId;
const APP_NAME = DESKTOP_PRODUCT_POLICY.appName;
const DESKTOP_PROTOCOL_SCHEME = DESKTOP_PRODUCT_POLICY.protocol;
const PUBLIC_DEEP_LINKS_ENABLED = DESKTOP_PRODUCT_POLICY.publicDeepLinksEnabled;
let currentDisplayAppName = APP_NAME;
if (
  !app.isPackaged &&
  process.env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN === "1"
) {
  // Fresh, isolated development profiles otherwise trigger macOS's native
  // "Login" keychain prompt as soon as Chromium persists an authenticated
  // cookie. That modal blocks the entire Electron main loop and makes the demo
  // appear frozen. Packaged builds ignore this development environment hook
  // and continue to use the system keychain normally.
  app.commandLine.appendSwitch("use-mock-keychain");
}
const RELEASE_DOWNLOADS_ENABLED = Boolean(
  PRODUCT_PROFILE.features.automaticUpdates &&
  PRODUCT_PROFILE.features.remoteAssetFetches &&
  PRODUCT_PROFILE.brand.repository,
);
const RELEASE_REPOSITORY_URL = RELEASE_DOWNLOADS_ENABLED
  ? `https://github.com/${PRODUCT_PROFILE.brand.repository.owner}/${PRODUCT_PROFILE.brand.repository.name}/releases`
  : null;
const RELEASE_DOWNLOAD_BASE_URL = RELEASE_REPOSITORY_URL
  ? `${RELEASE_REPOSITORY_URL}/latest/download`
  : null;
const RELEASE_PAGE_URL = RELEASE_REPOSITORY_URL
  ? `${RELEASE_REPOSITORY_URL}/latest`
  : null;
const DOCS_PAGE_URL = PRODUCT_PROFILE.brand.docsUrl;
const applicationMenu = createApplicationMenu({
  appName: APP_NAME,
  docsUrl: DOCS_PAGE_URL,
  updatesEnabled: PRODUCT_PROFILE.features.automaticUpdates,
  developmentToolsEnabled: isDevMode && !app.isPackaged,
  getWindow: () => createMainWindow(),
});

const uiControlServer = createUiControlServer({
  appName: APP_NAME,
  appIdentifier: APP_IDENTIFIER,
  getWindow: () => createMainWindow(),
  getBrowserAutomationPolicy: () => browserPanel.browserAutomationPolicy(),
});

const terminalProcesses = new Map();
let nextTerminalId = 1;

function defaultTerminalShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

async function resolveTerminalCwd(cwd) {
  const fallback = os.homedir();
  if (typeof cwd !== "string" || !cwd.trim()) return fallback;
  const candidate = path.resolve(cwd);
  const info = await stat(candidate).catch(() => null);
  return info?.isDirectory() ? candidate : fallback;
}

function terminalForSender(event, terminalId) {
  const terminal = terminalProcesses.get(String(terminalId ?? ""));
  if (!terminal || terminal.webContentsId !== event.sender.id) return null;
  return terminal;
}

function killTerminal(terminalId) {
  const terminal = terminalProcesses.get(terminalId);
  if (!terminal) return;
  terminalProcesses.delete(terminalId);
  try { terminal.process.kill(); } catch { /* already gone */ }
}

function killTerminalsForWebContents(webContentsId) {
  for (const [terminalId, terminal] of terminalProcesses.entries()) {
    if (terminal.webContentsId === webContentsId) killTerminal(terminalId);
  }
}

// Resolve and create every application-owned path before Electron becomes
// ready. Packaged local-mvp builds ignore inherited path overrides; unpackaged
// development and tests may explicitly inject an isolated storage/userData
// root through the two documented OPENWORK_ELECTRON_* variables.
app.setName(APP_NAME);
app.setAppUserModelId(APP_USER_MODEL_ID);
if (
  DESKTOP_PROTOCOL_SCHEME &&
  app.isPackaged &&
  process.env.OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION !== "1"
) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const storageLayout = resolveElectronStorageLayout({
  appDataPath: app.getPath("appData"),
  appIdentifier: APP_IDENTIFIER,
  env: process.env,
  isPackaged: app.isPackaged,
  productProfile: PRODUCT_PROFILE.profile,
  platform: process.platform,
});
await ensureStorageLayout(storageLayout);
if (PRODUCT_PROFILE.profile === "local-mvp") {
  const memoryTemplateRoot = app.isPackaged
    ? path.join(process.resourcesPath, "agencyai-memory-system")
    : path.resolve(__dirname, "../resources/memory-system");
  try {
    const memorySystem = await ensureAgencyAiMemorySystem({
      opencodeConfigDir: storageLayout.opencodeConfig,
      templateRoot: memoryTemplateRoot,
    });
    if (memorySystem.config.error) {
      console.warn("[memory-system] templates installed but MEMORY.md is not active", memorySystem.config.error);
    } else if (memorySystem.createdFiles.length || memorySystem.config.status !== "unchanged") {
      console.info("[memory-system] app-owned memory configuration ready", {
        createdFiles: memorySystem.createdFiles,
        configPath: memorySystem.config.path,
        configStatus: memorySystem.config.status,
      });
    }
  } catch (error) {
    // Memory bootstrap must not prevent the local desktop from starting. The
    // packaged-resource and filesystem behavior is covered by focused tests.
    console.warn("[memory-system] failed to initialize", error);
  }
}
applyStorageLayoutEnvironment(process.env, storageLayout);
const networkAudit = createNetworkAuditFromEnvironment({
  env: process.env,
  storageRoot: storageLayout.root,
});
networkAudit?.installGlobalFetch(globalThis);
app.setPath("userData", storageLayout.userData);
app.setPath("sessionData", storageLayout.sessionData);
app.setAppLogsPath(storageLayout.logs);
app.setPath("crashDumps", storageLayout.crashDumps);

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: match Tauri's separate dev icon so the dev app is visibly distinct.
    ...(isDevMode
      ? [
          path.resolve(__dirname, "../resources/icons/dev/icon.png"),
          path.resolve(__dirname, "../resources/icons/dev/128x128@2x.png"),
          path.resolve(__dirname, "../resources/icons/dev/icon-dev.icns"),
        ]
      : []),
    // Repo-relative path to the Electron resource icon set.
    path.resolve(__dirname, "../resources/icons/icon.png"),
    // Packaged: electron-builder copies extraResources but we fall back to this
    // if custom packaging ever exposes the icon here.
    path.join(process.resourcesPath ?? "", "icons", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeRuntimeArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["arm64", "aarch64", "arm64e"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

function isMacRunningUnderRosetta() {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  try {
    return execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "1";
  } catch {
    return false;
  }
}

function resolveSystemArch() {
  if (process.platform === "darwin" && isMacRunningUnderRosetta()) return "arm64";
  if (process.platform === "win32") {
    return normalizeRuntimeArch(
      process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.arch(),
    );
  }
  if (typeof os.machine === "function") return normalizeRuntimeArch(os.machine());
  return normalizeRuntimeArch(os.arch());
}

function platformDownloadSlug() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function downloadAssetArch(arch) {
  if (process.platform === "linux" && arch === "x64") return "x86_64";
  return arch;
}

function downloadAssetExtension() {
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "win32") return "exe";
  return "AppImage";
}

function updaterManifestName(arch) {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "win32") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function parseUpdaterManifestFiles(raw) {
  const files = [];
  let current = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (start) {
      current = { url: start[1].trim().replace(/^['"]|['"]$/g, "") };
      files.push(current);
      continue;
    }
    const prop = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (prop && current) {
      current[prop[1]] = prop[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return files.filter((file) => file.url);
}

function selectDownloadFile(files, arch) {
  const assetArch = downloadAssetArch(arch);
  const expected = `-${assetArch}-`;
  const extension = downloadAssetExtension();
  const matchingArch = files.filter((file) => file.url.includes(expected));
  return (
    matchingArch.find((file) => file.url.endsWith(`.${extension}`)) ||
    matchingArch.find((file) => file.url.endsWith(".zip")) ||
    matchingArch[0] ||
    null
  );
}

async function resolveCorrectArchitectureDownloadUrl(arch) {
  if (!RELEASE_DOWNLOAD_BASE_URL) return null;
  const manifestUrl = `${RELEASE_DOWNLOAD_BASE_URL}/${updaterManifestName(arch)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await electronNet.fetch(manifestUrl, {
      signal: controller.signal,
      headers: { Accept: "text/yaml, text/plain, */*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const selected = selectDownloadFile(parseUpdaterManifestFiles(await response.text()), arch);
    if (!selected?.url) return null;
    return /^https?:\/\//i.test(selected.url)
      ? selected.url
      : new URL(selected.url, `${RELEASE_DOWNLOAD_BASE_URL}/`).toString();
  } catch (error) {
    console.warn("[architecture] failed to resolve latest download URL", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveArchitectureInfo() {
  const appArch = normalizeRuntimeArch(process.arch);
  const systemArch = resolveSystemArch();
  const version = app.getVersion();
  return resolveProductArchitectureInfo({
    appArch,
    systemArch,
    platform: process.platform,
    version,
    automaticUpdates: PRODUCT_PROFILE.features.automaticUpdates,
    remoteAssetFetches: PRODUCT_PROFILE.features.remoteAssetFetches,
    resolveDownloadUrl: resolveCorrectArchitectureDownloadUrl,
    fallbackDownloadUrl: (targetArch) => {
      if (!RELEASE_DOWNLOAD_BASE_URL) return null;
      const assetName =
        `${PRODUCT_PROFILE.brand.artifactPrefix}-${platformDownloadSlug()}-${downloadAssetArch(targetArch)}-${version}.${downloadAssetExtension()}`;
      return `${RELEASE_DOWNLOAD_BASE_URL}/${assetName}`;
    },
    releaseUrl: RELEASE_PAGE_URL,
  });
}

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;
const BRAND_ICON_MAX_BYTES = 2 * 1024 * 1024;
const BRAND_ICON_FETCH_TIMEOUT_MS = 10_000;
// Use a browser-shaped user agent so logo CDNs behave consistently when
// validating and applying a brand icon.
const BRAND_ICON_FETCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
let brandIconApplySequence = 0;
let brandIconRuntimeState = { applied: false, sourceUrl: null, reason: null };

function brandIconCachePath() {
  return path.join(app.getPath("userData"), "brand-icon.png");
}

function brandIconSidecarPath() {
  return path.join(app.getPath("userData"), "brand-icon.json");
}

function brandIconWindowsPath() {
  return path.join(app.getPath("userData"), "brand-icon.ico");
}

function defaultAppWindowsIconPath() {
  return path.join(app.getPath("userData"), "openwork-stock.ico");
}

let cachedWindowsProgramsPath = null;
function windowsProgramsPath() {
  if (cachedWindowsProgramsPath) return cachedWindowsProgramsPath;
  const userProfile = app.getPath("userData").split(/[\\/]AppData[\\/]/i)[0];
  cachedWindowsProgramsPath = path.join(userProfile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  return cachedWindowsProgramsPath;
}

function windowsBrandShortcutPath() {
  return path.join(windowsProgramsPath(), windowsBrandShortcutFileName(currentDisplayAppName));
}

function windowsInstalledShortcutPath() {
  return path.join(windowsProgramsPath(), windowsInstalledShortcutFileName(APP_NAME));
}

function windowsBrandShortcutMarkerPath() {
  return path.join(app.getPath("userData"), "windows-brand-shortcut.txt");
}

function windowsExecutablePath() {
  return windowsInstalledExecutablePath({
    packaged: app.isPackaged,
    execPath: app.getPath("exe"),
    resourcesPath: process.resourcesPath,
    shortcutPath: windowsBrandShortcutPath(),
  });
}

async function readWindowsBrandShortcutMarker() {
  return (await readFile(windowsBrandShortcutMarkerPath(), "utf8").catch(() => "")).trim();
}

function repairWindowsShortcutTarget(shortcutPath, details) {
  const payload = Buffer.from(JSON.stringify({ shortcutPath, ...details }), "utf8").toString("base64");
  const script = [
    `$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($value.shortcutPath)",
    "$link.TargetPath = $value.target",
    "$link.WorkingDirectory = $value.cwd",
    "$link.Description = $value.description",
    "$link.IconLocation = \"$($value.icon),$($value.iconIndex)\"",
    "$link.Save()",
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
  });
}

async function registerWindowsBrandShortcut(appId, appIconPath) {
  if (process.platform !== "win32") return null;
  const shortcutPath = windowsBrandShortcutPath();
  const shortcutTempPath = `${shortcutPath}.${process.pid}.tmp.lnk`;
  await mkdir(path.dirname(shortcutPath), { recursive: true });
  // Recreate instead of replacing in place. Explorer can retain the old
  // target and search metadata when a prior installer owned this path.
  await rm(shortcutPath, { force: true });
  await rm(shortcutTempPath, { force: true });
  const details = windowsBrandShortcutDetails({
    target: windowsExecutablePath(),
    appId,
    appIconPath,
    appName: currentDisplayAppName,
  });
  const written = writeWindowsBrandShortcut(shell, shortcutTempPath, details, false);
  if (!written) throw new Error(`Windows rejected the organization shortcut: ${shortcutPath}`);
  await rename(shortcutTempPath, shortcutPath);
  if (shell.readShortcutLink(shortcutPath).target !== details.target) {
    repairWindowsShortcutTarget(shortcutPath, details);
  }
  const previousShortcutPath = await readWindowsBrandShortcutMarker();
  if (previousShortcutPath && previousShortcutPath !== shortcutPath) {
    await rm(previousShortcutPath, { force: true });
  }
  if (windowsInstalledShortcutPath() !== shortcutPath) {
    await rm(windowsInstalledShortcutPath(), { force: true });
  }
  await writeFile(windowsBrandShortcutMarkerPath(), shortcutPath, "utf8");
  return shortcutPath;
}

async function removeWindowsBrandShortcut() {
  if (process.platform !== "win32") return;
  const shortcutPath = await readWindowsBrandShortcutMarker();
  if (shortcutPath) await rm(shortcutPath, { force: true });
  await rm(windowsBrandShortcutMarkerPath(), { force: true });
}

function resolveBrandIconImage() {
  if (!DYNAMIC_BRANDING_ENABLED) return null;
  try {
    const cachePath = brandIconCachePath();
    if (!existsSync(cachePath)) return null;
    const image = nativeImage.createFromPath(cachePath);
    return image && !image.isEmpty() ? image : null;
  } catch {
    return null;
  }
}

function brandIconFailure(reason, error) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.warn(`[brand-icon] ${reason}${detail ? `: ${detail}` : ""}`);
  return { ok: false, reason };
}

function recordBrandIconResult(result, sourceUrl) {
  if (result.ok) {
    brandIconRuntimeState = {
      applied: typeof sourceUrl === "string",
      sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
      reason: null,
    };
  } else {
    brandIconRuntimeState = { ...brandIconRuntimeState, reason: result.reason ?? "apply-failed" };
  }
  return result;
}

async function applyAppIconImage(image, { taskbarIconPath = null, taskbarAppId = APP_IDENTIFIER } = {}) {
  if (!image || image.isEmpty()) return brandIconFailure("invalid-image");
  try {
    if (process.platform === "darwin") {
      if (!app.dock) return brandIconFailure("dock-unavailable");
      app.dock.setIcon(image);
      return { ok: true };
    }

    if (process.platform === "win32") {
      if (!taskbarIconPath || !existsSync(taskbarIconPath)) {
        return brandIconFailure("taskbar-icon-missing");
      }
      if (!mainWindow) return { ok: true };
      await applyWindowsTaskbarIcon(mainWindow, {
        image,
        appId: taskbarAppId,
        appIconPath: taskbarIconPath,
        relaunchCommand: windowsExecutablePath(),
        relaunchDisplayName: currentDisplayAppName,
      });
    } else {
      if (!mainWindow) return brandIconFailure("window-unavailable");
      mainWindow.setIcon(image);
    }
    return { ok: true };
  } catch (error) {
    return brandIconFailure("os-apply-failed", error);
  }
}

async function applyDefaultAppIconImage(expectedSequence = null) {
  let image = APP_ICON_IMAGE;
  let taskbarIconPath = null;
  if (process.platform === "win32") {
    try {
      await removeWindowsBrandShortcut();
      app.setAppUserModelId(APP_IDENTIFIER);
    } catch (error) {
      return brandIconFailure("shortcut-remove-failed", error);
    }
    if (image && !image.isEmpty()) {
      try {
        taskbarIconPath = defaultAppWindowsIconPath();
        await writeWindowsIconFile(image, taskbarIconPath);
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    } else {
      try {
        const executableIcon = await app.getFileIcon(process.execPath, { size: "large" });
        if (executableIcon && !executableIcon.isEmpty()) image = executableIcon;
        taskbarIconPath = process.execPath;
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    }
  }
  if (!image || image.isEmpty()) {
    // Preserve the pre-existing no-op fallback on platforms whose packaged
    // application icon is managed entirely by the bundle.
    return process.platform === "win32" ? brandIconFailure("stock-icon-unavailable") : { ok: true };
  }
  if (process.platform === "win32" && taskbarIconPath) {
    try {
      await registerWindowsBrandShortcut(APP_IDENTIFIER, taskbarIconPath);
    } catch (error) {
      return brandIconFailure("shortcut-write-failed", error);
    }
  }
  if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
    return { ok: false, reason: "stale" };
  }
  return applyAppIconImage(image, {
    taskbarIconPath,
    taskbarAppId: APP_IDENTIFIER,
  });
}

async function focusMainWindowFromNotification() {
  const win = await createMainWindow();
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * @param {unknown} input
 * @returns {import("@openwork/types/desktop-ipc").DesktopNotificationResult}
 */
function showDesktopNotification(input) {
  if (!ElectronNotification.isSupported()) {
    return { ok: false, reason: "notifications unsupported" };
  }

  const record = input && typeof input === "object" ? input : {};
  const title = String(Reflect.get(record, "title") ?? "").trim();
  if (!title) {
    return { ok: false, reason: "missing title" };
  }

  const body = String(Reflect.get(record, "body") ?? "").trim();
  const icon = resolveBrandIconImage() ?? APP_ICON_IMAGE;
  const options = {
    title,
    ...(body ? { body } : {}),
    ...(Reflect.get(record, "silent") === true ? { silent: true } : {}),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  };

  try {
    const notification = new ElectronNotification(options);
    notification.on("click", () => {
      void focusMainWindowFromNotification();
    });
    notification.show();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "failed to show notification";
    return { ok: false, reason };
  }
}

async function readBrandIconSidecar() {
  if (!DYNAMIC_BRANDING_ENABLED) return null;
  try {
    const parsed = JSON.parse(await readFile(brandIconSidecarPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function clearBrandIconCache() {
  await Promise.all([
    rm(brandIconCachePath(), { force: true }),
    rm(brandIconSidecarPath(), { force: true }),
    rm(brandIconWindowsPath(), { force: true }),
  ]);
}

function normalizeBrandIconSourceUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

async function fetchBrandIconBuffer(sourceUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRAND_ICON_FETCH_TIMEOUT_MS);
  try {
    const response = await electronNet.fetch(sourceUrl, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      headers: {
        "user-agent": BRAND_ICON_FETCH_USER_AGENT,
        accept: "image/*,*/*",
      },
    });
    if (!response.ok) return { ok: false, reason: "http-status" };

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > BRAND_ICON_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > BRAND_ICON_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    return { ok: true, buffer };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function brandIconImageRejectionReason(image) {
  if (!image || image.isEmpty()) return "invalid-image";
  const size = image.getSize();
  if (size.width < 64 || size.height < 64) return "too-small";
  const aspectRatio = size.width / size.height;
  if (aspectRatio < 1 / 1.5 || aspectRatio > 1.5) return "invalid-aspect";
  return null;
}

async function writeBrandIconCache(image, sourceUrl) {
  const cachePath = brandIconCachePath();
  const sidecarPath = brandIconSidecarPath();
  const windowsPath = brandIconWindowsPath();
  const suffix = `${process.pid}-${Date.now()}`;
  const cacheTempPath = `${cachePath}.${suffix}.tmp`;
  const sidecarTempPath = `${sidecarPath}.${suffix}.tmp`;
  const windowsTempPath = `${windowsPath}.${suffix}.tmp`;
  const windowsIcon = process.platform === "win32" ? windowsIconFromNativeImage(image) : null;
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cacheTempPath, image.toPNG());
    if (windowsIcon) await writeFile(windowsTempPath, windowsIcon);
    await writeFile(sidecarTempPath, JSON.stringify({
      sourceUrl,
      appliedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
    }, null, 2), "utf8");
    await rename(cacheTempPath, cachePath);
    if (windowsIcon) await rename(windowsTempPath, windowsPath);
    await rename(sidecarTempPath, sidecarPath);
  } catch (error) {
    await Promise.all([
      rm(cacheTempPath, { force: true }),
      rm(sidecarTempPath, { force: true }),
      rm(windowsTempPath, { force: true }),
    ]).catch(() => undefined);
    throw error;
  }
}

async function writeWindowsIconFile(image, destination) {
  const tempPath = `${destination}.${process.pid}-${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(tempPath, windowsIconFromNativeImage(image));
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureWindowsBrandIcon(image) {
  if (process.platform !== "win32") return null;
  const windowsPath = brandIconWindowsPath();
  if (!existsSync(windowsPath)) await writeWindowsIconFile(image, windowsPath);
  return windowsPath;
}

async function registerWindowsDisplayShortcut() {
  if (process.platform !== "win32") return;
  const sidecar = await readBrandIconSidecar();
  const sourceUrl = typeof sidecar?.sourceUrl === "string" ? sidecar.sourceUrl : null;
  const brandedImage = sourceUrl ? resolveBrandIconImage() : null;
  if (brandedImage && sourceUrl) {
    const iconPath = await ensureWindowsBrandIcon(brandedImage);
    await registerWindowsBrandShortcut(windowsBrandAppUserModelId(APP_IDENTIFIER, sourceUrl), iconPath);
    return;
  }
  const stockImage = APP_ICON_IMAGE ?? await app.getFileIcon(windowsExecutablePath(), { size: "large" });
  const iconPath = defaultAppWindowsIconPath();
  await writeWindowsIconFile(stockImage, iconPath);
  await registerWindowsBrandShortcut(APP_IDENTIFIER, iconPath);
}

async function applyCachedBrandIcon(image, sourceUrl, expectedSequence = null) {
  let taskbarIconPath = null;
  let taskbarAppId = APP_IDENTIFIER;
  try {
    taskbarIconPath = await ensureWindowsBrandIcon(image);
    if (process.platform === "win32") {
      taskbarAppId = windowsBrandAppUserModelId(APP_IDENTIFIER, sourceUrl);
      await registerWindowsBrandShortcut(taskbarAppId, taskbarIconPath);
      app.setAppUserModelId(taskbarAppId);
    }
  } catch (error) {
    if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
      return { ok: false, reason: "stale" };
    }
    return recordBrandIconResult(brandIconFailure("write-failed", error), sourceUrl);
  }
  if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
    return { ok: false, reason: "stale" };
  }
  return recordBrandIconResult(await applyAppIconImage(image, {
    taskbarIconPath,
    taskbarAppId,
  }), sourceUrl);
}

async function applyBrandIconUrl(value) {
  const sequence = ++brandIconApplySequence;
  if (value === null) {
    const result = await applyDefaultAppIconImage(sequence);
    if (result.reason === "stale") return result;
    const applied = recordBrandIconResult(result, null);
    if (!applied.ok) return applied;
    try {
      await clearBrandIconCache();
      return applied;
    } catch (error) {
      return recordBrandIconResult(brandIconFailure("clear-failed", error), null);
    }
  }

  const sourceUrl = normalizeBrandIconSourceUrl(value);
  if (!sourceUrl) return recordBrandIconResult(brandIconFailure("invalid-url"), null);

  const sidecar = await readBrandIconSidecar();
  const cachedImage = resolveBrandIconImage();
  if (sidecar?.sourceUrl === sourceUrl && cachedImage) {
    return applyCachedBrandIcon(cachedImage, sourceUrl, sequence);
  }

  const fetched = await fetchBrandIconBuffer(sourceUrl);
  if (sequence !== brandIconApplySequence) return { ok: false, reason: "stale" };
  if (!fetched.ok) return recordBrandIconResult(brandIconFailure(fetched.reason), sourceUrl);

  const image = nativeImage.createFromBuffer(fetched.buffer);
  const rejectionReason = brandIconImageRejectionReason(image);
  if (rejectionReason) return recordBrandIconResult(brandIconFailure(rejectionReason), sourceUrl);

  try {
    await writeBrandIconCache(image, sourceUrl);
  } catch (error) {
    if (sequence !== brandIconApplySequence) return { ok: false, reason: "stale" };
    return recordBrandIconResult(brandIconFailure("write-failed", error), sourceUrl);
  }
  if (sequence !== brandIconApplySequence) {
    const latestSidecar = await readBrandIconSidecar();
    if (latestSidecar?.sourceUrl === sourceUrl) {
      await clearBrandIconCache().catch(() => undefined);
    }
    return { ok: false, reason: "stale" };
  }
  return applyCachedBrandIcon(image, sourceUrl, sequence);
}

async function getBrandIconState() {
  return { ...brandIconRuntimeState };
}

const INITIAL_APP_ICON_IMAGE = resolveBrandIconImage() ?? APP_ICON_IMAGE;
if (process.platform === "darwin" && INITIAL_APP_ICON_IMAGE && !INITIAL_APP_ICON_IMAGE.isEmpty() && app.dock) {
  app.dock.setIcon(INITIAL_APP_ICON_IMAGE);
}

// Expose Chrome DevTools Protocol only for the profile-enabled built-in browser.
// Packaged launches choose an unpredictable high loopback port on every start;
// an explicit port is accepted only by unpackaged test/development profiles.
const explicitCdpPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
const remoteDebugPort = PRODUCT_PROFILE.features.browserAutomation
  ? !app.isPackaged &&
      Number.isFinite(explicitCdpPort) &&
      explicitCdpPort > 0
    ? explicitCdpPort
    : randomInt(49_152, 65_536)
  : 0;
if (remoteDebugPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
// Make the resolved port available to the embedded server so it flows into
// agent instructions via ensureOpenworkAgent → resolveAgentTemplate.
process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = String(remoteDebugPort);
if (isDevMode && !app.isPackaged) {
  const cdpAddress = remoteDebugPort > 0 ? `http://127.0.0.1:${remoteDebugPort}` : "disabled";
  console.log(`[openwork] dev profile=${app.getPath("userData")} cdp=${cdpAddress}`);
}

// Apply extra Chromium flags from ELECTRON_EXTRA_LAUNCH_ARGS.
// Used in headless/Daytona environments to pass e.g. --disable-gpu.
const extraLaunchArgs =
  PRODUCT_PROFILE.profile === "local-mvp" && app.isPackaged
    ? ""
    : (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
if (extraLaunchArgs) {
  for (const arg of extraLaunchArgs.split(/\s+/)) {
    const cleaned = arg.replace(/^--/, "");
    if (!cleaned) continue;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx > 0) {
      app.commandLine.appendSwitch(cleaned.slice(0, eqIdx), cleaned.slice(eqIdx + 1));
    } else {
      app.commandLine.appendSwitch(cleaned);
    }
  }
}
configureFakeMediaForTests(
  app,
  !app.isPackaged && envFlagEnabled("OPENWORK_ELECTRON_FAKE_MEDIA"),
);
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
const FORCE_DESKTOP_REQUIRE_SIGNIN = envFlagEnabled("OPENWORK_FORCE_SIGNIN");
const DEFAULT_DESKTOP_REQUIRE_SIGNIN = FORCE_DESKTOP_REQUIRE_SIGNIN;

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  managedByServer: false,
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
  opencodeBinPath: null,
  opencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_OPENWORK_SERVER_INFO = Object.freeze({
  running: false,
  remoteAccessEnabled: false,
  host: null,
  port: null,
  baseUrl: null,
  connectUrl: null,
  mdnsUrl: null,
  lanUrl: null,
  clientToken: null,
  ownerToken: null,
  hostToken: null,
  managedOpencodeBinPath: null,
  managedOpencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_ROUTER_INFO = Object.freeze({
  running: false,
  version: null,
  workspacePath: null,
  opencodeUrl: null,
  healthPort: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

let mainWindow = null;
let internalRendererProtocolInstalled = false;
const pendingDeepLinks = [];

function authorizeMainIpcSender(event) {
  return assertDesktopApprovalIpcSender({
    event,
    mainWindow,
    trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
  });
}

async function authorizedLocalFileRoots() {
  return [
    storageLayout.root,
    ...await workspaceStore.listLocalWorkspacePaths(),
  ];
}

async function authorizeDesktopLocalFile(value, options = {}) {
  return authorizeLocalFileTarget(value, {
    allowedRoots: await authorizedLocalFileRoots(),
    allowMissing: options.allowMissing === true,
  });
}

function ensureInternalRendererProtocol() {
  if (internalRendererProtocolInstalled) return;
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app-dist")
    : path.resolve(__dirname, "../../app/dist");
  installInternalRendererProtocol({
    protocolModule: protocol,
    rendererRoot,
    netFetch: (url, options) => electronNet.fetch(url, options),
    scheme: INTERNAL_RENDERER_SCHEME,
  });
  internalRendererProtocolInstalled = true;
}

const browserPanel = createBrowserPanel({
  remoteDebugPort,
  getWindow: () => mainWindow,
  trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
  openExternal: openExternalUrl,
  onDeepLink: PUBLIC_DEEP_LINKS_ENABLED
    ? (urls) => queueDeepLinks(urls)
    : null,
});

const workspaceStore = createWorkspaceStore({
  app,
  defaultDenBaseUrl: DEFAULT_DEN_BASE_URL,
  defaultRequireSignin: DEFAULT_DESKTOP_REQUIRE_SIGNIN,
  forceRequireSignin: FORCE_DESKTOP_REQUIRE_SIGNIN,
  storageLayout,
  legacyOpenWorkImport: PRODUCT_PROFILE.features.legacyOpenWorkImport,
});

const connectLinkReplayGuard = createConnectLinkReplayGuard({
  filePath: path.join(app.getPath("userData"), "connect-link-seen.json"),
});

/** @returns {import("@openwork/types/connect-link").ConnectLinkVerifyFailure} */
function disabledConnectLinkResult() {
  return {
    ok: false,
    code: "unavailable",
    message: "Connect links are disabled in this product.",
  };
}

/**
 * @param {string} rawUrl
 * @returns {import("@openwork/types/connect-link").ConnectLinkVerifyResult}
 */
function verifyConnectLink(rawUrl) {
  if (!PRODUCT_PROFILE.features.connectLinks) {
    return disabledConnectLinkResult();
  }
  return verifyConnectLinkUrl(String(rawUrl ?? ""), {
    publicKeys: resolveConnectLinkPublicKeys(),
    // http is refused everywhere except loopback targets in dev runs.
    allowInsecureLoopback: isDevMode,
  });
}

async function previewConnectLink(rawUrl) {
  if (!PRODUCT_PROFILE.features.connectLinks) {
    return disabledConnectLinkResult();
  }
  if (extractConnectExchange(rawUrl)) {
    return resolveConnectExchangeUrl(rawUrl, {
      mode: "preview",
      fetcher: electronNet.fetch,
      allowInsecureLoopback: isDevMode,
    });
  }
  return verifyConnectLink(rawUrl);
}

async function acceptConnectLink(rawUrl) {
  if (!PRODUCT_PROFILE.features.connectLinks) {
    return disabledConnectLinkResult();
  }
  if (extractConnectExchange(rawUrl)) {
    return resolveConnectExchangeUrl(rawUrl, {
      mode: "exchange",
      fetcher: electronNet.fetch,
      allowInsecureLoopback: isDevMode,
    });
  }
  return verifyConnectLink(rawUrl);
}

async function persistConnectLinkClaims(claims) {
  return persistConnectLinkBranding(claims, {
    persistBootstrap: (config) => workspaceStore.setDesktopBootstrapConfig(config),
    applyBrandIconUrl: (iconUrl) => applyBrandIconUrl(iconUrl).catch((error) =>
      brandIconFailure("connect-apply-failed", error)),
  });
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function forwardedDeepLinks(argv) {
  return forwardedProductDeepLinks(argv, DESKTOP_PROTOCOL_SCHEME);
}

function queueDeepLinks(urls) {
  if (!PUBLIC_DEEP_LINKS_ENABLED) return;
  const nextUrls = urls.filter(Boolean);
  if (nextUrls.length === 0) return;
  pendingDeepLinks.push(...nextUrls);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, nextUrls);
  }
}

function flushPendingDeepLinks() {
  if (!PUBLIC_DEEP_LINKS_ENABLED) return;
  if (!mainWindow?.webContents || pendingDeepLinks.length === 0) return;
  const urls = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, urls);
}

function globalOpencodeRoot() {
  return globalOpencodeConfigDir();
}

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeCommandName(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const safe = Array.from(trimmed)
    .filter((char) => /[A-Za-z0-9_-]/.test(char))
    .join("");
  return safe || null;
}

function escapeYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function serializeCommandFrontmatter(command) {
  const template = String(command?.template ?? "").trim();
  if (!template) {
    throw new Error("command.template is required");
  }

  let output = "---\n";
  if (typeof command?.description === "string" && command.description.trim()) {
    output += `description: ${escapeYamlScalar(command.description.trim())}\n`;
  }
  if (typeof command?.agent === "string" && command.agent.trim()) {
    output += `agent: ${escapeYamlScalar(command.agent.trim())}\n`;
  }
  if (typeof command?.model === "string" && command.model.trim()) {
    output += `model: ${escapeYamlScalar(command.model.trim())}\n`;
  }
  if (command?.subtask === true) {
    output += "subtask: true\n";
  }
  output += `---\n\n${template}\n`;
  return output;
}

function validateSkillName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: () => workspaceStore.listLocalWorkspacePaths(),
  storageLayout,
  storageEnvironment: storageLayoutEnvironment(storageLayout),
  allowRemoteAccess: PRODUCT_PROFILE.features.remoteAccess,
  productPolicy: PRODUCT_PROFILE,
  opencodeDistribution: OPENCODE_DISTRIBUTION,
  packagedRuntimeIntegrity: PACKAGED_RUNTIME_INTEGRITY,
  trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
});

let runtimeDisposedForQuit = false;
let runtimeDisposeInProgress = false;
let runtimeBootstrapPromise = null;
let desktopApprovalContextEpoch = 0;

async function revokeDesktopApprovalGrantsBeforeRuntimeChange() {
  desktopApprovalContextEpoch += 1;
  await runtimeManager.revokeAllDesktopApprovalGrants();
}

function revokeDesktopApprovalGrantsForWebContents(webContentsId) {
  desktopApprovalContextEpoch += 1;
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
  void runtimeManager
    .revokeDesktopApprovalGrantsForWebContents(webContentsId)
    .catch(() => undefined);
}

function showShutdownScreen() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.show();
    win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: #0b0b0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { display: grid; gap: 10px; justify-items: center; }
      .spinner { width: 22px; height: 22px; border: 2px solid rgba(244,244,245,.25); border-top-color: #f4f4f5; border-radius: 50%; animation: spin .9s linear infinite; }
      .title { font-size: 15px; font-weight: 600; }
      .body { font-size: 13px; color: #a1a1aa; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">Stopping AgencyAI services</div>
      <div class="body">Closing local workers and background services...</div>
    </main>
  </body>
</html>`)}`);
  } catch {
    // Ignore renderer teardown races during quit.
  }
}

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit || runtimeDisposeInProgress) return;
  runtimeDisposeInProgress = true;
  try {
    await runtimeManager.dispose().catch(() => undefined);
    runtimeDisposedForQuit = true;
  } finally {
    runtimeDisposeInProgress = false;
  }
}

function assertOpenworkServerReady(info) {
  if (!info?.running) {
    throw new Error("OpenWork server did not stay running after startup.");
  }
  if (!info.baseUrl) {
    throw new Error("OpenWork server did not report a base URL after startup.");
  }
  if (!info.ownerToken && !info.clientToken) {
    throw new Error("OpenWork server did not report an access token after startup.");
  }
  return info;
}

async function bootRuntimeForSelectedWorkspace() {
  const list = await workspaceStore.readWorkspaceState();
  const selectedId = list.selectedId || list.activeId || list.workspaces[0]?.id || "";
  const workspace = selectedId
    ? list.workspaces.find((entry) => entry?.id === selectedId)
    : list.workspaces[0];
  const workspaceRoot = String(workspace?.path ?? "").trim();
  if (!workspaceRoot || workspace?.workspaceType === "remote") {
    return { ok: true, skipped: true, reason: "no-local-workspace" };
  }

  const workspacePaths = [];
  for (const entry of list.workspaces) {
    if (entry?.workspaceType === "remote") continue;
    const workspacePath = String(entry?.path ?? "").trim();
    if (workspacePath && !workspacePaths.includes(workspacePath)) workspacePaths.push(workspacePath);
  }
  if (!workspacePaths.includes(workspaceRoot)) workspacePaths.unshift(workspaceRoot);

  let bootWorkspace = workspace;
  let bootWorkspaceRoot = workspaceRoot;
  let engine;
  try {
    engine = await runtimeManager.engineStart(workspaceRoot, {
      runtime: "direct",
      workspacePaths,
    });
  } catch (error) {
    const fallback = list.workspaces.find((entry) => {
      const candidatePath = String(entry?.path ?? "").trim();
      return entry?.workspaceType !== "remote" && candidatePath && candidatePath !== workspaceRoot;
    });
    const fallbackRoot = String(fallback?.path ?? "").trim();
    if (!fallback || !fallbackRoot) throw error;
    console.warn("[runtime] selected workspace failed during boot; trying fallback workspace", {
      selectedWorkspaceId: workspace?.id ?? null,
      fallbackWorkspaceId: fallback.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackWorkspacePaths = [
      fallbackRoot,
      ...workspacePaths.filter((entry) => entry !== fallbackRoot && entry !== workspaceRoot),
    ];
    engine = await runtimeManager.engineStart(fallbackRoot, {
      runtime: "direct",
      workspacePaths: fallbackWorkspacePaths,
    });
    bootWorkspace = fallback;
    bootWorkspaceRoot = fallbackRoot;
    await workspaceStore.writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
  await runtimeManager.orchestratorWorkspaceActivate({
    workspacePath: bootWorkspaceRoot,
    name: bootWorkspace.name ?? bootWorkspace.displayName ?? null,
  }).catch(() => undefined);
  const openworkServer = assertOpenworkServerReady(await runtimeManager.openworkServerInfo());
  return { ok: true, skipped: false, engine, openworkServer, workspaceId: bootWorkspace.id ?? null };
}

function ensureRuntimeBootstrap() {
  if (!runtimeBootstrapPromise) {
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return runtimeBootstrapPromise;
}

function resolveOpencodeConfigPath(scope, projectDir) {
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return workspaceOpencodeConfigCandidates(projectDir);
  } else if (scope === "global") {
    const root = globalOpencodeRoot();
    return [path.join(root, "opencode.jsonc"), path.join(root, "opencode.json")];
  } else {
    throw new Error("scope must be 'project' or 'global'");
  }
}

async function selectOpencodeConfigPath(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0];
}

async function readOpencodeConfig(scope, projectDir) {
  const chosenPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const targetPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return execResult(true, `Wrote ${targetPath}`);
}

function resolveCommandsDir(scope, projectDir) {
  if (scope === "workspace") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return path.join(projectDir, ".opencode", "commands");
  }
  if (scope === "global") {
    return path.join(globalOpencodeRoot(), "commands");
  }
  throw new Error("scope must be 'workspace' or 'global'");
}

async function listCommandNames(scope, projectDir) {
  const commandsDir = resolveCommandsDir(scope, projectDir);
  if (!(await isDirectory(commandsDir))) {
    return [];
  }
  const entries = await readdir(commandsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

async function writeCommandFile(scope, projectDir, command) {
  const safeName = sanitizeCommandName(command?.name);
  if (!safeName) {
    throw new Error("command.name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  await mkdir(commandsDir, { recursive: true });
  const filePath = path.join(commandsDir, `${safeName}.md`);
  await writeFile(filePath, serializeCommandFrontmatter({ ...command, name: safeName }), "utf8");
  return execResult(true, `Wrote ${filePath}`);
}

async function deleteCommandFile(scope, projectDir, name) {
  const safeName = sanitizeCommandName(name);
  if (!safeName) {
    throw new Error("name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  const filePath = path.join(commandsDir, `${safeName}.md`);
  if (await pathExists(filePath)) {
    await rm(filePath, { force: true });
  }
  return execResult(true, `Deleted ${filePath}`);
}

async function collectProjectSkillRoots(projectDir) {
  const roots = [];
  let current = path.resolve(projectDir);

  while (true) {
    const opencodeSkills = path.join(current, ".opencode", "skills");
    const legacySkills = path.join(current, ".opencode", "skill");
    const claudeSkills = path.join(current, ".claude", "skills");

    if (await isDirectory(opencodeSkills)) roots.push(opencodeSkills);
    if (await isDirectory(legacySkills)) roots.push(legacySkills);
    if (await isDirectory(claudeSkills)) roots.push(claudeSkills);

    if (await pathExists(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

async function collectGlobalSkillRoots() {
  const roots = [];
  const candidates = [
    path.join(globalOpencodeRoot(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }

  return roots;
}

async function collectSkillRoots(projectDir) {
  const roots = [...(await collectProjectSkillRoots(projectDir)), ...(await collectGlobalSkillRoots())];
  return roots.filter((value, index) => roots.indexOf(value) === index);
}

async function findSkillDirsInRoot(root) {
  const found = [];
  if (!(await isDirectory(root))) return found;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    if (await pathExists(path.join(direct, "SKILL.md"))) {
      found.push(direct);
      continue;
    }

    const nestedEntries = await readdir(direct, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (await pathExists(path.join(nestedDir, "SKILL.md"))) {
        found.push(nestedDir);
      }
    }
  }

  return found;
}

function extractFrontmatterValue(raw, keys) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!keys.includes(key)) continue;
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  return null;
}

function extractTrigger(raw) {
  return extractFrontmatterValue(raw, ["trigger", "when"]);
}

function extractDescription(raw) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    return cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned;
  }
  return null;
}

async function listLocalSkills(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }

  const seen = new Set();
  const out = [];
  for (const root of await collectSkillRoots(projectDir)) {
    for (const skillDir of await findSkillDirsInRoot(root)) {
      const name = path.basename(skillDir);
      if (seen.has(name)) continue;
      seen.add(name);
      let raw = "";
      try {
        raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        raw = "";
      }
      out.push({
        name,
        path: skillDir,
        description: extractDescription(raw) ?? undefined,
        trigger: extractTrigger(raw) ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillFile(projectDir, name) {
  const safeName = validateSkillName(name);
  for (const root of await collectSkillRoots(projectDir)) {
    const direct = path.join(root, safeName, "SKILL.md");
    if (await pathExists(direct)) return direct;

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, safeName, "SKILL.md");
      if (await pathExists(nested)) return nested;
    }
  }
  return null;
}

async function ensureProjectSkillRoot(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }
  const opencodeRoot = path.join(projectDir, ".opencode");
  const legacy = path.join(opencodeRoot, "skill");
  const modern = path.join(opencodeRoot, "skills");
  if ((await isDirectory(legacy)) && !(await pathExists(modern))) {
    await rename(legacy, modern);
  }
  await mkdir(modern, { recursive: true });
  return modern;
}

function engineDoctor(options = {}) {
  return runtimeManager.engineDoctor(options);
}

function activeWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

function macosVibrancyForCurrentTheme() {
  return nativeTheme.shouldUseDarkColors ? "under-window" : "sidebar";
}

function applyNativeTheme(mode) {
  nativeTheme.themeSource = mode;

  if (process.platform !== "darwin") {
    return true;
  }

  mainWindow?.setVibrancy(macosVibrancyForCurrentTheme());
  mainWindow?.setBackgroundColor("#00000001");

  return true;
}

// Desktop IPC command registry. Every command invokable from the renderer's
// desktopBridge Proxy (apps/app/src/app/lib/desktop.ts) has exactly one
// entry here; handlers receive the ipcMain event followed by the renderer
// arguments. The @type below asserts this registry against the shared
// DesktopCommandMap contract (packages/types/src/desktop-ipc.ts): a missing,
// extra, or renamed command fails `pnpm --filter @openwork/desktop
// typecheck:electron`.
/** @type {import("@openwork/types/desktop-ipc").DesktopCommandHandlers<import("electron").IpcMainInvokeEvent>} */
const desktopCommandHandlers = {
  "workspaceBootstrap": async (event, ...args) => {
      return workspaceStore.readWorkspaceState();
  },
  "workspaceSetSelected": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.setSelectedWorkspace(typeof args[0] === "string" ? args[0] : "");
  },
  "workspaceSetRuntimeActive": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.setRuntimeActiveWorkspace(typeof args[0] === "string" && args[0].trim() ? args[0] : null);
  },
  "workspaceCreate": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.createWorkspace(args[0] ?? {});
  },
  "workspaceCreateRemote": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.createRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateRemote": async (event, ...args) => {
      return workspaceStore.updateRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateDisplayName": async (event, ...args) => {
      return workspaceStore.updateWorkspaceDisplayName(args[0] ?? {});
  },
  "workspaceForget": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.forgetWorkspace(String(args[0] ?? "").trim());
  },
  "workspaceAddAuthorizedRoot": async (event, ...args) => {
      return workspaceStore.addAuthorizedRoot(args[0] ?? {});
  },
  "workspaceOpenworkRead": async (event, ...args) => {
      return workspaceStore.readWorkspaceOpenworkConfig(String(args[0]?.workspacePath ?? "").trim());
  },
  "workspaceOpenworkWrite": async (event, ...args) => {
      return workspaceStore.writeWorkspaceOpenworkConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? workspaceStore.defaultWorkspaceOpenworkConfig(""),
      );
  },
  "workspaceExportConfig": async (event, ...args) => {
      return workspaceStore.exportConfig(args[0] ?? {});
  },
  "workspaceImportConfig": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.importConfig(args[0] ?? {});
  },
  "opencodeCommandList": async (event, ...args) => {
      return listCommandNames(String(args[0]?.scope ?? "").trim(), String(args[0]?.projectDir ?? "").trim());
  },
  "opencodeCommandWrite": async (event, ...args) => {
      return writeCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        args[0]?.command ?? {},
      );
  },
  "opencodeCommandDelete": async (event, ...args) => {
      return deleteCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        String(args[0]?.name ?? "").trim(),
      );
  },
  "engineStart": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return runtimeManager.engineStart(projectDir, options);
  },
  "prepareFreshRuntime": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return runtimeManager.prepareFreshRuntime();
  },
  "runtimeBootstrap": async (event, ...args) => {
      return ensureRuntimeBootstrap();
  },
  "runtimeStatus": async (event, ...args) => {
      return runtimeManager.runtimeStatus();
  },
  "engineStop": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return runtimeManager.engineStop();
  },
  "engineRestart": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return runtimeManager.engineRestart(args[0] ?? {});
  },
  "engineInfo": async (event, ...args) => {
      return runtimeManager.engineInfo();
  },
  "engineDoctor": async (event, ...args) => {
      return engineDoctor(args[0]);
  },
  "engineInstall": async (event, ...args) => {
      return runtimeManager.engineInstall();
  },
  "orchestratorStatus": async (event, ...args) => {
      return runtimeManager.orchestratorStatus();
  },
  "orchestratorWorkspaceActivate": async (event, ...args) => {
      return runtimeManager.orchestratorWorkspaceActivate(args[0] ?? {});
  },
  "orchestratorInstanceDispose": async (event, ...args) => {
      return runtimeManager.orchestratorInstanceDispose(String(args[0] ?? "").trim());
  },
  "appBuildInfo": async (event, ...args) => {
      return createAppBuildInfo({
        appVersion: app.getVersion(),
        env: process.env,
        platform: process.platform,
        arch: process.arch,
      });
  },
  "releaseMetadataRead": async (event, ...args) => {
      /** @type {Map<import("@openwork/types/desktop-ipc").ReleaseMetadataFile, import("@openwork/types/desktop-ipc").ReleaseMetadataDocument["mediaType"]>} */
      const allowedFiles = new Map([
        ["THIRD_PARTY_NOTICES.txt", "text/plain"],
        ["ELECTRON-LICENSE.txt", "text/plain"],
        ["LICENSES.chromium.html", "text/html"],
        ["agencyai-desktop.spdx.json", "application/json"],
        ["agencyai-desktop.cdx.json", "application/json"],
        ["release-manifest.json", "application/json"],
      ]);
      const fileName = args[0];
      const mediaType = allowedFiles.get(fileName);
      if (!mediaType) {
        throw new Error("Release metadata file is not allowlisted");
      }
      /** @type {import("@openwork/types/desktop-ipc").ReleaseMetadataDocument} */
      const unavailable = {
        available: false,
        fileName,
        mediaType,
        content: null,
        size: null,
        sha256: null,
      };
      if (!app.isPackaged) return unavailable;
      const metadataRoot = path.join(
        process.resourcesPath,
        "release-metadata",
      );
      const filePath = path.join(metadataRoot, fileName);
      const relativePath = path.relative(metadataRoot, filePath);
      if (
        !relativePath
        || relativePath.startsWith("..")
        || path.isAbsolute(relativePath)
      ) {
        throw new Error("Release metadata path escaped its allowlisted root");
      }
      let fileStats;
      try {
        fileStats = await lstat(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") return unavailable;
        throw error;
      }
      if (
        !fileStats.isFile()
        || fileStats.isSymbolicLink()
        || fileStats.size > 32 * 1024 * 1024
      ) {
        throw new Error("Release metadata file is unsafe or too large");
      }
      const content = await readFile(filePath, "utf8");
      return {
        available: true,
        fileName,
        mediaType,
        content,
        size: fileStats.size,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
  },
  "desktopNotificationShow": async (event, ...args) => {
      return showDesktopNotification(args[0] ?? {});
  },
  "getUiControlBridgeInfo": async (event, ...args) => {
      try {
        const raw = await readFile(path.join(app.getPath("userData"), "openwork-ui-control.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
  },
  "getOpenworkUiMcpCommand": async (event, ...args) => {
      if (process.env.OPENWORK_DEV_MODE === "1") {
        return ["node", path.resolve(__dirname, "../../..", "packages/openwork-ui-mcp/index.mjs")];
      }
      return ["npx", "-y", "openwork-ui-mcp"];
  },
  "getComputerUseMcpCommand": async (event, ...args) => {
      return getComputerUseMcpCommand();
  },
  "checkComputerUsePermissions": async (event, ...args) => {
      // Spawn --check → fresh TCC read → always accurate.
      return checkComputerUsePermissions();
  },
  "listRunningApps": async (event, ...args) => {
      // Running regular macOS apps for composer @App mentions.
      return listRunningApps();
  },
  "openComputerUsePermissionSetup": async (event, ...args) => {
      // Open the GUI app. Returns immediately — React shows "verify" CTA.
      await openComputerUseSetupApp();
      // Return a fresh check so the UI shows the current state.
      return checkComputerUsePermissions();
  },
  "openComputerUsePermissionSettings": async (event, ...args) => {
      // Legacy: open the setup app (same as above).
      await openComputerUseSetupApp();
      return checkComputerUsePermissions();
  },
  "getOpenworkUiMcpEnvironment": async (event, ...args) => {
      return {
        OPENWORK_UI_CONTROL_DISCOVERY: path.join(app.getPath("userData"), "openwork-ui-control.json"),
      };
  },
  "getDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.getDesktopBootstrapConfig();
  },
  "debugDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.debugDesktopBootstrapConfig();
  },
  "clearDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.clearDesktopBootstrapConfig();
  },
  "setDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.setDesktopBootstrapConfig(args[0] ?? {});
  },
  "connectLinkVerify": async (event, ...args) => {
      // Read-only check — parses + verifies the deep link, writes nothing.
      // Replay is surfaced here too so an already-used link gets its refusal
      // before the user is ever shown a confirmation.
      const verified = await previewConnectLink(String(args[0] ?? ""));
      if (verified.ok === false) return verified;
      if (verified.transport === "signed" && await connectLinkReplayGuard.has(verified.claims.jti)) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      return verified;
  },
  "connectLinkAccept": async (event, ...args) => {
      // The renderer passes the raw URL back after the user confirmed; claims
      // shaped in the renderer are never trusted (desktop-ipc trust boundary).
      const verified = await acceptConnectLink(String(args[0] ?? ""));
      if (verified.ok === false) return verified;
      if (verified.transport === "exchange") {
        const config = await persistConnectLinkClaims(verified.claims);
        return { ok: true, config };
      }
      if (await connectLinkReplayGuard.has(verified.claims.jti)) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      // Consume before mutation. If the replay ledger cannot be persisted,
      // fail closed and leave the existing bootstrap untouched.
      if (!(await connectLinkReplayGuard.remember(verified.claims.jti))) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      const config = await persistConnectLinkClaims(verified.claims);
      return { ok: true, config };
  },
  "nukeOpenworkAndOpencodeConfigPreview": async (event, ...args) => {
      if (!PRODUCT_PROFILE.features.freshStart) {
        return {
          deletePaths: [],
          bootstrapPath: storageLayout.bootstrap,
          preserveBootstrapPath: storageLayout.bootstrap,
          partitions: [],
        };
      }
      return buildNukeManifest({
        env: process.env,
        homedir: os.homedir(),
        platform: process.platform,
        preserveBootstrap: args[0]?.preserveBootstrap !== false,
        userDataPath: app.getPath("userData"),
        workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
      });
  },
  "nukeOpenworkAndOpencodeConfigAndExit": async (event, ...args) => {
      if (!PRODUCT_PROFILE.features.freshStart) {
        return {
          deleted: [],
          pendingRetry: [],
          errors: [{
            path: storageLayout.root,
            message: "Fresh Start is disabled in this product.",
            code: "feature_disabled",
          }],
          preservedBootstrap: true,
          relaunchMode: "direct",
          workerScheduled: false,
        };
      }
      return executeNukeFreshStart({
        app,
        session,
        runtimeManager,
        uiControlServer,
        removeWindowsBrandShortcut,
      }, {
        preserveBootstrap: args[0]?.preserveBootstrap !== false,
        input: {
          env: process.env,
          homedir: os.homedir(),
          platform: process.platform,
          userDataPath: app.getPath("userData"),
          workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
        },
      });
  },
  "orchestratorStartDetached": async (event, ...args) => {
      return runtimeManager.orchestratorStartDetached(args[0] ?? {});
  },
  "sandboxDoctor": async (event, ...args) => {
      return runtimeManager.sandboxDoctor();
  },
  "sandboxStop": async (event, ...args) => {
      return runtimeManager.sandboxStop(String(args[0] ?? "").trim());
  },
  "sandboxCleanupOpenworkContainers": async (event, ...args) => {
      return runtimeManager.sandboxCleanupOpenworkContainers();
  },
  "sandboxDebugProbe": async (event, ...args) => {
      return runtimeManager.sandboxDebugProbe();
  },
  "openworkServerInfo": async (event, ...args) => {
      return runtimeManager.openworkServerInfo();
  },
  "openworkServerRestart": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return runtimeManager.openworkServerRestart(args[0] ?? {});
  },
  "desktopApprovalGrant": async (event, ...args) => {
      const webContentsId = assertDesktopApprovalIpcSender({
        event,
        mainWindow,
        trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
      });
      const contextEpoch = desktopApprovalContextEpoch;
      const runtimeInfo = await runtimeManager.openworkServerInfo();
      const workspaceState = await workspaceStore.readWorkspaceState();
      if (contextEpoch !== desktopApprovalContextEpoch) {
        throw new Error("Desktop approval denied: renderer context changed");
      }
      assertDesktopApprovalIpcSender({
        event,
        mainWindow,
        trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
      });
      const context = resolveDesktopApprovalRequestContext({
        request: args[0],
        workspaceState,
        runtimeInfo,
        webContentsId,
      });

      const grant = await runtimeManager.desktopApprovalGrant(context);
      try {
        if (contextEpoch !== desktopApprovalContextEpoch) {
          throw new Error("Desktop approval denied: renderer context changed");
        }
        assertDesktopApprovalIpcSender({
          event,
          mainWindow,
          trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
        });
      } catch (error) {
        await runtimeManager
          .revokeDesktopApprovalGrantsForWebContents(webContentsId)
          .catch(() => undefined);
        throw error;
      }
      return grant;
  },
  "pickDirectory": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "pickFile": async (event, ...args) => {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple ? ["openFile", "multiSelections"] : ["openFile"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
  },
  "saveFile": async (event, ...args) => {
      const options = args[0] ?? {};
      const result = await dialog.showSaveDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
  },
  "importSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const sourceDir = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      if (!projectDir || !sourceDir) {
        throw new Error("projectDir and sourceDir are required");
      }
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const name = validateSkillName(path.basename(sourceDir));
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await cp(sourceDir, destination, { recursive: true });
      return execResult(true, `Imported skill to ${destination}`);
  },
  "installSkillTemplate": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const content = String(args[2] ?? "");
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), content, "utf8");
      return execResult(true, `Installed skill to ${destination}`);
  },
  "listLocalSkills": async (event, ...args) => {
      return listLocalSkills(String(args[0] ?? "").trim());
  },
  "readLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
  },
  "writeLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(true, `Saved skill ${path.basename(path.dirname(skillPath))}`);
  },
  "uninstallSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found in .opencode/skills or .claude/skills");
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
  },
  "updaterEnvironment": async (event, ...args) => {
      const executablePath = app.isPackaged ? app.getPath("exe") : process.execPath;
      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath:
          process.platform === "darwin"
            ? path.resolve(executablePath, "../../..")
            : path.dirname(executablePath),
      };
  },
  "readOpencodeConfig": async (event, ...args) => {
      return readOpencodeConfig(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "writeOpencodeConfig": async (event, ...args) => {
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
  },
  "resetOpenworkState": async (event, ...args) => {
      await revokeDesktopApprovalGrantsBeforeRuntimeChange();
      return workspaceStore.resetOpenworkState();
  },
  "resetOpencodeCache": async (event, ...args) => {
      return { removed: [], missing: [], errors: [] };
  },
  "opencodeMcpAuth": async (event, ...args) => {
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "setWindowDecorations": async (event, ...args) => {
      return undefined;
  },
  "__openPath": async (event, ...args) => {
      const target = await authorizeDesktopLocalFile(args[0]);
      return shell.openPath(target);
  },
  "__revealItemInDir": async (event, ...args) => {
      const target = await authorizeDesktopLocalFile(args[0], {
        allowMissing: true,
      });
      if (existsSync(target)) {
        shell.showItemInFolder(target);
        return undefined;
      }
      // The exact file may not exist yet (or path is slightly off); fall back to
      // opening the containing directory so the user still lands in the right place.
      const parent = path.dirname(target);
      if (parent && parent !== target && existsSync(parent)) {
        const error = await shell.openPath(parent);
        return error && error.trim() ? error : undefined;
      }
      return `Could not find "${target}" on disk.`;
  },
  "__getFileIcon": async (event, ...args) => {
      const target = await authorizeDesktopLocalFile(args[0]);
      const requestedSize = args[1];
      /** @type {"small" | "normal" | "large"} */
      let validSize = "normal";
      if (requestedSize === "small" || requestedSize === "normal" || requestedSize === "large") {
        validSize = requestedSize;
      }
      try {
        const image = await app.getFileIcon(target, { size: validSize });
        return image.isEmpty() ? null : image.toDataURL();
      } catch {
        return null;
      }
  },
  "__applyBrandAppName": async (event, ...args) => {
    if (!PRODUCT_PROFILE.features.dynamicOrgBranding) {
      return { ok: true, appName: APP_NAME };
    }
    currentDisplayAppName = applyBrandAppName(args[0], {
      fallbackName: APP_NAME,
      platform: process.platform,
      updateElectronAppName: process.platform === "darwin",
      runtimeProcess: process,
      app,
      applicationMenu,
      window: mainWindow,
    });
    if (process.platform === "win32") {
      await registerWindowsDisplayShortcut();
    }
    return { ok: true, appName: currentDisplayAppName };
  },
  "__applyBrandIcon": async (event, ...args) => {
      if (
        !PRODUCT_PROFILE.features.dynamicOrgBranding ||
        !PRODUCT_PROFILE.features.remoteAssetFetches
      ) {
        return { ok: false, reason: "feature_disabled" };
      }
      const value = args[0] === null ? null : String(args[0] ?? "");
      return applyBrandIconUrl(value);
  },
  "__getBrandIconState": async (event, ...args) => {
      return getBrandIconState();
  },
  "__getApplicationsForFile": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return [];
      const platform = process.platform;
      const results = [];

      try {
        if (platform === "darwin") {
          // Scan /Applications and /System/Applications for .app bundles
          const appDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${os.homedir()}/Applications`];
          const seen = new Set();
          for (const dir of appDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".app")) continue;
              const appPath = path.join(dir, entry);
              if (seen.has(appPath)) continue;
              seen.add(appPath);
              const name = entry.replace(/\.app$/i, "");
              let icon = null;
              try {
                const img = await app.getFileIcon(appPath, { size: "small" });
                icon = img.isEmpty() ? null : img.toDataURL();
              } catch {}
              results.push({ name, appPath, icon });
            }
          }
        } else if (platform === "linux") {
          // Parse .desktop files in standard directories
          const desktopDirs = ["/usr/share/applications", "/usr/local/share/applications", `${os.homedir()}/.local/share/applications`];
          const seen = new Set();
          for (const dir of desktopDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".desktop")) continue;
              const filePath = path.join(dir, entry);
              if (seen.has(filePath)) continue;
              seen.add(filePath);
              try {
                const content = await readFile(filePath, "utf-8");
                const nameMatch = content.match(/^Name=(.+)$/m);
                const execMatch = content.match(/^Exec=(.+)$/m);
                if (!nameMatch || !execMatch) continue;
                const name = nameMatch[1].trim();
                const appPath = execMatch[1].trim().replace(/%[fFuU]/g, "").trim();
                if (!appPath) continue;
                let icon = null;
                try {
                  const img = await app.getFileIcon(filePath, { size: "small" });
                  icon = img.isEmpty() ? null : img.toDataURL();
                } catch {}
                results.push({ name, appPath, icon });
              } catch {}
            }
          }
        }
      } catch {}

      return results;
  },
  "__openWithApp": async (event, ...args) => {
      const target = await authorizeDesktopLocalFile(args[0]);
      const appPath = String(args[1] ?? "").trim();
      if (!appPath) return "Target and app path are required.";
      const platform = process.platform;
      try {
        if (platform === "darwin") {
          execFileSync("open", ["-a", appPath, target]);
        } else if (platform === "linux") {
          const child = spawn(appPath, [target], { detached: true, stdio: "ignore" });
          child.unref();
        } else {
          return `Open with app is not supported on ${platform}`;
        }
      } catch (err) {
        return String(err?.message ?? err);
      }
  },
  "__fetch": async (event, ...args) => {
      const init = args[1] ?? {};
      const runtimeInfo = init.desktopApprovalCredential === undefined
        ? null
        : await runtimeManager.openworkServerInfo();
      const prepared = prepareDesktopFetchRequest({
        url: args[0],
        init,
        event,
        mainWindow,
        trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
        runtimeInfo,
      });
      /** @type {RequestInit} */
      const requestInit = {
        ...prepared.requestInit,
        cache: "no-store",
      };
      if (init.agentContextDiagnostics && typeof init.agentContextDiagnostics === "object") {
        return fetchAgentContextDiagnosticsResponse(
          electronNet.fetch,
          prepared.url,
          requestInit,
          init.agentContextDiagnostics.deadlineAtMs,
        );
      }
      const timeoutMs = Number(init.timeoutMs);
      const response = await electronNet.fetch(prepared.url, {
        ...requestInit,
        signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: await response.text(),
      };
  },
  "__homeDir": async (event, ...args) => {
      return os.homedir();
  },
  "__joinPath": async (event, ...args) => {
      return path.join(...args.map((value) => String(value ?? "")));
  },
  "__setZoomFactor": async (event, ...args) => {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
  },
  "__setNativeTheme": async (event, ...args) => {
      return applyNativeTheme(String(args[0]));
  },
  "__setApplicationMenuVisible": async (event, ...args) => {
      return applicationMenu.setVisible(args[0]);
  },
};

if (isDevMode) {
  desktopCommandHandlers.__evalRelaunch = async () => {
    // Chromium persists localStorage/leveldb lazily; force a flush so the
    // relaunched instance sees the same renderer storage (otherwise the app
    // can come back signed out and eval flows misread that as a regression).
    try {
      mainWindow?.webContents.session.flushStorageData();
      session.defaultSession.flushStorageData();
    } catch {
      // Best effort — never block the relaunch on a flush failure.
    }
    setTimeout(() => {
      app.relaunch();
      // Graceful quit (not app.exit) so before-quit teardown runs and managed
      // sidecars are stopped — a hard exit orphans them and they can hold
      // ports (e.g. the CDP debug port) the relaunched instance needs.
      app.quit();
    }, 150);
    return { ok: true };
  };
}

function desktopErrorMessageSegment(error, includeName = false) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      const message = typeof error.message === "string" ? error.message.trim() : "";
      if (message) {
        const name = typeof error.name === "string" ? error.name.trim() : "";
        return includeName && name && name !== "Error" && !message.startsWith(`${name}:`)
          ? `${name}: ${message}`
          : message;
      }
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function desktopErrorCause(error) {
  try {
    return error && (typeof error === "object" || typeof error === "function") ? error.cause : undefined;
  } catch {
    return undefined;
  }
}

function desktopErrorMessageWithCauses(error) {
  try {
    const messages = [];
    const seenMessages = new Set();
    const seenErrors = new Set();
    let current = error;
    for (let depth = 0; current != null && depth < 8; depth += 1) {
      if (typeof current === "object" || typeof current === "function") {
        if (seenErrors.has(current)) break;
        seenErrors.add(current);
      }
      const message = desktopErrorMessageSegment(current, depth === 0).trim();
      if (message && !seenMessages.has(message)) {
        seenMessages.add(message);
        messages.push(message);
      }
      current = desktopErrorCause(current);
    }
    const combined = messages.join(": ") || "Unknown desktop command error";
    return combined.length > 2000 ? `${combined.slice(0, 1997)}...` : combined;
  } catch {
    return "Unknown desktop command error";
  }
}

async function handleDesktopInvoke(event, command, ...args) {
  authorizeMainIpcSender(event);
  const handler = desktopCommandHandlers[command];
  if (!handler) {
    throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
  try {
    return await handler(event, ...args);
  } catch (error) {
    throw new Error(desktopErrorMessageWithCauses(error), { cause: error });
  }
}


async function createMainWindow() {
  if (mainWindow) return mainWindow;
  ensureInternalRendererProtocol();

  const preloadPath = path.join(__dirname, "preload.cjs");
  const windowAppearanceOptions = {};
  if (process.platform === "darwin") {
    Object.assign(windowAppearanceOptions, {
      backgroundColor: "#00000001",
      titleBarStyle: "hiddenInset",
      vibrancy: macosVibrancyForCurrentTheme(),
      visualEffectState: "active",
    });
  }

  const bootSidecar = await readBrandIconSidecar();
  const bootSourceUrl = typeof bootSidecar?.sourceUrl === "string" ? bootSidecar.sourceUrl : null;
  const cachedBrandImage = bootSourceUrl ? resolveBrandIconImage() : null;
  const windowIconImage = cachedBrandImage ?? APP_ICON_IMAGE;
  if (process.platform === "win32" && cachedBrandImage && bootSourceUrl) {
    try {
      const taskbarIconPath = await ensureWindowsBrandIcon(cachedBrandImage);
      const taskbarAppId = windowsBrandAppUserModelId(APP_IDENTIFIER, bootSourceUrl);
      await registerWindowsBrandShortcut(taskbarAppId, taskbarIconPath);
      app.setAppUserModelId(taskbarAppId);
    } catch (error) {
      console.warn("[brand-icon] failed to register cached Windows shortcut before window creation", error);
    }
  }
  if (process.platform === "darwin" && windowIconImage && !windowIconImage.isEmpty() && app.dock) {
    app.dock.setIcon(windowIconImage);
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: currentDisplayAppName,
    show: false,
    ...(process.platform === "win32" ? { skipTaskbar: true } : {}),
    ...windowAppearanceOptions,
    ...(windowIconImage && !windowIconImage.isEmpty() ? { icon: windowIconImage } : {}),
    webPreferences: {
      // The renderer owns session dispatch + event streams; keep it running
      // while hidden/minimized so background tasks are not interrupted.
      backgroundThrottling: false,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      // Enable Chromium's built-in PDF viewer so PDFs render inside the
      // artifact panel (<embed> pointed at a blob URL).
      plugins: true,
    },
  });
  const mainWindowWebContents = mainWindow.webContents;
  const mainWindowWebContentsId = mainWindowWebContents.id;
  if (cachedBrandImage && bootSourceUrl) {
    await applyCachedBrandIcon(cachedBrandImage, bootSourceUrl);
  }
  applicationMenu.applyVisibility(mainWindow);

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(currentDisplayAppName);
  });
  mainWindow.setTitle(currentDisplayAppName);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setTitle(currentDisplayAppName);
    if (process.platform === "win32") mainWindow?.setSkipTaskbar(false);
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  mainWindow.on("closed", () => {
    revokeDesktopApprovalGrantsForWebContents(mainWindowWebContentsId);
    browserPanel.destroy();
    mainWindow = null;
  });
  mainWindowWebContents.on("render-process-gone", () => {
    revokeDesktopApprovalGrantsForWebContents(mainWindowWebContentsId);
  });
  mainWindowWebContents.once("destroyed", () => {
    revokeDesktopApprovalGrantsForWebContents(mainWindowWebContentsId);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    event.preventDefault();
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  // `will-navigate` does NOT fire for CDP `Page.navigate` (it behaves like
  // loadURL), so agent automation that picks the wrong CDP target — the app
  // window itself is the first page target when no browser tab exists — used
  // to replace the entire workspace UI with the website, with no way back
  // (#2000). Catch those at `did-start-navigation`, cancel the load, and
  // reroute the URL into a built-in browser tab instead.
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      revokeDesktopApprovalGrantsForWebContents(mainWindowWebContentsId);
    }
    if (!isMainFrame || isInPlace) return;
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    try {
      mainWindow?.webContents.stop();
    } catch {
      // best effort — routing below still gives the user a way back
    }
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  const startUrl = app.isPackaged
    ? ""
    : process.env.OPENWORK_ELECTRON_START_URL?.trim() ||
      process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    await mainWindow.loadURL(`${REGISTERED_INTERNAL_RENDERER_ORIGIN}/`);
  }

  return mainWindow;
}

function registerTrustedMainHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    authorizeMainIpcSender(event);
    return handler(event, ...args);
  });
}

ipcMain.on("openwork:desktop-bootstrap-sync", (event) => {
  authorizeMainIpcSender(event);
  event.returnValue = workspaceStore.readDesktopBootstrapConfigSync();
});
ipcMain.handle("openwork:desktop", handleDesktopInvoke);
registerTrustedMainHandle("openwork:shell:openExternal", async (_event, url) => {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, error: "empty url" };
  }
  return openExternalUrl(url.trim());
});
registerTrustedMainHandle("openwork:shell:relaunch", async () => {
  app.relaunch();
  app.quit();
});
registerTrustedMainHandle("openwork:system:architecture", async () => resolveArchitectureInfo());
registerTrustedMainHandle("openwork:system:microphoneStatus", async () => {
  if (!PRODUCT_PROFILE.features.voice) {
    return { platform: process.platform, status: "feature-disabled" };
  }
  if (process.platform !== "darwin") return { platform: process.platform, status: "not-mac" };
  return { platform: process.platform, status: systemPreferences.getMediaAccessStatus("microphone") };
});
registerTrustedMainHandle("openwork:system:askMicrophoneAccess", async () => {
  if (!PRODUCT_PROFILE.features.voice) {
    return {
      platform: process.platform,
      granted: false,
      status: "feature-disabled",
    };
  }
  if (process.platform !== "darwin") return { platform: process.platform, granted: true, status: "not-mac" };
  const before = systemPreferences.getMediaAccessStatus("microphone");
  const granted = await systemPreferences.askForMediaAccess("microphone");
  const after = systemPreferences.getMediaAccessStatus("microphone");
  return { platform: process.platform, before, after, granted };
});

// ── Terminal IPC ────────────────────────────────────────────────────────
registerTrustedMainHandle("openwork:terminal:create", async (event, options = {}) => {
  const cwd = await resolveTerminalCwd(options?.cwd);
  const cols = Number.isFinite(options?.cols) ? Math.max(20, Math.floor(options.cols)) : 80;
  const rows = Number.isFinite(options?.rows) ? Math.max(5, Math.floor(options.rows)) : 24;
  const terminalId = `term_${nextTerminalId++}`;
  const shellPath = defaultTerminalShell();
  const child = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OPENWORK_TERMINAL: "1",
    },
  });

  terminalProcesses.set(terminalId, { process: child, webContentsId: event.sender.id });
  event.sender.once("destroyed", () => killTerminalsForWebContents(event.sender.id));
  child.onData((data) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:data", { terminalId, data });
  });
  child.onExit(({ exitCode, signal }) => {
    terminalProcesses.delete(terminalId);
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:exit", { terminalId, exitCode, signal });
  });

  return { terminalId };
});
registerTrustedMainHandle("openwork:terminal:write", (event, terminalId, data) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || typeof data !== "string") return;
  terminal.process.write(data);
});
registerTrustedMainHandle("openwork:terminal:resize", (event, terminalId, cols, rows) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
  terminal.process.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)));
});
registerTrustedMainHandle("openwork:terminal:kill", (event, terminalId) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal) return;
  killTerminal(String(terminalId));
});

browserPanel.registerIpc(ipcMain, {
  authorizeMainSender: authorizeMainIpcSender,
});

if (PRODUCT_PROFILE.features.legacyOpenWorkImport) {
  registerMigrationIpc({
    app,
    ipcMain,
    enabled: true,
    authorizeSender: authorizeMainIpcSender,
  });
}
let ensureAutoUpdater = async () => null;
if (PRODUCT_PROFILE.features.automaticUpdates) {
  ({ ensureAutoUpdater } = registerUpdaterIpc({
    app,
    ipcMain,
    getMainWindow: () => mainWindow,
    enabled: true,
    authorizeSender: authorizeMainIpcSender,
  }));
}

if (!app.requestSingleInstanceLock()) {
  if (isDevMode && !app.isPackaged) {
    console.error(`[openwork] Another OpenWork dev instance already holds this profile directory:
  ${app.getPath("userData")}
The second process is exiting so its CDP port is released.
Run this worktree with an isolated profile: OPENWORK_DEV_PROFILE=auto pnpm dev
or use: pnpm dev:worktree`);
    app.exit(1);
    setImmediate(() => process.exit(1));
  } else {
    app.quit();
  }
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    if (runtimeDisposeInProgress) return;
    showShutdownScreen();
    void Promise.all([disposeRuntimeBeforeQuit(), uiControlServer.stop()]).finally(() => app.quit());
  });

  app.on("second-instance", async (_event, argv) => {
    const win = await createMainWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    if (PUBLIC_DEEP_LINKS_ENABLED) {
      queueDeepLinks(forwardedDeepLinks(argv));
    }
  });

  if (PUBLIC_DEEP_LINKS_ENABLED) {
    app.on("open-url", async (event, url) => {
      event.preventDefault();
      const win = await createMainWindow();
      if (win.isMinimized()) {
        win.restore();
      }
      win.show();
      win.focus();
      queueDeepLinks([url]);
    });
  }

  app.whenReady().then(async () => {
    ensureInternalRendererProtocol();
    networkAudit?.installElectronSession(session.defaultSession, "default");
    networkAudit?.installElectronSession(
      session.fromPartition(BROWSER_SESSION_PARTITION),
      "browser",
    );
    installMediaPermissionHandlers(session, () => mainWindow, {
      trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
      allowMicrophone: PRODUCT_PROFILE.features.voice,
    });
    if (PRODUCT_PROFILE.features.freshStart) {
      await runPendingNukeCleanup({
        env: process.env,
        homedir: os.homedir(),
        platform: process.platform,
        userDataPath: app.getPath("userData"),
      }).catch((error) => {
        console.warn("[nuke] pending cleanup failed", error);
      });
    }
    if (PRODUCT_PROFILE.features.legacyOpenWorkImport) {
      await workspaceStore.importBundledDesktopBootstrapConfigIfPreferred();
    }
    const bootstrapConfig = await workspaceStore.getDesktopBootstrapConfig();
    const bootstrapBrandAppName = PRODUCT_PROFILE.features.dynamicOrgBranding
      ? bootstrapConfig.brandAppName
      : null;
    currentDisplayAppName = applyBrandAppName(bootstrapBrandAppName, {
      fallbackName: APP_NAME,
      platform: process.platform,
      updateElectronAppName: true,
      runtimeProcess: process,
      app,
      applicationMenu,
    });
    if (process.platform === "win32") {
      await registerWindowsDisplayShortcut();
    }
    if (
      PRODUCT_PROFILE.features.dynamicOrgBranding &&
      PRODUCT_PROFILE.features.remoteAssetFetches &&
      process.platform !== "linux"
    ) {
      await applyDesktopBootstrapBrandIcon(bootstrapConfig, applyBrandIconUrl);
    }
    applicationMenu.install();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    if (PRODUCT_PROFILE.features.legacyOpenWorkImport) {
      await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();
    }
    await uiControlServer.start().catch((error) => {
      console.warn("[ui-control] failed to start", error);
    });
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    if (PUBLIC_DEEP_LINKS_ENABLED) {
      queueDeepLinks(forwardedDeepLinks(process.argv));
    }
    const win = await createMainWindow();
    if (
      PRODUCT_PROFILE.features.dynamicOrgBranding &&
      PRODUCT_PROFILE.features.remoteAssetFetches &&
      process.platform === "linux"
    ) {
      await applyDesktopBootstrapBrandIcon(bootstrapConfig, applyBrandIconUrl);
    }
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });

    // Initialize the packaged updater after the window is up so the user sees
    // a working app first. Renderer-owned checks pass the selected release
    // channel explicitly, avoiding stale stable-feed results for alpha users.
    if (PRODUCT_PROFILE.features.automaticUpdates) {
      void ensureAutoUpdater();
    }
  }).catch((error) => {
    console.error("[agencyai:fatal] Desktop startup failed", error);
    app.exit(1);
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      return;
    }
    const win = await createMainWindow();
    win.show();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
