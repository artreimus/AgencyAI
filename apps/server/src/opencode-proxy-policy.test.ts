import { describe, expect, test } from "bun:test";

import {
  decideLocalOpencodeProxy,
  type LocalOpencodeProxyDeniedReason,
  type LocalOpencodeProxyFamily,
} from "./opencode-proxy-policy.js";
import type { TokenScope } from "./types.js";

type AllowedCase = {
  method: string;
  path: string;
  family: LocalOpencodeProxyFamily;
  minimumScope: TokenScope;
  canonicalPath?: string;
};

const VIEWER_READS: readonly AllowedCase[] = [
  { method: "GET", path: "/opencode/global/health", family: "health", minimumScope: "viewer", canonicalPath: "/global/health" },
  { method: "GET", path: "/event", family: "events", minimumScope: "viewer" },
  { method: "GET", path: "/config", family: "config-read", minimumScope: "viewer" },
  { method: "GET", path: "/provider", family: "provider", minimumScope: "viewer" },
  { method: "GET", path: "/provider/auth", family: "provider", minimumScope: "viewer" },
  { method: "GET", path: "/mcp", family: "mcp", minimumScope: "viewer" },
  { method: "GET", path: "/path", family: "project-read", minimumScope: "viewer" },
  { method: "GET", path: "/agent", family: "project-read", minimumScope: "viewer" },
  { method: "GET", path: "/command", family: "project-read", minimumScope: "viewer" },
  { method: "GET", path: "/find/file", family: "file-read", minimumScope: "viewer" },
  { method: "GET", path: "/permission", family: "interaction", minimumScope: "viewer" },
  { method: "GET", path: "/question", family: "interaction", minimumScope: "viewer" },
  { method: "GET", path: "/api/session/ses_1/permission", family: "interaction", minimumScope: "viewer" },
  { method: "GET", path: "/session", family: "session", minimumScope: "viewer" },
  { method: "GET", path: "/session/ses_1", family: "session", minimumScope: "viewer" },
  { method: "GET", path: "/session/ses_1/message", family: "session", minimumScope: "viewer" },
  { method: "GET", path: "/session/ses_1/todo", family: "session", minimumScope: "viewer" },
] as const;

