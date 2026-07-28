import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { OpenworkAffordanceEffects } from "@openwork/types/openwork-affordance";
import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
} from "./agent-instruction-compose.js";
import {
  composeSkillAuthoringInstruction,
  resolveOpenWorkConnectSkillInstruction,
  resolveOpenWorkExtensionDiscoveryInstruction,
  type OpenCodeContext,
  type OpenWorkEngineMcpStatusClient,
} from "./openwork-extensions-preview-steering.js";
import {
  buildOpenworkProviderContributions,
  type ConnectSkillDescriptor,
  type EngineMcpDescriptor,
} from "./openwork-provider-adapters.js";
import { uiControlDiscoveryPaths } from "./ui-control-discovery.js";
import { isOpenworkCloudMcpName } from "../mcp-product-policy.js";

type ExtensionActionPayload = {
  extensionId: string;
  action: string;
  args: Record<string, unknown>;
  context: ReturnType<typeof contextPayload>;
};

const listActionsArgsSchema = z.object({
  extensionId: z.string().optional().describe("Optional extension id to filter by, such as google-workspace."),
});

const callArgsSchema = z.object({
  extensionId: z.string().describe("Extension id, such as google-workspace."),
  action: z.string().describe("Action id from extension.actions."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action."),
});

const openworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1).describe("Semantic affordance id from openwork_context."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the affordance."),
  expectedRevision: z.number().int().nonnegative().optional().describe("Context revision from openwork_context. Use for commands to prevent stale writes."),
  actor: z.string().trim().min(1).optional().describe("Optional agent or client id used to attribute serialized commands."),
});

const connectSkillDescriptorSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  capability: z.string(),
}).passthrough();

const connectSkillsEnvelopeSchema = z.object({
  skills: z.array(connectSkillDescriptorSchema),
}).passthrough();

const sessionSearchArgsSchema = z.object({
  query: z.string().trim().min(1).describe("Text to search for across OpenWork session titles and message transcripts."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name to limit the search."),
  limit: z.number().int().positive().max(20).optional().describe("Maximum matching sessions to return. Defaults to 10, max 20."),
  scanLimit: z.number().int().positive().max(500).optional().describe("Maximum newest sessions to scan across matching workspaces. Defaults to 100, max 500."),
  messageLimit: z.number().int().positive().max(1000).optional().describe("Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
});

const sessionReadArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("OpenWork/OpenCode session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of recent transcript messages to return. Defaults to 30, max 100."),
});

const sessionCreateArgsSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Short title shown in the OpenWork session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional OpenWork workspace id/name. Defaults to the workspace containing the current session."),
});

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const workspaceListEnvelopeSchema = z.object({
  items: z.array(workspaceSchema),
}).passthrough();

const sessionTimeSchema = z.object({
  created: z.number().optional(),
  updated: z.number().optional(),
}).passthrough();

const sessionInfoSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  time: sessionTimeSchema.optional(),
}).passthrough();

const sessionListEnvelopeSchema = z.object({
  items: z.array(sessionInfoSchema),
}).passthrough();

const sessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
}).passthrough();

const createdSessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
  started: z.boolean(),
}).passthrough();

const sessionPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

const sessionMessageSchema = z.object({
  info: z.object({
    id: z.string(),
    role: z.string(),
    time: sessionTimeSchema.optional(),
  }).passthrough(),
  parts: z.array(sessionPartSchema),
}).passthrough();

const sessionMessagesEnvelopeSchema = z.object({
  items: z.array(sessionMessageSchema),
}).passthrough();

const OPENWORK_AGENT_SURFACE_INSTRUCTION =
  `## OpenWork app context
Use openwork_context when the request depends on the current OpenWork screen, open tabs, split view, focused pane, sidebar, side panel, settings panel, or available app actions.
Each affordance declares its effects and executor. Use openwork_query only for side-effect-free affordances whose executor is OpenWork. Use openwork_execute for OpenWork commands without activating the desktop window. If executor names another tool, call that exact tool instead.
Reading another session does not require opening it. Prefer session.search then session.read for transcript questions; use session.create for new chats and a UI command only when the user asks to navigate.
To open settings or navigate the app, use openwork_execute with ids from openwork_context such as settings.panel.open — never browser_* tools for the OpenWork app itself.`;

