import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { resolveStorageLayout, type StorageLayout } from "../../apps/desktop/electron/storage-layout.mjs";
import {
  LOCAL_CONTROL_ACTION_IDS,
  LOCAL_DISABLED_SETTINGS_TABS,
  LOCAL_SETTINGS_TABS,
  projectLocalWorkspaces,
} from "../../apps/app/src/react-app/shell/local-renderer-policy.ts";
import { listTargets } from "../runner/cdp.ts";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "agencyai-pr02-local-renderer";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_COMMIT = "d1ebb11381fd62a83b9d695393f640ec3ee589b9";
const EXPECTED_BRANCH =
  process.env.AGENCYAI_PR02_EXPECTED_BRANCH?.trim() || "codex/agencyai-pr02";
const ALLOW_DIRTY_WORKTREE =
  process.env.AGENCYAI_PR02_ALLOW_DIRTY_WORKTREE === "1";
const MESSAGE = "Reply with exactly: local-renderer ok";
const REPLY = "local-renderer ok";
const PROVIDER_ID = "agencyai-local-renderer";
const PROVIDER_NAME = "AgencyAI Local Renderer Mock";
const MODEL_ID = "agencyai-local-renderer";
const WORKSPACE_NAME = "AgencyAI Local Workspace";
const REMOTE_WORKSPACE_ID = "remote-stale-renderer";
const REMOTE_WORKSPACE_NAME = "Stale Remote Worker";
const CLOUD_NOTIFICATION_TITLE = "Stale cloud notification";
const REMOTE_ICON_PATH = "/assets/stale-remote-icon.svg";
const PANEL_STORAGE_KEY = "openwork:panel-tabs:v1";
const NOTIFICATION_STORAGE_KEY = "openwork:notifications:v1";
const PROVIDER_PORT = Number(
  process.env.AGENCYAI_PR02_PROVIDER_PORT?.trim() || "18178",
);

if (!Number.isInteger(PROVIDER_PORT) || PROVIDER_PORT < 1 || PROVIDER_PORT > 65_535) {
  throw new Error("AGENCYAI_PR02_PROVIDER_PORT must be a valid TCP port");
}

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

interface FixtureManifest {
  schemaVersion: number;
  root: string;
  home: string;
  appData: string;
  workspace: string;
  storageRoot: string;
  manifestPath: string;
}

interface RequestRecord {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
  promptMentioned: boolean;
}

interface FlowState {
  fixture: FixtureManifest | null;
  layout: StorageLayout | null;
  trapServer: Server | null;
  trapHost: string;
  trapPort: number;
  trapRequests: Array<{ method: string; path: string }>;
  providerServer: Server | null;
  providerPort: number;
  providerRequests: RequestRecord[];
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  welcomeActions: string[];
  sessionActions: string[];
  notificationList: unknown;
}

const state: FlowState = {
  fixture: null,
  layout: null,
  trapServer: null,
  trapHost: "",
  trapPort: 0,
  trapRequests: [],
  providerServer: null,
  providerPort: 0,
  providerRequests: [],
  workspaceId: "",
  workspacePath: "",
  sessionId: "",
  welcomeActions: [],
  sessionActions: [],
  notificationList: null,
};

function run(
  command: string,
  args: string[],
  cwd: string = ROOT,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return [result.stdout, result.stderr, result.error?.message]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .join("\n");
}

function isForbiddenActionId(id: string): boolean {
  return /(^|[._-])(auth|cloud|connect|grant|memory|onboarding|remote|share|voice)([._-]|$)/i.test(
    id,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function witness(
  ctx: FlowContext,
  condition: unknown,
  assertion: string,
  actual?: unknown,
): void {
  if (!condition) {
    ctx.recordEvidence({
      type: "assertion",
      status: "failed",
      assertion,
      actual,
    });
    ctx.assert(
      false,
      `${assertion}${actual === undefined ? "" : ` (actual: ${stable(actual)})`}`,
    );
  }
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion,
    actual,
  });
}

async function readFixture(): Promise<FixtureManifest> {
  const root = process.env.AGENCYAI_PR02_FIXTURE_ROOT?.trim();
  if (!root) throw new Error("AGENCYAI_PR02_FIXTURE_ROOT is required");
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as FixtureManifest;
  if (
    manifest.schemaVersion !== 1
    || manifest.root !== root
    || !manifest.home
    || !manifest.appData
    || !manifest.workspace
    || !manifest.storageRoot
  ) {
    throw new Error("invalid AgencyAI PR02 renderer fixture");
  }
  return manifest;
}

async function invokeDesktop(
  ctx: FlowContext,
  command: string,
  ...args: unknown[]
): Promise<unknown> {
  return ctx.eval(
    `window.__OPENWORK_ELECTRON__.invokeDesktop(
      ${JSON.stringify(command)},
      ...${JSON.stringify(args)}
    )`,
    { awaitPromise: true },
  );
}

async function waitForReplacementAppTarget(
  ctx: FlowContext,
  previousTargetIds: ReadonlySet<string>,
  timeoutMs = 120_000,
): Promise<void> {
  if (!ctx.cdpBaseUrl) throw new Error("CDP base URL is required");
  const startedAt = Date.now();
  let endpointWasUnavailable = false;
  let last: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await listTargets(ctx.cdpBaseUrl);
      last = targets;
      const appPages = targets.filter(
        (target) =>
          target.type === "page"
          && Boolean(target.webSocketDebuggerUrl)
          && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(target.url),
      );
      if (
        appPages.some((target) => !previousTargetIds.has(target.id))
        || (endpointWasUnavailable && appPages.length > 0)
      ) {
        return;
      }
    } catch (error) {
      endpointWasUnavailable = true;
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`replacement Electron target did not appear: ${stable(last)}`);
}