const COLLABORATOR_WRITES: readonly AllowedCase[] = [
  { method: "POST", path: "/session", family: "session", minimumScope: "collaborator" },
  { method: "PATCH", path: "/session/ses_1", family: "session", minimumScope: "collaborator" },
  { method: "DELETE", path: "/session/ses_1", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/prompt_async", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/command", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/shell", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/revert", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/fork", family: "session", minimumScope: "collaborator" },
  { method: "POST", path: "/session/ses_1/abort", family: "session", minimumScope: "collaborator" },
  { method: "PUT", path: "/auth/anthropic", family: "provider", minimumScope: "collaborator" },
  { method: "DELETE", path: "/auth/anthropic", family: "provider", minimumScope: "collaborator" },
  { method: "POST", path: "/provider/anthropic/oauth/authorize", family: "provider", minimumScope: "collaborator" },
  { method: "POST", path: "/provider/anthropic/oauth/callback", family: "provider", minimumScope: "collaborator" },
  { method: "POST", path: "/mcp/github/connect", family: "mcp", minimumScope: "collaborator" },
  { method: "POST", path: "/mcp/github/disconnect", family: "mcp", minimumScope: "collaborator" },
  { method: "POST", path: "/mcp/github/auth", family: "mcp", minimumScope: "collaborator" },
  { method: "DELETE", path: "/mcp/github/auth", family: "mcp", minimumScope: "collaborator" },
  { method: "POST", path: "/mcp/github/auth/callback", family: "mcp", minimumScope: "collaborator" },
  { method: "POST", path: "/mcp/github/auth/authenticate", family: "mcp", minimumScope: "collaborator" },
  { method: "POST", path: "/permission/req_1/reply", family: "interaction", minimumScope: "collaborator" },
  { method: "POST", path: "/api/session/ses_1/permission/req_1/reply", family: "interaction", minimumScope: "collaborator" },
  { method: "POST", path: "/question/req_1/reply", family: "interaction", minimumScope: "collaborator" },
  { method: "POST", path: "/instance/dispose", family: "engine-instance", minimumScope: "collaborator" },
] as const;

describe("decideLocalOpencodeProxy allowlist", () => {
  for (const entry of [...VIEWER_READS, ...COLLABORATOR_WRITES]) {
    test(`allows ${entry.method} ${entry.path}`, () => {
      const decision = decideLocalOpencodeProxy(entry.method, entry.path);
      expect(decision).toMatchObject({
        allowed: true,
        method: entry.method,
        canonicalPath: entry.canonicalPath ?? entry.path,
        family: entry.family,
        minimumScope: entry.minimumScope,
      });
    });
  }

  test("normalizes method case and safe single-encoded path segments", () => {
    expect(decideLocalOpencodeProxy("post", "/opencode/mcp/my%20server/connect")).toMatchObject({
      allowed: true,
      method: "POST",
      canonicalPath: "/mcp/my%20server/connect",
      family: "mcp",
      minimumScope: "collaborator",
    });
  });

  test("blocks only the exact normalized cloud MCP name", () => {
    expect(decideLocalOpencodeProxy("POST", "/mcp/openwork-cloud-extra/connect")).toMatchObject({
      allowed: true,
      family: "mcp",
    });
  });

  test("blocks only OpenWork and lpr_-prefixed provider identities", () => {
    expect(decideLocalOpencodeProxy("PUT", "/auth/vendor-lpr_model")).toMatchObject({
      allowed: true,
      family: "provider",
    });
  });
});

describe("decideLocalOpencodeProxy deny-by-default behavior", () => {
  const denied: ReadonlyArray<[method: string, path: string]> = [
    ["POST", "/global/upgrade"],
    ["POST", "/global/dispose"],
    ["GET", "/global/event"],
    ["GET", "/global/config"],
    ["PATCH", "/global/config"],
    ["PATCH", "/config"],
    ["POST", "/mcp"],
    ["GET", "/lsp"],
    ["GET", "/vcs"],
    ["GET", "/project"],
    ["GET", "/skill"],
    ["GET", "/file"],
    ["GET", "/file/content"],
    ["GET", "/file/status"],
    ["GET", "/session/status"],
    ["POST", "/session/ses_1/unrevert"],
    ["POST", "/session/ses_1/summarize"],
    ["POST", "/session/ses_1/share"],
    ["DELETE", "/session/ses_1/share"],
    ["POST", "/question/req_1/reject"],
    ["POST", "/experimental/control-plane/move-session"],
    ["POST", "/experimental/console/switch"],
    ["POST", "/experimental/worktree"],
    ["POST", "/sync/start"],
    ["POST", "/tui/submit-prompt"],
    ["POST", "/api/integration/github/connect/oauth"],
    ["DELETE", "/api/credential/cred_1"],
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/assets/app.js"],
    ["GET", "/global/health/extra"],
    ["HEAD", "/global/health"],
    ["POST", "/global/health"],
    ["GET", "/session/ses_1/diff"],
    ["GET", "/session/ses_1/message/msg_1"],
  ];

  for (const [method, path] of denied) {
    test(`denies ${method} ${path}`, () => {
      const decision = decideLocalOpencodeProxy(method, path);
      expect(decision).toMatchObject({
        allowed: false,
        status: 404,
        code: "opencode_proxy_not_allowed",
      });
    });
  }

  test("distinguishes an unsupported method on a known path", () => {
    expect(decideLocalOpencodeProxy("TRACE", "/global/health")).toEqual({
      allowed: false,
      status: 404,
      code: "opencode_proxy_not_allowed",
      reason: "method_not_allowed",
      canonicalPath: "/global/health",
    });
  });

  test("distinguishes an unknown path", () => {
    expect(decideLocalOpencodeProxy("GET", "/not-an-engine-api")).toEqual({
      allowed: false,
      status: 404,
      code: "opencode_proxy_not_allowed",
      reason: "path_not_allowlisted",
      canonicalPath: "/not-an-engine-api",
    });
  });
});

describe("decideLocalOpencodeProxy disabled identities", () => {
  const disabledProviders: ReadonlyArray<[method: string, path: string]> = [
    ["PUT", "/auth/openwork"],
    ["DELETE", "/auth/OPENWORK"],
    ["PUT", "/auth/%6fpenwork"],
    ["PUT", "/auth/%20openwork%20"],
    ["PUT", "/auth/lpr_model"],
    ["DELETE", "/auth/LPR_MODEL"],
    ["POST", "/provider/openwork/oauth/authorize"],
    ["POST", "/provider/lpr_%66oo/oauth/callback"],
  ];

  for (const [method, path] of disabledProviders) {
    test(`denies disabled provider via ${method} ${path}`, () => {
      expect(decideLocalOpencodeProxy(method, path)).toMatchObject({
        allowed: false,
        status: 404,
        code: "feature_disabled",
        reason: "provider_disabled",
      });
    });
  }

  const disabledCloudMcp: ReadonlyArray<[method: string, path: string]> = [
    ["POST", "/mcp/openwork-cloud/connect"],
    ["POST", "/mcp/OPENWORK-CLOUD/disconnect"],
    ["POST", "/mcp/%6fpenwork-cloud/auth"],
    ["DELETE", "/mcp/%20openwork-cloud%20/auth"],
    ["POST", "/mcp/openwork-cloud/auth/callback"],
    ["POST", "/mcp/openwork-cloud/auth/authenticate"],
  ];

  for (const [method, path] of disabledCloudMcp) {
    test(`denies disabled MCP via ${method} ${path}`, () => {
      expect(decideLocalOpencodeProxy(method, path)).toMatchObject({
        allowed: false,
        status: 404,
        code: "feature_disabled",
        reason: "mcp_disabled",
      });
    });
  }
});

describe("decideLocalOpencodeProxy path canonicalization", () => {
  const malformed: ReadonlyArray<
    [path: string, reason: LocalOpencodeProxyDeniedReason]
  > = [
    ["", "empty_path"],
    ["global/health", "path_must_be_absolute"],
    [" /global/health", "path_contains_whitespace_padding"],
    ["/global/health ", "path_contains_whitespace_padding"],
    ["/global/health?probe=true", "path_contains_query_or_fragment"],
    ["/global/health#fragment", "path_contains_query_or_fragment"],
    ["/global\\health", "path_contains_backslash"],
    [`/global\u0000/health`, "path_contains_nul"],
    ["/global//health", "path_contains_repeated_slash"],
    ["/opencode//global/health", "path_contains_repeated_slash"],
    ["/global/health/", "path_contains_trailing_slash"],
    ["/global/%", "path_contains_malformed_encoding"],
    ["/global/%E0%A4%A", "path_contains_malformed_encoding"],
    ["/global%252fhealth", "path_contains_ambiguous_encoding"],
    ["/global%252Fhealth", "path_contains_ambiguous_encoding"],
    ["/global%255chealth", "path_contains_ambiguous_encoding"],
    ["/%252e%252e/global/health", "path_contains_ambiguous_encoding"],
    ["/global%2fhealth", "path_contains_encoded_separator"],
    ["/global%5chealth", "path_contains_encoded_separator"],
    ["/%2e/global/health", "path_contains_dot_segment"],
    ["/%2e%2e/global/health", "path_contains_dot_segment"],
    ["/global/%00health", "path_contains_control_character"],
    ["/global/%1fhealth", "path_contains_control_character"],
  ];

  for (const [path, reason] of malformed) {
    test(`rejects malformed path ${JSON.stringify(path)}`, () => {
      expect(decideLocalOpencodeProxy("GET", path)).toEqual({
        allowed: false,
        status: 400,
        code: "opencode_proxy_invalid_path",
        reason,
      });
    });
  }

  test("does not strip a lookalike proxy prefix", () => {
    expect(decideLocalOpencodeProxy("GET", "/opencodex/global/health")).toEqual({
      allowed: false,
      status: 404,
      code: "opencode_proxy_not_allowed",
      reason: "path_not_allowlisted",
      canonicalPath: "/opencodex/global/health",
    });
  });
});