const OPENWORK_BROWSER_INSTRUCTION =
  `Do NOT use browser_navigate, browser_click, or browser_snapshot to interact with the OpenWork app itself. Those are for browsing external websites.

## Built-in Browser (external websites)
For web browsing tasks, ALWAYS start with openwork_execute id browser.open_url. It creates/selects a built-in OpenWork browser tab and returns browser_url plus target_id. Use that exact browser_url and target_id for every later browser_snapshot, browser_click, browser_fill, browser_eval, and browser_screenshot call.
Do not call browser_navigate without a target_id returned by browser.open_url. Do not use browser_* tools on the OpenWork app target (avoid targets with title "OpenWork" or URLs containing ":5173/#/").`;

const AGENCYAI_AGENT_SURFACE_INSTRUCTION =
  `## AgencyAI app context
Use openwork_context when the request depends on the current AgencyAI screen, open tabs, split view, focused pane, sidebar, side panel, settings panel, or available app actions.
Each affordance declares its effects and executor. Use openwork_query only for side-effect-free affordances whose executor is AgencyAI. Use openwork_execute for AgencyAI commands without activating the desktop window. If an executor names another tool, call that exact tool instead.
Reading another session does not require opening it. Prefer session.search then session.read for transcript questions; use session.create for new chats and a UI command only when the user asks to navigate.
To open settings or navigate the app, use openwork_execute with ids from openwork_context such as settings.panel.open — never browser_* tools for the AgencyAI app itself.`;

const AGENCYAI_BROWSER_INSTRUCTION =
  `Do NOT use browser_navigate, browser_click, or browser_snapshot to interact with the AgencyAI app itself. Those are for browsing external websites.

## Built-in Browser (external websites)
For web browsing tasks, start with openwork_execute id browser.open_url. It creates an isolated built-in AgencyAI browser tab and returns its authorized target_id. Use that target_id for later browser_snapshot, browser_click, browser_fill, browser_eval, and browser_screenshot calls; AgencyAI supplies the private browser endpoint itself.
Do not call browser_navigate without a target_id returned by browser.open_url. Do not use browser_* tools on the AgencyAI app target.`;

const AGENCYAI_LOCAL_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check AgencyAI local extensions before saying the capability is unavailable. Use openwork_query with id extension.actions to inspect enabled local actions, then openwork_execute with id extension.call for the matching action.";

const AGENCYAI_LOCAL_FACTORY_MARKER = "__agencyAiLocalProduct";

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