async function relaunch(ctx: FlowContext): Promise<void> {
  if (!ctx.cdpBaseUrl) throw new Error("CDP base URL is required");
  const previousTargetIds = new Set(
    (await listTargets(ctx.cdpBaseUrl))
      .filter((target) => target.type === "page")
      .map((target) => target.id),
  );
  try {
    await ctx.control("eval.app.relaunch");
  } catch (error) {
    ctx.log(`Relaunch connection closed during app restart: ${stable(error)}`);
  }
  await waitForReplacementAppTarget(ctx, previousTargetIds);
  await ctx.reconnect({ timeoutMs: 120_000 });
  await ctx.waitFor(
    "Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop && window.__openworkControl)",
    { timeoutMs: 60_000, label: "local renderer after relaunch" },
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_048_576) throw new Error("request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeExactReply(response: ServerResponse): void {
  const id = `chatcmpl-agencyai-pr02-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [{
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [{
        index: 0,
        delta: { content: REPLY },
        finish_reason: null,
      }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: MODEL_ID,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }],
    },
  ];
  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.flushHeaders?.();
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

async function listen(
  server: Server,
  host: string,
  port = 0,
): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });
  server.unref();
  const address = server.address() as AddressInfo | null;
  if (!address?.port) throw new Error(`server did not bind on ${host}`);
  return address.port;
}

async function startTrapServer(): Promise<void> {
  const trapHost =
    Object.values(networkInterfaces())
      .flat()
      .find(
        (entry) =>
          entry?.family === "IPv4"
          && entry.internal === false
          && entry.address,
      )?.address
    || "0.0.0.0";
  const server = createServer((request, response) => {
    state.trapRequests.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
    });
    sendJson(response, 503, { error: "saved host must remain quarantined" });
  });
  state.trapServer = server;
  state.trapHost = trapHost;
  state.trapPort = await listen(server, "0.0.0.0");
}

async function startProviderServer(): Promise<void> {
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }
    if (
      request.method === "GET"
      && (url.pathname === "/v1/models" || url.pathname === "/models")
    ) {
      sendJson(response, 200, {
        object: "list",
        data: [{
          id: MODEL_ID,
          object: "model",
          created: 0,
          owned_by: "agencyai",
        }],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/models/api.json") {
      sendJson(response, 200, {});
      return;
    }
    if (
      request.method === "POST"
      && (
        url.pathname === "/v1/chat/completions"
        || url.pathname === "/chat/completions"
      )
    ) {
      let body: unknown = null;
      try {
        const raw = await readRequestBody(request);
        body = raw ? JSON.parse(raw) : {};
      } catch (error) {
        sendJson(response, 400, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const serialized = JSON.stringify(body);
      state.providerRequests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization ?? "",
        body,
        promptMentioned: serialized.includes(MESSAGE),
      });
      if (request.headers.authorization !== "Bearer sk-agencyai-pr02") {
        sendJson(response, 401, {
          error: { message: "invalid authorization" },
        });
        return;
      }
      writeExactReply(response);
      return;
    }
    sendJson(response, 404, {
      error: "not_found",
      method: request.method,
      path: url.pathname,
    });
  });
  state.providerServer = server;
  state.providerPort = await listen(server, "127.0.0.1", PROVIDER_PORT);
}

function closeServer(server: Server | null): void {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
}

async function resourceAudit(ctx: FlowContext): Promise<{
  resources: string[];
  unexpected: string[];
}> {
  const value = await ctx.eval(`(() => {
    const resources = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => typeof name === "string");
    const unexpected = resources.filter((name) => {
      try {
        const url = new URL(name, location.href);
        if (url.protocol === "data:" || url.protocol === "blob:") return false;
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        const hostname = url.hostname.toLowerCase();
        return hostname !== "localhost"
          && hostname !== "127.0.0.1"
          && hostname !== "::1"
          && hostname !== "[::1]";
      } catch {
        return false;
      }
    });
    return { resources, unexpected };
  })()`);
  return {
    resources: Array.isArray(field(value, "resources"))
      ? field(value, "resources") as string[]
      : [],
    unexpected: Array.isArray(field(value, "unexpected"))
      ? field(value, "unexpected") as string[]
      : [],
  };
}

async function actionIds(ctx: FlowContext): Promise<string[]> {
  const value = await ctx.eval(
    "window.__openworkControl.listActions().map((action) => action.id).sort()",
  );
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function openworkServerInfo(ctx: FlowContext): Promise<Record<string, unknown>> {
  const info = await invokeDesktop(ctx, "openworkServerInfo");
  if (!isRecord(info)) {
    throw new Error(`openworkServerInfo returned ${stable(info)}`);
  }
  return info;
}

async function waitForOpenworkServer(
  ctx: FlowContext,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let last: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const info = await openworkServerInfo(ctx);
      last = info;
      if (
        info.running === true
        && typeof info.baseUrl === "string"
        && (typeof info.ownerToken === "string" || typeof info.clientToken === "string")
      ) {
        return info;
      }
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`local OpenWork server did not become ready: ${stable(last)}`);
}

async function serverRequest(
  ctx: FlowContext,
  requestPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const info = await waitForOpenworkServer(ctx);
  const baseUrl = text(info.baseUrl)?.replace(/\/+$/, "") ?? "";
  const token =
    text(info.ownerToken)?.trim()
    || text(info.clientToken)?.trim()
    || "";
  const hostToken = text(info.hostToken)?.trim() ?? "";
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(hostToken ? { "x-openwork-host-token": hostToken } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const responseText = await response.text();
  let payload: unknown = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = responseText;
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${requestPath} failed: ${response.status} ${responseText.slice(0, 500)}`,
    );
  }
  return payload;
}

