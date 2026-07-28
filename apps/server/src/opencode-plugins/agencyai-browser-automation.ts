import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  tool,
  type Hooks,
  type PluginInput,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@opencode-ai/plugin";
import reviewedBrowserPlugin from "opencode-chrome-devtools";

import { uiControlDiscoveryPaths } from "./ui-control-discovery.js";

const REVIEWED_BROWSER_PLUGIN_VERSION = "1.0.4";
const BROWSER_POLICY_TIMEOUT_MS = 3_000;
const MAX_AUTHORIZED_TARGETS = 128;

type BrowserPolicy = Readonly<{
  browserUrl: string;
  targetIds: ReadonlySet<string>;
}>;

function exactLoopbackHttpOrigin(value: unknown, label: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${label} must be an exact 127.0.0.1 HTTP origin`);
  }
  return `http://127.0.0.1:${port}`;
}

function validBearerToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 512
    && !/\s/.test(value);
}

function validTargetId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

async function readAgencyAiUiBridge(): Promise<{
  baseUrl: string;
  token: string;
}> {
  const storageRoot = process.env.OPENWORK_STORAGE_ROOT?.trim();
  if (!storageRoot) {
    throw new Error("AgencyAI browser automation is unavailable");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(storageRoot));
  } catch {
    throw new Error("AgencyAI browser automation storage is unavailable");
  }

  for (const candidate of uiControlDiscoveryPaths({ localOnly: true })) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) continue;
      const canonicalCandidate = await realpath(candidate);
      const child = relative(canonicalRoot, canonicalCandidate);
      if (
        child === ".."
        || child.startsWith(`..${sep}`)
        || isAbsolute(child)
      ) {
        continue;
      }
      const parsed = JSON.parse(await readFile(canonicalCandidate, "utf8")) as
        Record<string, unknown>;
      if (!validBearerToken(parsed.token)) continue;
      return {
        baseUrl: exactLoopbackHttpOrigin(
          parsed.baseUrl,
          "AgencyAI UI bridge",
        ),
        token: parsed.token,
      };
    } catch {
      // Fail closed and try the next app-owned discovery candidate.
    }
  }
  throw new Error("AgencyAI browser automation bridge is unavailable");
}

async function loadBrowserPolicy(): Promise<BrowserPolicy> {
  const bridge = await readAgencyAiUiBridge();
  const response = await fetch(
    new URL("/browser/targets", `${bridge.baseUrl}/`),
    {
      redirect: "error",
      signal: AbortSignal.timeout(BROWSER_POLICY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `AgencyAI browser authorization failed: HTTP ${response.status}`,
    );
  }
  const payload = await response.json() as Record<string, unknown>;
  if (payload.ok !== true || !Array.isArray(payload.target_ids)) {
    throw new Error("AgencyAI browser authorization response is invalid");
  }
  const targetIds = payload.target_ids.filter(validTargetId);
  if (
    targetIds.length !== payload.target_ids.length
    || targetIds.length > MAX_AUTHORIZED_TARGETS
  ) {
    throw new Error("AgencyAI browser authorization targets are invalid");
  }
  return Object.freeze({
    browserUrl: exactLoopbackHttpOrigin(
      payload.browser_url,
      "AgencyAI browser endpoint",
    ),
    targetIds: new Set(targetIds),
  });
}

function requireAuthorizedTarget(
  policy: BrowserPolicy,
  targetId: string,
): string {
  if (!validTargetId(targetId) || !policy.targetIds.has(targetId)) {
    throw new Error(
      "Browser target is not authorized. Start with openwork_execute browser.open_url.",
    );
  }
  return targetId;
}

function externalBrowserUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Browser navigation requires an absolute HTTP or HTTPS URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
  ) {
    throw new Error("Browser navigation requires an HTTP or HTTPS URL without credentials");
  }
  return parsed.toString();
}

function requireUpstreamTool(
  hooks: Hooks,
  name: string,
): ToolDefinition {
  const definition = hooks.tool?.[name];
  if (!definition) {
    throw new Error(`Reviewed browser plugin is missing ${name}`);
  }
  return definition;
}