type OpenWorkWorkspace = z.infer<typeof workspaceSchema>;
type SessionInfo = z.infer<typeof sessionInfoSchema>;
type SessionMessage = z.infer<typeof sessionMessageSchema>;
type SessionSearchSnippet = { before: string; match: string; after: string };
type SessionSearchResult = {
  workspaceId: string;
  workspace: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  kind: "title" | "message";
  snippet: SessionSearchSnippet;
  role?: string;
  messageId?: string;
  messageIndex?: number;
};
type CreatedOpenWorkSessionResult = {
  ok: true;
  sessionId: string;
  title: string;
  started: boolean;
  route: string;
};
type FailedOpenWorkSessionResult = {
  ok: false;
  title: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const affordanceReadEffects: OpenworkAffordanceEffects = { data: "read", ui: "none", external: false };
const affordanceWriteEffects: OpenworkAffordanceEffects = { data: "write", ui: "none", external: false };
const affordanceExternalWriteEffects: OpenworkAffordanceEffects = { data: "write", ui: "none", external: true };

function affordanceResult(
  id: string,
  result: unknown,
  effects: OpenworkAffordanceEffects,
) {
  if (isRecord(result) && result.ok === false) {
    return {
      ok: false,
      id,
      error: typeof result.error === "string" ? result.error : `${id} failed`,
      code: "failed",
    };
  }
  return { ok: true, id, result, effects };
}

function unavailableAffordance(id: string, error: string) {
  return { ok: false, id, error, code: "unavailable" };
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

type OpenWorkEngineMcpStatusFunction = OpenWorkEngineMcpStatusClient["mcp"]["status"];

function isOpenWorkEngineMcpStatusFunction(value: unknown): value is OpenWorkEngineMcpStatusFunction {
  return typeof value === "function";
}

function readEngineMcpStatusClient(value: unknown): OpenWorkEngineMcpStatusClient | undefined {
  const client = isRecord(value) ? value.client : undefined;
  const mcp = isRecord(client) ? client.mcp : undefined;
  const status = isRecord(mcp) ? mcp.status : undefined;
  if (!isOpenWorkEngineMcpStatusFunction(status)) return undefined;
  return { mcp: { status: (request) => status.call(mcp, request) } };
}

function normalizeOpenCodeContext(value: unknown): OpenCodeContext {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const agent = optionalStringProperty(nested, "agent");
  const sessionID = optionalStringProperty(nested, "sessionID");
  const messageID = optionalStringProperty(nested, "messageID");
  const directory = optionalStringProperty(nested, "directory");
  const worktree = optionalStringProperty(nested, "worktree");
  const workspaceId = optionalStringProperty(nested, "workspaceId");
  const workspaceID = optionalStringProperty(nested, "workspaceID");
  return {
    ...(agent ? { agent } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceID ? { workspaceID } : {}),
  };
}

function mergeTransformInputWithFactoryContext(input: unknown, factoryContext: OpenCodeContext): unknown {
  if (Object.keys(factoryContext).length === 0) return input;
  const inputRecord = isRecord(input) ? input : {};
  const inputContext = isRecord(inputRecord.context) ? inputRecord.context : {};
  return {
    ...inputRecord,
    context: {
      ...factoryContext,
      ...inputContext,
    },
  };
}

const SESSION_SEARCH_DEFAULT_LIMIT = 10;
const SESSION_SEARCH_DEFAULT_SCAN_LIMIT = 100;
const SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT = 400;
const SESSION_SEARCH_CONCURRENCY = 6;
const SESSION_SNIPPET_BEFORE = 36;
const SESSION_SNIPPET_AFTER = 72;

function requireLocalLoopbackOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid loopback HTTP origin`);
  }
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "::1"
    || url.hostname === "[::1]";
  if (
    url.protocol !== "http:"
    || !loopback
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must be an exact loopback HTTP origin`);
  }
  return url.origin;
}

function localRequestUrl(
  baseUrl: string,
  path: string,
  localMvp: boolean,
  label: string,
): string {
  if (!localMvp) return `${baseUrl}${path}`;
  return new URL(path, requireLocalLoopbackOrigin(baseUrl, label)).toString();
}