async function approvedConfigPatch(
  ctx: FlowContext,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const result = await ctx.eval(`(async () => {
    const desktop = window.__OPENWORK_ELECTRON__;
    if (!desktop?.invokeDesktop) {
      throw new Error("Electron desktop bridge is unavailable");
    }
    const info = await desktop.invokeDesktop("openworkServerInfo");
    const baseUrl = typeof info?.baseUrl === "string"
      ? info.baseUrl.replace(/\\/+$/, "")
      : "";
    const token =
      (typeof info?.ownerToken === "string" && info.ownerToken.trim())
      || (typeof info?.clientToken === "string" && info.clientToken.trim())
      || "";
    const hostToken =
      typeof info?.hostToken === "string" ? info.hostToken.trim() : "";
    if (!baseUrl || !token) {
      throw new Error("Local OpenWork server is unavailable");
    }

    const grant = await desktop.invokeDesktop("desktopApprovalGrant", {
      workspaceId: ${JSON.stringify(workspaceId)},
      operation: "config.patch",
    });
    const response = await desktop.invokeDesktop(
      "__fetch",
      \`\${baseUrl}/workspace/${encodeURIComponent(workspaceId)}/config\`,
      {
        method: "PATCH",
        headers: {
          authorization: \`Bearer \${token}\`,
          "content-type": "application/json",
          ...(hostToken ? { "x-openwork-host-token": hostToken } : {}),
        },
        body: JSON.stringify(${JSON.stringify(body)}),
        desktopApprovalCredential: grant.credential,
        timeoutMs: 60_000,
      },
    );
    let payload = null;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch {
      payload = response.body;
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      payload,
    };
  })()`, { awaitPromise: true });

  if (field(result, "ok") !== true) {
    throw new Error(
      `Approved PATCH /workspace/${workspaceId}/config failed: ${stable(result)}`,
    );
  }
  return field(result, "payload");
}

async function configureLocalProvider(ctx: FlowContext): Promise<void> {
  const baseURL = `http://127.0.0.1:${state.providerPort}/v1`;
  await approvedConfigPatch(
    ctx,
    state.workspaceId,
    {
      opencode: {
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: PROVIDER_NAME,
            options: {
              baseURL,
              apiKey: "sk-agencyai-pr02",
            },
            models: {
              [MODEL_ID]: {
                name: PROVIDER_NAME,
              },
            },
          },
        },
      },
    },
  );
  await serverRequest(
    ctx,
    `/workspace/${encodeURIComponent(state.workspaceId)}/engine/reload`,
    { method: "POST" },
  );
  await ctx.eval(`(() => {
    let prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}");
    } catch {
      prefs = {};
    }
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...prefs,
      hasCompletedOnboarding: true,
      analyticsEnabled: false,
      defaultModel: {
        providerID: ${JSON.stringify(PROVIDER_ID)},
        modelID: ${JSON.stringify(MODEL_ID)},
      },
      modelVariant: null,
    }));
    localStorage.setItem(
      "openwork.defaultModel",
      ${JSON.stringify(`${PROVIDER_ID}/${MODEL_ID}`)},
    );
    localStorage.removeItem(
      ${JSON.stringify(`openwork.sessionModels.${state.workspaceId}`)},
    );
    window.dispatchEvent(new Event("openwork.defaultModelChanged"));
    return true;
  })()`);

  // This fixture patches the runtime config through the protected server relay
  // instead of the Settings form. The real Settings path invalidates the
  // provider-list query after reloading OpenCode; reload the isolated renderer
  // here so the fixture observes the same fresh provider snapshot.
  await ctx.eval("(() => { location.reload(); return true; })()");
  await ctx.waitFor(
    `location.hash.includes(${JSON.stringify(`/workspace/${state.workspaceId}/session`)})
      && Boolean(window.__openworkControl)`,
    { timeoutMs: 60_000, label: "AgencyAI PR02 provider refresh" },
  );
}

async function ensureLocalModelSelected(ctx: FlowContext): Promise<void> {
  const selected = await ctx.eval(`(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
    const action = window.__openworkControl
      ?.listActions?.()
      .find((candidate) => candidate.id === "session.create_task");
    return {
      model: (button?.textContent || "").trim(),
      ready: Boolean(action && !action.disabled),
    };
  })()`);
  if (
    field(selected, "ready") === true
    && text(field(selected, "model"))?.includes(PROVIDER_NAME)
  ) {
    return;
  }

  await ctx.eval(`(() => {
    const openButton = Array.from(document.querySelectorAll("button"))
      .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
    if (openButton && openButton.getAttribute("aria-expanded") !== "true") {
      openButton.click();
    }
    return Boolean(openButton);
  })()`);
  await ctx.waitFor(
    `(() => Array.from(document.querySelectorAll("button"))
      .some((candidate) => {
        const label = candidate.textContent || "";
        return label.includes(${JSON.stringify(PROVIDER_NAME)})
          || label.includes(${JSON.stringify(MODEL_ID)});
      }))()`,
    { timeoutMs: 30_000, label: "AgencyAI PR02 local model option" },
  );
  const selectedModel = await ctx.eval(`(() => {
    const exactModel = Array.from(document.querySelectorAll("button"))
      .find((candidate) =>
        (candidate.textContent || "").includes(${JSON.stringify(MODEL_ID)})
      );
    if (exactModel) {
      exactModel.click();
      return "model";
    }
    const provider = Array.from(document.querySelectorAll("button"))
      .find((candidate) =>
        (candidate.textContent || "").includes(${JSON.stringify(PROVIDER_NAME)})
      );
    if (!provider) return "missing";
    provider.click();
    return "provider";
  })()`);
  witness(
    ctx,
    selectedModel === "model" || selectedModel === "provider",
    "The user-owned local model was selected",
    selectedModel,
  );
  await ctx.waitFor(
    `(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.getAttribute("aria-label") === "Change model");
      return (button?.textContent || "").includes(${JSON.stringify(PROVIDER_NAME)});
    })()`,
    { timeoutMs: 30_000, label: "AgencyAI PR02 local model selected" },
  );
}

