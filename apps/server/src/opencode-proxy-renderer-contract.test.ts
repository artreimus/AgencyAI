import { describe, expect, test } from "bun:test";

import {
  decideLocalOpencodeProxy,
  type LocalOpencodeProxyFamily,
} from "./opencode-proxy-policy.js";
import type { TokenScope } from "./types.js";

type RendererEndpoint = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  family: LocalOpencodeProxyFamily;
  minimumScope: TokenScope;
  source: string;
}>;

/**
 * Literal contract for the OpenCode SDK calls reachable from the PR02 local
 * renderer composition:
 *
 *   LocalAppProviders -> LocalAppRoot ->
 *     LocalWelcomeRoute | SessionRoute | LocalSettingsRoute
 *
 * Keep this independent of LOCAL_OPENCODE_PROXY_RULES. Adding a generated SDK
 * endpoint to the proxy is not enough: a mounted local renderer call site must
 * justify every entry here.
 */
const REQUIRED_LOCAL_RENDERER_ENDPOINTS: readonly RendererEndpoint[] = [
  { method: "GET", path: "/global/health", family: "health", minimumScope: "viewer", source: "provider reload health check" },
  { method: "GET", path: "/event", family: "events", minimumScope: "viewer", source: "workspace session event sync" },
  { method: "GET", path: "/config", family: "config-read", minimumScope: "viewer", source: "provider filtering and managed config projection" },
  { method: "GET", path: "/provider", family: "provider", minimumScope: "viewer", source: "model and provider discovery" },
  { method: "GET", path: "/provider/auth", family: "provider", minimumScope: "viewer", source: "provider authentication modal" },
  { method: "GET", path: "/mcp", family: "mcp", minimumScope: "viewer", source: "local MCP status and healing" },
  { method: "GET", path: "/path", family: "project-read", minimumScope: "viewer", source: "ordinary MCP OAuth modal" },
  { method: "GET", path: "/agent", family: "project-read", minimumScope: "viewer", source: "session composer agent picker" },
  { method: "GET", path: "/command", family: "project-read", minimumScope: "viewer", source: "session composer slash commands" },
  { method: "GET", path: "/find/file", family: "file-read", minimumScope: "viewer", source: "session composer file mentions" },
  { method: "GET", path: "/permission", family: "interaction", minimumScope: "viewer", source: "legacy pending permission hydration" },
  { method: "GET", path: "/api/session/ses_local/permission", family: "interaction", minimumScope: "viewer", source: "v2 pending permission hydration" },
  { method: "GET", path: "/question", family: "interaction", minimumScope: "viewer", source: "pending question hydration" },

  { method: "POST", path: "/session", family: "session", minimumScope: "collaborator", source: "welcome and session new-task flows" },
  { method: "PATCH", path: "/session/ses_local", family: "session", minimumScope: "collaborator", source: "rename and archive session" },
  { method: "POST", path: "/session/ses_local/prompt_async", family: "session", minimumScope: "collaborator", source: "session prompt submission" },
  { method: "POST", path: "/session/ses_local/command", family: "session", minimumScope: "collaborator", source: "session slash-command submission" },
  { method: "POST", path: "/session/ses_local/shell", family: "session", minimumScope: "collaborator", source: "session shell submission" },
  { method: "POST", path: "/session/ses_local/revert", family: "session", minimumScope: "collaborator", source: "edit or revert message" },
  { method: "POST", path: "/session/ses_local/fork", family: "session", minimumScope: "collaborator", source: "fork at message" },
  { method: "POST", path: "/session/ses_local/abort", family: "session", minimumScope: "collaborator", source: "stop generation and safe revert" },

  { method: "PUT", path: "/auth/anthropic", family: "provider", minimumScope: "collaborator", source: "provider API-key connect" },
  { method: "DELETE", path: "/auth/anthropic", family: "provider", minimumScope: "collaborator", source: "provider disconnect" },
  { method: "POST", path: "/provider/anthropic/oauth/authorize", family: "provider", minimumScope: "collaborator", source: "provider OAuth start" },
  { method: "POST", path: "/provider/anthropic/oauth/callback", family: "provider", minimumScope: "collaborator", source: "provider OAuth completion" },
  { method: "PUT", path: "/auth/openai", family: "provider", minimumScope: "collaborator", source: "OpenAI API-key connect" },
  { method: "DELETE", path: "/auth/openai", family: "provider", minimumScope: "collaborator", source: "OpenAI disconnect" },
  { method: "POST", path: "/provider/openai/oauth/authorize", family: "provider", minimumScope: "collaborator", source: "ChatGPT subscription OAuth start" },
  { method: "POST", path: "/provider/openai/oauth/callback", family: "provider", minimumScope: "collaborator", source: "ChatGPT subscription OAuth completion" },
  { method: "POST", path: "/instance/dispose", family: "engine-instance", minimumScope: "collaborator", source: "provider credential reload" },

  { method: "POST", path: "/mcp/github/connect", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP silent reauthentication" },
  { method: "POST", path: "/mcp/github/auth", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP OAuth start" },
  { method: "POST", path: "/mcp/github/auth/callback", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP OAuth callback" },
  { method: "POST", path: "/mcp/github/auth/authenticate", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP OAuth browser completion" },

  { method: "POST", path: "/permission/req_local/reply", family: "interaction", minimumScope: "collaborator", source: "legacy permission response" },
  { method: "POST", path: "/api/session/ses_local/permission/req_local/reply", family: "interaction", minimumScope: "collaborator", source: "v2 permission response" },
  { method: "POST", path: "/question/req_local/reply", family: "interaction", minimumScope: "collaborator", source: "question response" },
] as const;

/**
 * Narrow compatibility/API surface intentionally retained beyond today's
 * mounted renderer calls. These routes have a concrete local-product use:
 * old-server session-read fallbacks and the ordinary MCP logout contract.
 * Keeping them separate prevents "the SDK has it" from becoming justification
 * for widening the renderer allowlist.
 */
const DELIBERATELY_RETAINED_LOCAL_API_ENDPOINTS: readonly RendererEndpoint[] = [
  { method: "GET", path: "/session", family: "session", minimumScope: "viewer", source: "old-server session-list compatibility fallback" },
  { method: "GET", path: "/session/ses_local", family: "session", minimumScope: "viewer", source: "old-server session-detail compatibility fallback" },
  { method: "GET", path: "/session/ses_local/message", family: "session", minimumScope: "viewer", source: "old-server transcript compatibility fallback" },
  { method: "GET", path: "/session/ses_local/todo", family: "session", minimumScope: "viewer", source: "old-server todo compatibility fallback" },
  { method: "DELETE", path: "/session/ses_local", family: "session", minimumScope: "collaborator", source: "retained local session deletion API" },
  { method: "POST", path: "/mcp/github/disconnect", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP logout disconnect step" },
  { method: "DELETE", path: "/mcp/github/auth", family: "mcp", minimumScope: "collaborator", source: "ordinary MCP OAuth credential logout" },
] as const;

/**
 * Generated SDK routes with neither a mounted local-renderer caller nor a
 * deliberately retained local API contract. The renderer uses trusted
 * OpenWork routes for MCP add/remove/enable, artifact/file reads, and managed
 * config writes.
 */
const UNREACHABLE_LOCAL_RENDERER_ENDPOINTS = [
  ["GET", "/lsp"],
  ["GET", "/vcs"],
  ["GET", "/project"],
  ["GET", "/skill"],
  ["GET", "/file"],
  ["GET", "/file/content"],
  ["GET", "/file/status"],
  ["GET", "/session/status"],
  ["GET", "/session/ses_local/message/msg_local"],
  ["GET", "/session/ses_local/diff"],
  ["POST", "/session/ses_local/unrevert"],
  ["POST", "/session/ses_local/summarize"],
  ["PATCH", "/config"],
  ["POST", "/mcp"],
] as const;

describe("local renderer OpenCode proxy contract", () => {
  for (const endpoint of [
    ...REQUIRED_LOCAL_RENDERER_ENDPOINTS,
    ...DELIBERATELY_RETAINED_LOCAL_API_ENDPOINTS,
  ]) {
    test(`allows ${endpoint.method} ${endpoint.path} for ${endpoint.source}`, () => {
      expect(decideLocalOpencodeProxy(endpoint.method, endpoint.path)).toMatchObject({
        allowed: true,
        method: endpoint.method,
        canonicalPath: endpoint.path,
        family: endpoint.family,
        minimumScope: endpoint.minimumScope,
      });
    });
  }

  for (const [method, path] of UNREACHABLE_LOCAL_RENDERER_ENDPOINTS) {
    test(`denies unmounted SDK endpoint ${method} ${path}`, () => {
      expect(decideLocalOpencodeProxy(method, path)).toMatchObject({
        allowed: false,
        status: 404,
        code: "opencode_proxy_not_allowed",
      });
    });
  }
});