async function discoverUiBridge(localMvp = false): Promise<UiBridge | null> {
  if (
    !localMvp
    && cachedBridge
    && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS
  ) {
    return cachedBridge;
  }
  for (const candidate of uiControlDiscoveryPaths({ localOnly: localMvp })) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        const baseUrl = localMvp
          ? requireLocalLoopbackOrigin(
              parsed.baseUrl,
              "AgencyAI UI bridge URL",
            )
          : parsed.baseUrl;
        const bridge = { baseUrl, token: parsed.token };
        if (!localMvp) {
          cachedBridge = bridge;
          cachedBridgeAt = Date.now();
        }
        return bridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function uiBridgeRequest(
  path: string,
  options: { method?: string; body?: unknown } = {},
  localMvp = false,
): Promise<unknown> {
  const bridge = await discoverUiBridge(localMvp);
  if (!bridge) return { ok: false, error: "OpenWork UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(
      localRequestUrl(
        bridge.baseUrl,
        path,
        localMvp,
        "AgencyAI UI bridge URL",
      ),
      {
      method: options.method || "GET",
      ...(localMvp ? { redirect: "error" as const } : {}),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      },
    );
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
    cachedBridge = null;
    cachedBridgeAt = 0;
    return { ok: false, error: `UI bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function serverGet(path: string, localMvp = false): Promise<unknown> {
  const { url, token } = requireOpenWorkServer(localMvp);
  const response = await fetch(
    localRequestUrl(url, path, localMvp, "AgencyAI server URL"),
    {
    ...(localMvp ? { redirect: "error" as const } : {}),
    headers: { Authorization: `Bearer ${token}` },
    },
  );
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "OpenWork server request failed"));
  return payload;
}

async function readConnectSkillDescriptors(): Promise<ConnectSkillDescriptor[]> {
  try {
    const parsed = connectSkillsEnvelopeSchema.safeParse(
      await serverGet("/experimental/connect/skills"),
    );
    return parsed.success ? parsed.data.skills : [];
  } catch {
    return [];
  }
}

async function readEngineMcpDescriptors(
  client: OpenWorkEngineMcpStatusClient | undefined,
  directory: string | undefined,
): Promise<EngineMcpDescriptor[]> {
  if (!client) return [];
  try {
    const result = await client.mcp.status(directory ? { query: { directory } } : undefined);
    const payload = isRecord(result) && result.data !== undefined ? result.data : result;
    if (!isRecord(payload)) return [];
    return Object.entries(payload).map(([name, entry]) => {
      const status = typeof entry === "string"
        ? entry
        : optionalStringProperty(entry, "status");
      return status ? { name, status } : { name };
    });
  } catch {
    return [];
  }
}

async function readOpenworkAgentContext(
  engineMcpStatusClient: OpenWorkEngineMcpStatusClient | undefined,
  engineMcpStatusDirectory: string | undefined,
  localMvp = false,
): Promise<Record<string, unknown>> {
  const [uiResult, skills, mcps] = await Promise.all([
    uiBridgeRequest("/context", {}, localMvp),
    localMvp ? Promise.resolve([]) : readConnectSkillDescriptors(),
    readEngineMcpDescriptors(engineMcpStatusClient, engineMcpStatusDirectory),
  ]);
  const effectiveMcps = localMvp
    ? mcps.filter((mcp) => !isOpenworkCloudMcpName(mcp.name))
    : mcps;
  const contributions = buildOpenworkProviderContributions(
    skills,
    effectiveMcps,
  );
  const providerAffordances = contributions.flatMap((contribution) => contribution.affordances);
  const uiContext = isRecord(uiResult) && isRecord(uiResult.context) ? uiResult.context : null;
  if (!uiContext) {
    return {
      ok: true,
      context: null,
      ui: uiResult,
      availableAffordances: providerAffordances,
      contributions,
    };
  }
  const uiAffordances = Array.isArray(uiContext.availableAffordances)
    ? uiContext.availableAffordances
    : [];
  return {
    ok: true,
    context: {
      ...uiContext,
      availableAffordances: [...uiAffordances, ...providerAffordances],
      contributions,
    },
  };
}

async function queryOpenworkAffordance(
  rawArgs: unknown,
  localMvp = false,
): Promise<unknown> {
  const request = openworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.search") {
    return affordanceResult(
      request.id,
      await searchOpenWorkSessions(request.args ?? {}, localMvp),
      affordanceReadEffects,
    );
  }
  if (request.id === "session.read") {
    return affordanceResult(
      request.id,
      await readOpenWorkSession(request.args ?? {}, localMvp),
      affordanceReadEffects,
    );
  }
  if (request.id === "extension.actions") {
    const args = listActionsArgsSchema.parse(request.args ?? {});
    const query = args.extensionId ? `?extensionId=${encodeURIComponent(args.extensionId)}` : "";
    return affordanceResult(
      request.id,
      await serverGet(`/experimental/extensions/actions${query}`, localMvp),
      affordanceReadEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in openwork_context.",
    );
  }
  const result = await uiBridgeRequest("/query", {
    method: "POST",
    body: request,
  }, localMvp);
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "OpenWork UI query returned an invalid response.");
}

async function executeOpenworkAffordance(
  rawArgs: unknown,
  context: OpenCodeContext,
  localMvp = false,
): Promise<unknown> {
  const request = openworkAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.create") {
    return affordanceResult(
      request.id,
      await createOpenWorkSessions(request.args ?? {}, context, localMvp),
      affordanceWriteEffects,
    );
  }
  if (request.id === "extension.call") {
    const args = callArgsSchema.parse(request.args ?? {});
    return affordanceResult(
      request.id,
      await postJson("/experimental/extensions/call", {
        extensionId: args.extensionId,
        action: args.action,
        args: args.args ?? {},
        context: contextPayload(context),
      }, localMvp),
      affordanceExternalWriteEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in openwork_context.",
    );
  }
  const result = await uiBridgeRequest("/command", {
    method: "POST",
    body: request,
  }, localMvp);
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "OpenWork UI command returned an invalid response.");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function buildSessionSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SESSION_SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SESSION_SNIPPET_AFTER);
  const before = `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "..." : ""}`;
  return { before, match: text.slice(index, index + length), after };
}

function workspaceLabel(workspace: OpenWorkWorkspace): string {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || workspace.id;
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.id;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function messageText(message: SessionMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    if (part.synthetic || part.ignored) continue;
    const text = part.text?.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function findTextMatch(text: string, queryLower: string): { index: number; length: number } | null {
  const lower = text.toLowerCase();
  const exact = lower.indexOf(queryLower);
  if (exact >= 0) return { index: exact, length: queryLower.length };

  const terms = queryLower.split(/\s+/).filter((term) => term.length > 1);
  if (terms.length < 2) return null;

  let firstIndex = Number.POSITIVE_INFINITY;
  let firstLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) return null;
    if (index < firstIndex) {
      firstIndex = index;
      firstLength = term.length;
    }
  }
  return Number.isFinite(firstIndex) ? { index: firstIndex, length: firstLength } : null;
}

function titleSearchResult(workspace: OpenWorkWorkspace, session: SessionInfo, queryLower: string): SessionSearchResult | null {
  const title = sessionTitle(session);
  const text = `${title} ${workspaceLabel(workspace)}`;
  const match = findTextMatch(text, queryLower);
  if (!match) return null;
  return {
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    sessionId: session.id,
    title,
    updatedAt: sessionUpdatedAt(session),
    kind: "title",
    snippet: buildSessionSnippet(text, match.index, match.length),
  };
}

function messageSearchResult(workspace: OpenWorkWorkspace, session: SessionInfo, messages: SessionMessage[], queryLower: string): SessionSearchResult | null {
  let fallback: SessionSearchResult | null = null;
  for (const [index, message] of messages.entries()) {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const match = findTextMatch(text, queryLower);
    if (!match) continue;
    const result: SessionSearchResult = {
      workspaceId: workspace.id,
      workspace: workspaceLabel(workspace),
      sessionId: session.id,
      title: sessionTitle(session),
      updatedAt: sessionUpdatedAt(session),
      kind: "message",
      role,
      messageId: message.info.id,
      messageIndex: index,
      snippet: buildSessionSnippet(text, match.index, match.length),
    };
    if (role === "user") return result;
    if (!fallback) fallback = result;
  }
  return fallback;
}

async function listOpenWorkWorkspaces(
  localMvp = false,
): Promise<OpenWorkWorkspace[]> {
  return workspaceListEnvelopeSchema.parse(
    await serverGet("/workspaces", localMvp),
  ).items;
}

function filterWorkspaces(workspaces: OpenWorkWorkspace[], workspaceId?: string): OpenWorkWorkspace[] {
  const query = workspaceId?.trim().toLowerCase();
  if (!query) return workspaces;
  return workspaces.filter((workspace) => {
    const labels = [workspace.id, workspace.name, workspace.displayName, workspace.path]
      .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
      .map((label) => label.trim().toLowerCase());
    return labels.includes(query);
  });
}

async function listWorkspaceSessions(
  workspace: OpenWorkWorkspace,
  limit: number,
  localMvp = false,
): Promise<SessionInfo[]> {
  const query = new URLSearchParams({ roots: "true", limit: String(limit) });
  return sessionListEnvelopeSchema.parse(
    await serverGet(
      `/workspace/${encodeURIComponent(workspace.id)}/sessions?${query.toString()}`,
      localMvp,
    ),
  ).items;
}

async function readWorkspaceSession(
  workspace: OpenWorkWorkspace,
  sessionId: string,
  localMvp = false,
): Promise<SessionInfo> {
  return sessionEnvelopeSchema.parse(
    await serverGet(
      `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}`,
      localMvp,
    ),
  ).item;
}

async function readSessionMessages(
  workspace: OpenWorkWorkspace,
  sessionId: string,
  limit: number,
  localMvp = false,
): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  return sessionMessagesEnvelopeSchema.parse(
    await serverGet(
      `/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
      localMvp,
    ),
  ).items;
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()));
}