async function pasteComposer(ctx: FlowContext, value: string): Promise<unknown> {
  return ctx.eval(`(() => {
    const editor =
      document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "composer not found" };
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(value)});
    editor.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    return { ok: true, text: editor.innerText };
  })()`);
}

async function navigateAndWait(
  ctx: FlowContext,
  path: string,
  expectedFragment: string,
): Promise<void> {
  await ctx.navigateHash(path);
  await ctx.waitFor(
    `location.hash.includes(${JSON.stringify(expectedFragment)})`,
    { timeoutMs: 30_000, label: `${path} -> ${expectedFragment}` },
  );
}

export default defineFlow({
  id: FLOW_ID,
  title: "AgencyAI local renderer quarantines cloud state and preserves the local task path",
  kind: "internal",
  requiresApp: true,
  requiredEnv: ["AGENCYAI_PR02_FIXTURE_ROOT"],
  precondition: async (ctx) => {
    state.fixture = await readFixture();
    state.layout = resolveStorageLayout({
      appDataPath: state.fixture.appData,
      appIdentifier: "com.artreimus.agencyai.dev",
      storageRootOverride: state.fixture.storageRoot,
    });
    await Promise.all([startTrapServer(), startProviderServer()]);
    await ctx.waitFor(
      "Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop && window.__openworkControl)",
      { timeoutMs: 60_000, label: "AgencyAI local renderer control surface" },
    );
    await ctx.waitForText("Your desktop agent, on your machine", {
      timeoutMs: 60_000,
    });
    return null;
  },
  steps: [
    {
      name: "Fresh AgencyAI launch uses the local welcome composition",
      run: async (ctx) => {
        await ctx.prove("The fresh desktop starts on the AgencyAI local welcome surface with no cloud gate or external resource", {
          voiceover: vo[0],
          action: async () => {
            await ctx.eval(
              "performance.setResourceTimingBufferSize?.(2000); true",
            );
          },
          assert: async () => {
            const buildInfo = await invokeDesktop(ctx, "appBuildInfo");
            const profile = field(buildInfo, "productProfile");
            const features = field(profile, "features");
            const audit = await resourceAudit(ctx);
            witness(ctx, field(profile, "profile") === "local-mvp", "The live renderer profile is local-mvp", field(profile, "profile"));
            witness(ctx, field(field(profile, "brand"), "name") === "AgencyAI", "The live renderer brand is AgencyAI", field(field(profile, "brand"), "name"));
            witness(ctx, field(features, "openworkCloud") === false, "OpenWork Cloud is disabled in the compiled profile", features);
            witness(ctx, field(features, "cloudBootstrap") === false && field(features, "connectLinks") === false, "Cloud bootstrap and authentication handoff surfaces are disabled", features);
            witness(ctx, field(features, "runtimeDownloads") === false, "Runtime downloads and updater prompts are disabled", features);
            witness(ctx, field(features, "dynamicOrgBranding") === false && field(features, "remoteAssetFetches") === false, "Remote branding and assets are disabled", features);
            witness(ctx, audit.unexpected.length === 0, "Fresh renderer resources use no unexpected non-loopback host", audit);
            await ctx.expectNoText("Sign in");
            await ctx.expectNoText("OpenWork Models");
            await ctx.expectNoText("Organization");
            ctx.output("Fresh local renderer request audit", JSON.stringify(audit, null, 2));
          },
          screenshot: {
            name: "fresh-local-welcome",
            requireText: [
              "AgencyAI",
              "Your desktop agent, on your machine",
              "Choose a local workspace",
            ],
            rejectText: ["Sign in", "OpenWork Models", "Organization"],
          },
        });
      },
    },
    {
      name: "Saved cloud and remote state stays preserved but inert",
      run: async (ctx) => {
        await ctx.prove("A real relaunch preserves hostile saved state while the local renderer quarantines every cloud, remote, notification, and icon surface", {
          voiceover: vo[1],
          action: async () => {
            const layout = state.layout;
            witness(ctx, layout !== null, "The AgencyAI storage layout is available");
            if (!layout) return;
            const trapUrl = `http://${state.trapHost}:${state.trapPort}`;
            const remoteIcon = `${trapUrl}${REMOTE_ICON_PATH}`;
            const now = Date.now();

            await invokeDesktop(ctx, "setDesktopBootstrapConfig", {
              baseUrl: trapUrl,
              apiBaseUrl: `${trapUrl}/api/den`,
              requireSignin: true,
              brandAppName: "Stale Remote Brand",
              brandLogoUrl: remoteIcon,
              brandIconUrl: remoteIcon,
            });
            await writeFile(
              join(layout.userData, "openwork-workspaces.json"),
              `${JSON.stringify({
                selectedId: "",
                selectedWorkspaceId: "",
                watchedId: null,
                watchedWorkspaceId: "",
                activeId: null,
                workspaces: [{
                  id: REMOTE_WORKSPACE_ID,
                  name: REMOTE_WORKSPACE_NAME,
                  displayName: REMOTE_WORKSPACE_NAME,
                  path: "",
                  workspaceType: "remote",
                  remoteType: "opencode",
                  baseUrl: trapUrl,
                  favicon: remoteIcon,
                }],
              }, null, 2)}\n`,
              "utf8",
            );
            await ctx.eval(`(() => {
              const trapUrl = ${JSON.stringify(trapUrl)};
              const remoteIcon = ${JSON.stringify(remoteIcon)};
              localStorage.setItem("openwork.den.baseUrl", trapUrl);
              localStorage.setItem("openwork.den.apiBaseUrl", trapUrl + "/api/den");
              localStorage.setItem("openwork.den.authToken", "stale-cloud-token");
              localStorage.setItem("openwork.den.activeOrgId", "stale-org");
              localStorage.setItem("openwork.den.activeOrgSlug", "stale-org");
              localStorage.setItem("openwork.den.activeOrgName", "Stale Organization");
              localStorage.setItem("openwork.server.urlOverride", trapUrl);
              localStorage.setItem("openwork.server.token", "stale-server-token");
              localStorage.setItem("openwork.server.hostToken", "stale-host-token");
              localStorage.setItem("openwork.server.remoteAccessEnabled", "true");
              localStorage.setItem(
                ${JSON.stringify(NOTIFICATION_STORAGE_KEY)},
                JSON.stringify({
                  state: {
                    notifications: [{
                      id: "stale-cloud-notification",
                      kind: "cloud",
                      severity: "info",
                      title: ${JSON.stringify(CLOUD_NOTIFICATION_TITLE)},
                      body: "This entry must stay inert.",
                      count: 1,
                      createdAt: ${now},
                      updatedAt: ${now},
                      readAt: null,
                    }, {
                      id: "stale-marketplace-notification",
                      kind: "system",
                      severity: "info",
                      title: "Stale marketplace notification",
                      count: 1,
                      createdAt: ${now},
                      updatedAt: ${now},
                      readAt: null,
                      action: {
                        type: "install-marketplace-plugin",
                        pluginName: "stale-cloud-plugin",
                      },
                    }],
                  },
                  version: 0,
                }),
              );
              localStorage.setItem(
                ${JSON.stringify(PANEL_STORAGE_KEY)},
                JSON.stringify({
                  state: {
                    sessions: {
                      stale: {
                        tabs: [{
                          id: "stale-browser-tab",
                          type: "browser",
                          label: "Stale remote icon",
                          url: "",
                          favicon: remoteIcon,
                        }],
                        activeTabId: "stale-browser-tab",
                      },
                    },
                  },
                  version: 0,
                }),
              );
              return true;
            })()`);
            await relaunch(ctx);
          },
          assert: async () => {
            await ctx.waitForText("Your desktop agent, on your machine", {
              timeoutMs: 60_000,
            });
            const rawWorkspaceState = await invokeDesktop(ctx, "workspaceBootstrap");
            const rawWorkspaces = Array.isArray(field(rawWorkspaceState, "workspaces"))
              ? field(rawWorkspaceState, "workspaces") as Array<Record<string, unknown>>
              : [];
            const projected = projectLocalWorkspaces(rawWorkspaces);
            const savedState = await ctx.eval(`(() => ({
              denToken: localStorage.getItem("openwork.den.authToken"),
              org: localStorage.getItem("openwork.den.activeOrgName"),
              server: localStorage.getItem("openwork.server.urlOverride"),
              remoteAccess: localStorage.getItem("openwork.server.remoteAccessEnabled"),
              notifications: localStorage.getItem(${JSON.stringify(NOTIFICATION_STORAGE_KEY)}),
              panels: localStorage.getItem(${JSON.stringify(PANEL_STORAGE_KEY)}),
            }))()`);
            const audit = await resourceAudit(ctx);
            state.welcomeActions = await actionIds(ctx);

            witness(ctx, rawWorkspaces.some((workspace) => workspace.id === REMOTE_WORKSPACE_ID), "The raw remote workspace remains saved for reversibility", rawWorkspaceState);
            witness(ctx, projected.length === 0, "The renderer projects no remote workspace into the local product", projected);
            witness(ctx, stable(savedState).includes("stale-cloud-token"), "The raw saved cloud credential remains reversible", savedState);
            witness(ctx, stable(savedState).includes(CLOUD_NOTIFICATION_TITLE), "The raw cloud notification remains saved", savedState);
            witness(ctx, stable(savedState).includes(REMOTE_ICON_PATH), "The raw remote icon URL remains saved", savedState);
            witness(ctx, state.trapRequests.length === 0, "The saved non-loopback host received zero requests", state.trapRequests);
            witness(ctx, audit.unexpected.length === 0, "The relaunched renderer requested no unexpected non-loopback host", audit);
            witness(ctx, !state.welcomeActions.some(isForbiddenActionId), "No disabled cloud or remote action registered on the welcome route", state.welcomeActions);
            await ctx.expectNoText(REMOTE_WORKSPACE_NAME);
            await ctx.expectNoText(CLOUD_NOTIFICATION_TITLE);
            await navigateAndWait(ctx, "/settings/cloud-account", "/settings/general");
            await ctx.waitForText("AI Providers", { timeoutMs: 60_000 });
            ctx.output("Quarantined saved-state proof", JSON.stringify({
              rawWorkspaceState,
              projectedWorkspaces: projected,
              welcomeActions: state.welcomeActions,
              trapRequests: state.trapRequests,
              resourceAudit: audit,
              rawStorageKeysPresent: {
                denToken: Boolean(field(savedState, "denToken")),
                organization: Boolean(field(savedState, "org")),
                server: Boolean(field(savedState, "server")),
                notifications: Boolean(field(savedState, "notifications")),
                panels: Boolean(field(savedState, "panels")),
              },
            }, null, 2));
          },
          screenshot: {
            name: "stale-state-quarantined",
            requireText: [
              "AgencyAI",
              "General",
              "AI Providers",
              "Extensions",
            ],
            rejectText: [
              REMOTE_WORKSPACE_NAME,
              CLOUD_NOTIFICATION_TITLE,
              "Sign in",
              "OpenWork Models",
            ],
          },
        });
      },
    },
    {
      name: "The first workspace is local-only",
      run: async (ctx) => {
        await ctx.prove("The renderer creates and opens only the chosen local folder while the raw remote record remains quarantined", {
          voiceover: vo[2],
          action: async () => {
            const fixture = state.fixture;
            witness(ctx, fixture !== null, "The local renderer fixture is available");
            if (!fixture) return;
            const created = await invokeDesktop(ctx, "workspaceCreate", {
              folderPath: fixture.workspace,
              name: WORKSPACE_NAME,
              preset: "starter",
            });
            const workspaces = Array.isArray(field(created, "workspaces"))
              ? field(created, "workspaces") as Array<Record<string, unknown>>
              : [];
            const selectedId = text(field(created, "selectedId")) ?? "";
            const canonicalWorkspacePath = await realpath(fixture.workspace);
            const localWorkspace = workspaces.find(
              (workspace) =>
                workspace.workspaceType !== "remote"
                && workspace.id === selectedId,
            );
            state.workspaceId = text(localWorkspace?.id) ?? "";
            state.workspacePath =
              text(localWorkspace?.path)
              ?? canonicalWorkspacePath;
            witness(ctx, Boolean(state.workspaceId), "Electron created the selected local workspace", created);
            await invokeDesktop(ctx, "workspaceSetSelected", state.workspaceId);
            await invokeDesktop(ctx, "workspaceSetRuntimeActive", state.workspaceId);
            await invokeDesktop(ctx, "engineStart", state.workspacePath, {
              runtime: "direct",
              workspacePaths: [state.workspacePath],
            });
            await invokeDesktop(ctx, "orchestratorWorkspaceActivate", {
              workspacePath: state.workspacePath,
              name: WORKSPACE_NAME,
            });
            await waitForOpenworkServer(ctx);
            await ctx.eval(`(() => {
              let prefs = {};
              try {
                prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}");
              } catch {
                prefs = {};
              }
              localStorage.setItem("openwork.preferences", JSON.stringify({
                ...prefs,
                hasCompletedOnboarding: true,
                analyticsEnabled: false,
              }));
              localStorage.setItem(
                "openwork.react.activeWorkspace",
                ${JSON.stringify(state.workspaceId)},
              );
              location.hash = ${JSON.stringify(`#/workspace/${state.workspaceId}/session`)};
              location.reload();
              return true;
            })()`);
            await ctx.waitFor(
              `location.hash.includes(${JSON.stringify(`/workspace/${state.workspaceId}/session`)})
                && Boolean(window.__openworkControl)`,
              { timeoutMs: 120_000, label: "first local workspace route" },
            );
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
              { timeoutMs: 120_000, label: "local workspace task action" },
            );
          },
          assert: async () => {
            const rawWorkspaceState = await invokeDesktop(ctx, "workspaceBootstrap");
            const rawWorkspaces = Array.isArray(field(rawWorkspaceState, "workspaces"))
              ? field(rawWorkspaceState, "workspaces") as Array<Record<string, unknown>>
              : [];
            const projected = projectLocalWorkspaces(rawWorkspaces);
            state.sessionActions = await actionIds(ctx);
            state.notificationList = state.sessionActions.includes("notifications.list")
              ? await ctx.control("notifications.list")
              : [];
            witness(ctx, projected.length === 1, "Exactly one local workspace is projected", projected);
            witness(ctx, projected[0]?.id === state.workspaceId, "The projected workspace is the chosen local folder", projected[0]);
            witness(ctx, rawWorkspaces.some((workspace) => workspace.id === REMOTE_WORKSPACE_ID), "The raw remote workspace remains preserved after local creation", rawWorkspaceState);
            witness(ctx, Array.isArray(state.notificationList) && state.notificationList.length === 0, "Cloud and marketplace notifications stay out of the live notification center", state.notificationList);
            witness(ctx, state.sessionActions.includes("workspace.create"), "The local workspace action is available", state.sessionActions);
            witness(ctx, !state.sessionActions.some(isForbiddenActionId), "Remote, sharing, grant, cloud, and voice actions remain absent", state.sessionActions);
            await ctx.expectNoText(REMOTE_WORKSPACE_NAME);
            await ctx.expectNoText("OpenWork Models");
            await ctx.expectNoText("Organization");
            ctx.output("Local-only first workspace", JSON.stringify({
              selectedWorkspaceId: state.workspaceId,
              rawWorkspaces,
              projectedWorkspaces: projected,
              sessionActions: state.sessionActions,
              notifications: state.notificationList,
            }, null, 2));
          },
          screenshot: {
            name: "first-local-workspace",
            requireText: ["AgencyAI", WORKSPACE_NAME],
            rejectText: [
              REMOTE_WORKSPACE_NAME,
              "Remote worker",
              "OpenWork Models",
              "Organization",
            ],
          },
        });
      },
    },
    {
      name: "AI Providers stays on the user-owned local path",
      run: async (ctx) => {
        await ctx.prove("A user-owned OpenAI-compatible provider is configured through the local runtime and appears without cloud-managed alternatives", {
          voiceover: vo[3],
          action: async () => {
            await configureLocalProvider(ctx);
            await navigateAndWait(
              ctx,
              `/workspace/${state.workspaceId}/settings/ai`,
              `/workspace/${state.workspaceId}/settings/ai`,
            );
            await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText("AI Providers");
            await ctx.expectText("User-owned providers");
            await ctx.expectText("Credentials stay in your local OpenCode runtime.");
            await ctx.expectText(PROVIDER_NAME);
            await ctx.expectNoText("OpenWork Models");
            await ctx.expectNoText("Organization providers");
            await ctx.expectNoText("Cloud entitlement");
            witness(ctx, state.trapRequests.length === 0, "Provider setup did not contact the saved non-loopback host", state.trapRequests);
            ctx.output("User-owned local provider", JSON.stringify({
              providerId: PROVIDER_ID,
              modelId: MODEL_ID,
              name: PROVIDER_NAME,
              baseUrl: `http://127.0.0.1:${state.providerPort}/v1`,
              trapRequests: state.trapRequests,
            }, null, 2));
          },
          screenshot: {
            name: "user-owned-local-provider",
            requireText: [
              "AI Providers",
              "User-owned providers",
              PROVIDER_NAME,
            ],
            rejectText: [
              "OpenWork Models",
              "Organization providers",
              "Cloud entitlement",
            ],
          },
        });
      },
    },
    {
      name: "The canonical local renderer task replies exactly",
      run: async (ctx) => {
        await ctx.prove("The selected user-owned provider returns the exact canonical response in a fresh AgencyAI task", {
          voiceover: vo[4],
          action: async () => {
            await navigateAndWait(
              ctx,
              `/workspace/${state.workspaceId}/session`,
              `/workspace/${state.workspaceId}/session`,
            );
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
              { timeoutMs: 90_000, label: "local task action after provider setup" },
            );
            await ensureLocalModelSelected(ctx);
            await ctx.control("session.create_task");
            state.sessionId = String(await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                const match = route.match(/ses_[A-Za-z0-9]+/);
                return match ? match[0] : null;
              })()`,
              { timeoutMs: 30_000, label: "fresh AgencyAI PR02 session" },
            ));
            witness(ctx, state.sessionId.startsWith("ses_"), "A fresh local task became active", state.sessionId);
            const pasted = await pasteComposer(ctx, MESSAGE);
            witness(ctx, field(pasted, "ok") === true, "The canonical local prompt was pasted", pasted);
            const submitted = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button"))
                .find((candidate) =>
                  /run task|send|run/i.test((candidate.textContent || "").trim())
                  && !candidate.disabled
                );
              if (button) {
                button.click();
                return "clicked";
              }
              const editor = document.querySelector('[contenteditable="true"]');
              if (!editor) return "none";
              editor.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                bubbles: true,
              }));
              return "enter";
            })()`);
            witness(ctx, submitted === "clicked" || submitted === "enter", "The canonical local prompt was submitted", submitted);
          },
          assert: async () => {
            await ctx.waitForText(MESSAGE, { timeoutMs: 60_000 });
            await ctx.waitFor(
              `(() => Array
                .from(document.querySelectorAll('[data-message-role="assistant"]'))
                .some((element) =>
                  (element.textContent || "").trim() === ${JSON.stringify(REPLY)}
                ))()`,
              { timeoutMs: 120_000, label: "exact local-renderer assistant reply" },
            );
            await ctx.expectNoText("Something went wrong");
            const canonicalRequests = state.providerRequests.filter(
              (request) => request.promptMentioned,
            );
            witness(ctx, canonicalRequests.length >= 1, "The user-owned provider received the canonical prompt", canonicalRequests);
            witness(ctx, canonicalRequests.every((request) => request.authorization === "Bearer sk-agencyai-pr02"), "Every canonical provider request used only the local fixture credential", canonicalRequests);
            witness(ctx, state.trapRequests.length === 0, "The saved non-loopback host still received zero requests", state.trapRequests);
            ctx.output("Canonical local renderer provider proof", JSON.stringify({
              sessionId: state.sessionId,
              reply: REPLY,
              canonicalRequests,
              allProviderRequests: state.providerRequests,
              trapRequests: state.trapRequests,
            }, null, 2));
          },
          screenshot: {
            name: "canonical-local-renderer-task",
            requireText: [MESSAGE, REPLY],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Settings and control inventories expose only reviewed local surfaces",
      run: async (ctx) => {
        try {
          await ctx.prove("Every disabled route redirects locally, every live action belongs to the reviewed allowlist, and the final request audit has zero unexpected hosts", {
            voiceover: vo[5],
            action: async () => {
              await navigateAndWait(ctx, "/signin", "/session");
              await navigateAndWait(ctx, "/onboarding", "/session");
              for (const tab of LOCAL_DISABLED_SETTINGS_TABS) {
                await navigateAndWait(
                  ctx,
                  `/workspace/${state.workspaceId}/settings/${tab}`,
                  `/workspace/${state.workspaceId}/settings/general`,
                );
              }
              await navigateAndWait(
                ctx,
                `/workspace/${state.workspaceId}/settings/general`,
                `/workspace/${state.workspaceId}/settings/general`,
              );
              await ctx.waitForText("AI Providers", { timeoutMs: 60_000 });
            },
            assert: async () => {
              const settingsActions = await actionIds(ctx);
              const liveActionUnion = Array.from(new Set([
                ...state.welcomeActions,
                ...state.sessionActions,
                ...settingsActions,
              ])).sort();
              const allowed = new Set<string>(LOCAL_CONTROL_ACTION_IDS);
              const outsideAllowlist = liveActionUnion.filter((id) => !allowed.has(id));
              const forbidden = liveActionUnion.filter(isForbiddenActionId);
              const navigation = await ctx.eval(`(() => Array
                .from(document.querySelectorAll("aside nav button"))
                .map((button) => (button.textContent || "").trim())
                .filter(Boolean))()`);
              const expectedNavigation = [
                "General",
                "AI Providers",
                "Authorized folders",
                "Extensions",
                "Appearance",
                "About & Licenses",
              ];
              const audit = await resourceAudit(ctx);
              const rawWorkspace = state.layout
                ? await readFile(
                    join(state.layout.userData, "openwork-workspaces.json"),
                    "utf8",
                  )
                : "";
              const rawBootstrap = state.layout
                ? await readFile(state.layout.bootstrap, "utf8")
                : "";
              const rawStorage = await ctx.eval(`(() => ({
                den: localStorage.getItem("openwork.den.authToken"),
                server: localStorage.getItem("openwork.server.urlOverride"),
                notifications: localStorage.getItem(${JSON.stringify(NOTIFICATION_STORAGE_KEY)}),
                panels: localStorage.getItem(${JSON.stringify(PANEL_STORAGE_KEY)}),
              }))()`);
              const currentBranch = run("git", ["branch", "--show-current"]);
              const currentHead = run("git", ["rev-parse", "HEAD"]);
              const currentStatus = run("git", ["status", "--porcelain", "--untracked-files=all"]);

              witness(ctx, JSON.stringify(navigation) === JSON.stringify(expectedNavigation), "Settings navigation contains exactly the six reviewed local destinations", navigation);
              witness(ctx, outsideAllowlist.length === 0, "Every live control action belongs to the reviewed local allowlist", { liveActionUnion, outsideAllowlist });
              witness(ctx, forbidden.length === 0, "Cloud, auth, Connect, memory, grant, sharing, voice, and remote actions are absent", forbidden);
              for (const expected of [
                "route.settings.general",
                "route.settings.providers",
                "settings.panel.open",
                "settings.provider.add",
                "session.create_task",
                "workspace.create",
              ]) {
                witness(ctx, liveActionUnion.includes(expected), `Reviewed local action is live: ${expected}`, liveActionUnion);
              }
              witness(ctx, LOCAL_SETTINGS_TABS.length === 6, "The compiled local settings policy has exactly six tabs", LOCAL_SETTINGS_TABS);
              witness(ctx, audit.unexpected.length === 0, "The renderer request audit reports zero unexpected non-loopback hosts", audit);
              witness(ctx, state.trapRequests.length === 0, "The saved-host trap reports zero requests", state.trapRequests);
              witness(ctx, rawWorkspace.includes(REMOTE_WORKSPACE_ID), "The quarantined raw remote workspace remains reversible", rawWorkspace);
              witness(ctx, stable(rawStorage).includes(CLOUD_NOTIFICATION_TITLE), "The quarantined raw notification remains reversible", rawStorage);
              witness(ctx, rawWorkspace.includes(REMOTE_ICON_PATH), "The remote-workspace icon URL remains reversible", rawWorkspace);
              witness(ctx, rawBootstrap.includes(REMOTE_ICON_PATH), "The remote-brand icon URL remains reversible", rawBootstrap);
              witness(ctx, currentBranch.status === 0 && currentBranch.stdout.trim() === EXPECTED_BRANCH, `The proof runs from the expected branch: ${EXPECTED_BRANCH}`, commandOutput(currentBranch));
              witness(ctx, currentHead.status === 0 && /^[a-f0-9]{40}$/.test(currentHead.stdout.trim()), "The proof runs from an exact commit", commandOutput(currentHead));
              witness(ctx, currentHead.stdout.trim() !== BASE_COMMIT, "The PR02 proof commit is after the PR01 base", currentHead.stdout.trim());
              if (ALLOW_DIRTY_WORKTREE) {
                witness(ctx, currentStatus.status === 0, "The in-progress worktree status was captured without claiming clean release provenance", commandOutput(currentStatus));
              } else {
                witness(ctx, currentStatus.status === 0 && currentStatus.stdout.trim() === "", "The exact-head PR02 worktree is clean", commandOutput(currentStatus));
              }
              await ctx.expectNoText("Cloud account");
              await ctx.expectNoText("OpenWork Models");
              await ctx.expectNoText("Connect");
              await ctx.expectNoText("Memory");
              await ctx.expectNoText("Sign in");

              ctx.output("Final local renderer policy and request audit", JSON.stringify({
                settingsPolicy: {
                  tabs: LOCAL_SETTINGS_TABS,
                  disabledTabs: LOCAL_DISABLED_SETTINGS_TABS,
                  navigation,
                },
                actionPolicy: {
                  approvedAllowlist: LOCAL_CONTROL_ACTION_IDS,
                  liveWelcome: state.welcomeActions,
                  liveSession: state.sessionActions,
                  liveSettings: settingsActions,
                  liveUnion: liveActionUnion,
                  outsideAllowlist,
                  forbidden,
                },
                network: {
                  renderer: audit,
                  savedHostTrap: {
                    url: `http://${state.trapHost}:${state.trapPort}`,
                    requests: state.trapRequests,
                  },
                  localProviderRequests: state.providerRequests,
                },
                reversibility: {
                  remoteWorkspacePresent: rawWorkspace.includes(REMOTE_WORKSPACE_ID),
                  cloudNotificationPresent: stable(rawStorage).includes(CLOUD_NOTIFICATION_TITLE),
                  remoteWorkspaceIconPresent: rawWorkspace.includes(REMOTE_ICON_PATH),
                  remoteBrandIconPresent: rawBootstrap.includes(REMOTE_ICON_PATH),
                },
                exactHead: {
                  branch: currentBranch.stdout.trim(),
                  expectedBranch: EXPECTED_BRANCH,
                  head: currentHead.stdout.trim(),
                  base: BASE_COMMIT,
                  clean: currentStatus.stdout.trim() === "",
                  dirtyWorktreeAllowed: ALLOW_DIRTY_WORKTREE,
                },
              }, null, 2));
            },
            screenshot: {
              name: "local-settings-and-actions",
              requireText: [
                "AgencyAI",
                "General",
                "AI Providers",
                "Authorized folders",
                "Extensions",
                "Appearance",
              ],
              rejectText: [
                "Cloud account",
                "OpenWork Models",
                "Connect",
                "Memory",
                "Sign in",
              ],
            },
          });
        } finally {
          closeServer(state.providerServer);
          closeServer(state.trapServer);
        }
      },
    },
  ],
});