async function executeAuthorizedUpstreamTool(
  hooks: Hooks,
  name: string,
  args: Record<string, unknown> & { target_id: string },
  context: ToolContext,
): Promise<ToolResult> {
  const policy = await loadBrowserPolicy();
  const targetId = requireAuthorizedTarget(policy, args.target_id);
  return requireUpstreamTool(hooks, name).execute(
    {
      ...args,
      target_id: targetId,
      browser_url: policy.browserUrl,
    },
    context,
  );
}

function boundedDisplayValue(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function listAuthorizedBrowserTargets(): Promise<string> {
  const policy = await loadBrowserPolicy();
  const response = await fetch(
    new URL("/json/list", `${policy.browserUrl}/`),
    {
      redirect: "error",
      signal: AbortSignal.timeout(BROWSER_POLICY_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`AgencyAI browser target discovery failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("AgencyAI browser target discovery response is invalid");
  }
  const pages = payload.filter((entry): entry is Record<string, unknown> => (
    typeof entry === "object"
    && entry !== null
    && entry.type === "page"
    && validTargetId(entry.id)
    && policy.targetIds.has(entry.id)
  ));
  if (pages.length === 0) return "No authorized AgencyAI browser targets found.";
  return pages.map((entry) => (
    `[${entry.id}] ${boundedDisplayValue(entry.title, 500)}\n`
    + `  ${boundedDisplayValue(entry.url, 2_048)}`
  )).join("\n\n");
}

/**
 * Security wrapper around the reviewed opencode-chrome-devtools package.
 *
 * The raw package accepts arbitrary CDP origins and arbitrary Electron target
 * IDs. This projection removes browser_url from every model-visible schema and
 * requires an authenticated, live target allowlist from the desktop process.
 */
export const AgencyAiBrowserAutomation = async (
  input: PluginInput,
): Promise<Hooks> => {
  const upstream = await reviewedBrowserPlugin(input);
  return {
    tool: {
      browser_version: tool({
        description:
          "Return the pinned AgencyAI browser automation wrapper and reviewed engine version.",
        args: {},
        async execute() {
          return `agencyai-browser-automation@${REVIEWED_BROWSER_PLUGIN_VERSION} (opencode-chrome-devtools@${REVIEWED_BROWSER_PLUGIN_VERSION})`;
        },
      }),
      browser_list: tool({
        description:
          "List only browser targets authorized by AgencyAI's browser.open_url action.",
        args: {},
        async execute() {
          return listAuthorizedBrowserTargets();
        },
      }),
      browser_navigate: tool({
        description:
          "Navigate an AgencyAI-authorized browser target to an HTTP or HTTPS URL.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
          url: tool.schema.string().describe(
            "Absolute HTTP or HTTPS URL to navigate to.",
          ),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_navigate",
            { ...args, url: externalBrowserUrl(args.url) },
            context,
          );
        },
      }),
      browser_snapshot: tool({
        description:
          "Get an accessibility snapshot of an AgencyAI-authorized browser target.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_snapshot",
            args,
            context,
          );
        },
      }),
      browser_click: tool({
        description:
          "Click a snapshot UID in an AgencyAI-authorized browser target.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
          uid: tool.schema.number().describe(
            "Element UID returned by browser_snapshot.",
          ),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_click",
            args,
            context,
          );
        },
      }),
      browser_fill: tool({
        description:
          "Fill a snapshot UID in an AgencyAI-authorized browser target.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
          uid: tool.schema.number().describe(
            "Element UID returned by browser_snapshot.",
          ),
          value: tool.schema.string().describe("Text to enter."),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_fill",
            args,
            context,
          );
        },
      }),
      browser_eval: tool({
        description:
          "Evaluate JavaScript in an AgencyAI-authorized browser target.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
          expression: tool.schema.string().describe(
            "JavaScript expression to evaluate in the external page.",
          ),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_eval",
            args,
            context,
          );
        },
      }),
      browser_screenshot: tool({
        description:
          "Capture an AgencyAI-authorized browser target as a PNG.",
        args: {
          target_id: tool.schema.string().describe(
            "Target ID returned by openwork_execute browser.open_url.",
          ),
        },
        async execute(args, context) {
          return executeAuthorizedUpstreamTool(
            upstream,
            "browser_screenshot",
            args,
            context,
          );
        },
      }),
    },
  };
};