async function searchOpenWorkSessions(
  rawArgs: unknown,
  localMvp = false,
): Promise<object> {
  const args = sessionSearchArgsSchema.parse(rawArgs);
  const resultLimit = args.limit ?? SESSION_SEARCH_DEFAULT_LIMIT;
  const scanLimit = args.scanLimit ?? SESSION_SEARCH_DEFAULT_SCAN_LIMIT;
  const messageLimit = args.messageLimit ?? SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT;
  const queryLower = args.query.trim().toLowerCase();
  const workspaces = filterWorkspaces(
    await listOpenWorkWorkspaces(localMvp),
    args.workspaceId,
  );
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No OpenWork workspaces are available" };
  }

  const sessions: Array<{ workspace: OpenWorkWorkspace; session: SessionInfo }> = [];
  const workspaceErrors: Array<{ workspaceId: string; workspace: string; error: string }> = [];
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      const items = await listWorkspaceSessions(
        workspace,
        scanLimit,
        localMvp,
      );
      for (const session of items) sessions.push({ workspace, session });
    } catch (error) {
      workspaceErrors.push({ workspaceId: workspace.id, workspace: workspaceLabel(workspace), error: unknownErrorMessage(error) });
    }
  }));

  const sessionsToScan = sessions
    .sort((left, right) => sessionUpdatedAt(right.session) - sessionUpdatedAt(left.session))
    .slice(0, scanLimit);
  const matches: SessionSearchResult[] = [];

  await forEachWithConcurrency(sessionsToScan, SESSION_SEARCH_CONCURRENCY, async ({ workspace, session }) => {
    const titleMatch = titleSearchResult(workspace, session, queryLower);
    try {
      const messages = await readSessionMessages(
        workspace,
        session.id,
        messageLimit,
        localMvp,
      );
      const messageMatch = messageSearchResult(workspace, session, messages, queryLower);
      if (messageMatch) matches.push(messageMatch);
      else if (titleMatch) matches.push(titleMatch);
    } catch {
      if (titleMatch) matches.push(titleMatch);
    }
  });

  const results = matches
    .filter((match) => match !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    ok: true,
    query: args.query,
    workspaceCount: workspaces.length,
    totalCandidateSessions: sessions.length,
    scannedSessions: sessionsToScan.length,
    scanLimit,
    messageLimit,
    resultLimit,
    workspaceErrors,
    truncated: sessions.length > sessionsToScan.length || results.length > resultLimit,
    results: results.slice(0, resultLimit),
  };
}

async function readOpenWorkSession(
  rawArgs: unknown,
  localMvp = false,
): Promise<object> {
  const args = sessionReadArgsSchema.parse(rawArgs);
  const count = args.count ?? 30;
  const workspaces = filterWorkspaces(
    await listOpenWorkWorkspaces(localMvp),
    args.workspaceId,
  );
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No OpenWork workspaces are available" };
  }

  for (const workspace of workspaces) {
    try {
      const session = await readWorkspaceSession(
        workspace,
        args.sessionId,
        localMvp,
      );
      const messages = await readSessionMessages(
        workspace,
        args.sessionId,
        count,
        localMvp,
      );
      const readable = messages
        .map((message, index) => ({
          index,
          id: message.info.id,
          role: message.info.role,
          text: messageText(message),
        }))
        .filter((message) => message.text.trim().length > 0);
      return {
        ok: true,
        workspaceId: workspace.id,
        workspace: workspaceLabel(workspace),
        sessionId: session.id,
        title: sessionTitle(session),
        updatedAt: sessionUpdatedAt(session),
        returned: readable.length,
        requested: count,
        messages: readable,
      };
    } catch {
      if (args.workspaceId) break;
    }
  }

  return { ok: false, error: `Session ${args.sessionId} was not found in matching OpenWork workspaces` };
}

function serverUrl(): string {
  return String(process.env.OPENWORK_SERVER_URL || "").replace(/\/$/, "");
}

function serverToken(): string {
  return String(process.env.OPENWORK_SERVER_TOKEN || "");
}

function requireOpenWorkServer(
  localMvp = false,
): { url: string; token: string } {
  const rawUrl = serverUrl();
  const token = serverToken();
  if (!rawUrl || !token) {
    throw new Error("OpenWork extension tools are only available when OpenCode is launched by OpenWork.");
  }
  const url = localMvp
    ? requireLocalLoopbackOrigin(rawUrl, "AgencyAI server URL")
    : rawUrl;
  return { url, token };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}

async function resolveContextWorkspace(
  workspaceId: string | undefined,
  context: OpenCodeContext,
  localMvp = false,
): Promise<OpenWorkWorkspace> {
  const workspaces = await listOpenWorkWorkspaces(localMvp);
  if (!workspaces.length) throw new Error("No OpenWork workspaces are available");
  if (workspaceId) {
    const match = filterWorkspaces(workspaces, workspaceId).at(0);
    if (!match) throw new Error(`No workspace matched ${workspaceId}`);
    return match;
  }
  const directory = context.worktree?.trim() || context.directory?.trim();
  if (directory) {
    const dir = normalizeDirPath(directory);
    const match = workspaces
      .filter((workspace) => {
        const path = workspace.path?.trim();
        if (!path) return false;
        const root = normalizeDirPath(path);
        return dir === root || dir.startsWith(`${root}/`);
      })
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
      .at(0);
    if (match) return match;
  }
  const only = workspaces.at(0);
  if (workspaces.length === 1 && only) return only;
  throw new Error(`Multiple OpenWork workspaces match; pass workspaceId. Available: ${workspaces.map((workspace) => workspaceLabel(workspace)).join(", ")}`);
}

async function createOpenWorkSessions(
  rawArgs: unknown,
  context: OpenCodeContext,
  localMvp = false,
): Promise<object> {
  const args = sessionCreateArgsSchema.parse(rawArgs);
  const workspace = await resolveContextWorkspace(
    args.workspaceId,
    context,
    localMvp,
  );
  const results = await Promise.all(args.sessions.map(async (session): Promise<CreatedOpenWorkSessionResult | FailedOpenWorkSessionResult> => {
    try {
      const payload = createdSessionEnvelopeSchema.parse(await postJson(
        `/workspace/${encodeURIComponent(workspace.id)}/sessions`,
        session,
        localMvp,
      ));
      return {
        ok: true,
        sessionId: payload.item.id,
        title: payload.item.title?.trim() || session.title,
        started: payload.started,
        route: `/workspace/${encodeURIComponent(workspace.id)}/session/${encodeURIComponent(payload.item.id)}`,
      };
    } catch (error) {
      return {
        ok: false,
        title: session.title,
        error: unknownErrorMessage(error),
      };
    }
  }));
  const created = results.filter((result): result is CreatedOpenWorkSessionResult => result.ok);
  const failures = results.filter((result): result is FailedOpenWorkSessionResult => !result.ok);
  return {
    ok: failures.length === 0,
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    created,
    failures,
  };
}

async function postJson(
  path: string,
  body: ExtensionActionPayload | Record<string, unknown>,
  localMvp = false,
): Promise<unknown> {
  const { url, token } = requireOpenWorkServer(localMvp);
  const response = await fetch(
    localRequestUrl(url, path, localMvp, "AgencyAI server URL"),
    {
    method: "POST",
    ...(localMvp ? { redirect: "error" as const } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    },
  );
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, "OpenWork extension call failed"));
  }
  return payload;
}

function contextPayload(context: OpenCodeContext) {
  return {
    agent: context.agent,
    sessionId: context.sessionID,
    messageId: context.messageID,
    workspaceId: context.workspaceId ?? context.workspaceID,
    directory: context.directory,
    worktree: context.worktree,
  };
}

export const OpenWorkExtensionsPreview = async (factoryInput?: unknown) => {
  const localMvp = isRecord(factoryInput)
    && factoryInput[AGENCYAI_LOCAL_FACTORY_MARKER] === true;
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  const engineMcpStatusClient = readEngineMcpStatusClient(factoryInput);
  const engineMcpStatusDirectory = factoryContext.directory ?? factoryContext.worktree;
  return {
  "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
    const mergedInput = mergeTransformInputWithFactoryContext(input, factoryContext);
    const [extensionInstruction, skillInstruction] = localMvp
      ? [AGENCYAI_LOCAL_EXTENSION_DISCOVERY_INSTRUCTION, ""]
      : await Promise.all([
          resolveOpenWorkExtensionDiscoveryInstruction(mergedInput, fetch, {
            client: engineMcpStatusClient,
            directory: engineMcpStatusDirectory,
          }),
          resolveOpenWorkConnectSkillInstruction(mergedInput, fetch),
        ]);
    const skillAuthoring = composeSkillAuthoringInstruction(extensionInstruction);
    if (process.env.OPENWORK_DEV_MODE === "1") {
      console.log("[openwork:skill-authoring] system prompt selected", {
        mode: skillAuthoring.mode,
        prompt: skillAuthoring.prompt,
        directory: normalizeOpenCodeContext(mergedInput).directory ?? factoryContext.directory ?? null,
      });
    }
    // One section id per concern — combine drops empties/duplicates so routing,
    // remote skills, session, and browser guidance never overlap by accident.
    const sections = combineInstructionSections(
      createInstructionSection("routing", extensionInstruction),
      createInstructionSection(
        "agent-surface",
        localMvp
          ? AGENCYAI_AGENT_SURFACE_INSTRUCTION
          : OPENWORK_AGENT_SURFACE_INSTRUCTION,
      ),
      createInstructionSection("skill-authoring", skillAuthoring.prompt),
      createInstructionSection("connect-skills", skillInstruction),
      createInstructionSection(
        "browser",
        localMvp ? AGENCYAI_BROWSER_INSTRUCTION : OPENWORK_BROWSER_INSTRUCTION,
      ),
    );
    output.system.push(...composeAgentInstructions(sections));
  },
  tool: {
    openwork_context: {
      description: localMvp
        ? "Read one semantic snapshot of AgencyAI: current screen, retained conversation tabs, split view and focused pane, sidebar and side panel state, settings panel, local provider contributions, and available affordances with explicit effects and executors."
        : "Read one semantic snapshot of OpenWork: current screen, retained conversation tabs, split view and focused pane, sidebar and side panel state, settings panel, provider contributions, remote skill guidance, and available affordances with explicit effects and executors.",
      args: {},
      async execute() {
        return JSON.stringify(
          await readOpenworkAgentContext(
            engineMcpStatusClient,
            engineMcpStatusDirectory,
            localMvp,
          ),
          null,
          2,
        );
      },
    },
    openwork_query: {
      description: localMvp
        ? "Run a side-effect-free AgencyAI affordance whose executor is AgencyAI. Use the exact id and arguments from openwork_context. This reads backend or app state without navigation or window focus."
        : "Run a side-effect-free OpenWork affordance whose executor is OpenWork. Use the exact id and arguments from openwork_context. This reads backend or app state without navigation or window focus.",
      args: openworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown) {
        return JSON.stringify(
          await queryOpenworkAffordance(rawArgs, localMvp),
          null,
          2,
        );
      },
    },
    openwork_execute: {
      description: localMvp
        ? "Execute an AgencyAI command whose executor is AgencyAI without activating the desktop window. Use the exact id and arguments from openwork_context, and pass expectedRevision for UI commands to prevent stale writes. If the descriptor names another executor tool, call that tool instead."
        : "Execute an OpenWork command whose executor is OpenWork without activating the desktop window. Use the exact id and arguments from openwork_context, and pass expectedRevision for UI commands to prevent stale writes. If the descriptor names another executor tool, call that tool instead.",
      args: openworkAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        return JSON.stringify(
          await executeOpenworkAffordance(
            rawArgs,
            mergedContext,
            localMvp,
          ),
          null,
          2,
        );
      },
    },
  },
  };
};
