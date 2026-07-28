import type { TokenScope } from "./types.js";

export type LocalOpencodeProxyFamily =
  | "health"
  | "events"
  | "config-read"
  | "provider"
  | "mcp"
  | "project-read"
  | "file-read"
  | "session"
  | "interaction"
  | "engine-instance";

export type LocalOpencodeProxyDeniedReason =
  | "empty_path"
  | "path_must_be_absolute"
  | "path_contains_whitespace_padding"
  | "path_contains_query_or_fragment"
  | "path_contains_backslash"
  | "path_contains_nul"
  | "path_contains_repeated_slash"
  | "path_contains_trailing_slash"
  | "path_contains_malformed_encoding"
  | "path_contains_ambiguous_encoding"
  | "path_contains_encoded_separator"
  | "path_contains_dot_segment"
  | "path_contains_control_character"
  | "method_not_allowed"
  | "path_not_allowlisted"
  | "provider_disabled"
  | "mcp_disabled";

export type LocalOpencodeProxyDecision =
  | {
      allowed: true;
      method: string;
      canonicalPath: string;
      family: LocalOpencodeProxyFamily;
      minimumScope: TokenScope;
      ruleId: string;
    }
  | {
      allowed: false;
      status: 400 | 404;
      code:
        | "opencode_proxy_invalid_path"
        | "opencode_proxy_not_allowed"
        | "feature_disabled";
      reason: LocalOpencodeProxyDeniedReason;
      canonicalPath?: string;
    };

type RuleRejection = {
  reason: "provider_disabled" | "mcp_disabled";
};

type LocalOpencodeProxyRule = {
  id: string;
  methods: readonly string[];
  pattern: RegExp;
  family: LocalOpencodeProxyFamily;
  minimumScope: TokenScope;
  validateMatch?: (match: RegExpExecArray) => RuleRejection | null;
};

type CanonicalPathResult =
  | {
      ok: true;
      canonicalPath: string;
      decodedPath: string;
    }
  | {
      ok: false;
      reason: Exclude<
        LocalOpencodeProxyDeniedReason,
        | "method_not_allowed"
        | "path_not_allowlisted"
        | "provider_disabled"
        | "mcp_disabled"
      >;
    };

const VIEWER: TokenScope = "viewer";
const COLLABORATOR: TokenScope = "collaborator";

function normalizeRestrictedIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function validateProviderMatch(match: RegExpExecArray): RuleRejection | null {
  const providerId = normalizeRestrictedIdentity(match[1] ?? "");
  if (providerId === "openwork" || providerId.startsWith("lpr_")) {
    return { reason: "provider_disabled" };
  }
  return null;
}

function validateMcpMatch(match: RegExpExecArray): RuleRejection | null {
  const mcpName = normalizeRestrictedIdentity(match[1] ?? "");
  if (mcpName === "openwork-cloud") {
    return { reason: "mcp_disabled" };
  }
  return null;
}

const LOCAL_OPENCODE_PROXY_RULES: readonly LocalOpencodeProxyRule[] =
  Object.freeze([
    {
      id: "global-health",
      methods: ["GET"],
      pattern: /^\/global\/health$/,
      family: "health",
      minimumScope: VIEWER,
    },
    {
      id: "workspace-events",
      methods: ["GET"],
      pattern: /^\/event$/,
      family: "events",
      minimumScope: VIEWER,
    },
    {
      id: "config-read",
      methods: ["GET"],
      pattern: /^\/config$/,
      family: "config-read",
      minimumScope: VIEWER,
    },
    {
      id: "provider-list",
      methods: ["GET"],
      pattern: /^\/provider$/,
      family: "provider",
      minimumScope: VIEWER,
    },
    {
      id: "provider-auth-methods",
      methods: ["GET"],
      pattern: /^\/provider\/auth$/,
      family: "provider",
      minimumScope: VIEWER,
    },
    {
      id: "mcp-status",
      methods: ["GET"],
      pattern: /^\/mcp$/,
      family: "mcp",
      minimumScope: VIEWER,
    },
    {
      id: "engine-paths",
      methods: ["GET"],
      pattern: /^\/path$/,
      family: "project-read",
      minimumScope: VIEWER,
    },
    {
      id: "agent-list",
      methods: ["GET"],
      pattern: /^\/agent$/,
      family: "project-read",
      minimumScope: VIEWER,
    },
    {
      id: "command-list",
      methods: ["GET"],
      pattern: /^\/command$/,
      family: "project-read",
      minimumScope: VIEWER,
    },
    {
      id: "file-search",
      methods: ["GET"],
      pattern: /^\/find\/file$/,
      family: "file-read",
      minimumScope: VIEWER,
    },
    {
      id: "permission-list",
      methods: ["GET"],
      pattern: /^\/permission$/,
      family: "interaction",
      minimumScope: VIEWER,
    },
    {
      id: "question-list",
      methods: ["GET"],
      pattern: /^\/question$/,
      family: "interaction",
      minimumScope: VIEWER,
    },
    {
      id: "session-permission-list-v2",
      methods: ["GET"],
      pattern: /^\/api\/session\/[^/]+\/permission$/,
      family: "interaction",
      minimumScope: VIEWER,
    },
    {
      id: "session-list",
      methods: ["GET"],
      pattern: /^\/session$/,
      family: "session",
      minimumScope: VIEWER,
    },
    {
      id: "session-read",
      methods: ["GET"],
      pattern: /^\/session\/(?!status(?:\/|$))[^/]+(?:\/(?:message|todo))?$/,
      family: "session",
      minimumScope: VIEWER,
    },
    {
      id: "session-create",
      methods: ["POST"],
      pattern: /^\/session$/,
      family: "session",
      minimumScope: COLLABORATOR,
    },
    {
      id: "session-metadata-write",
      methods: ["PATCH", "DELETE"],
      pattern: /^\/session\/[^/]+$/,
      family: "session",
      minimumScope: COLLABORATOR,
    },
    {
      id: "session-action",
      methods: ["POST"],
      pattern:
        /^\/session\/[^/]+\/(?:prompt_async|command|shell|revert|fork|abort)$/,
      family: "session",
      minimumScope: COLLABORATOR,
    },
    {
      id: "provider-key-auth",
      methods: ["PUT", "DELETE"],
      pattern: /^\/auth\/([^/]+)$/,
      family: "provider",
      minimumScope: COLLABORATOR,
      validateMatch: validateProviderMatch,
    },
    {
      id: "provider-oauth",
      methods: ["POST"],
      pattern: /^\/provider\/([^/]+)\/oauth\/(?:authorize|callback)$/,
      family: "provider",
      minimumScope: COLLABORATOR,
      validateMatch: validateProviderMatch,
    },
    {
      id: "mcp-lifecycle",
      methods: ["POST"],
      pattern: /^\/mcp\/([^/]+)\/(?:connect|disconnect)$/,
      family: "mcp",
      minimumScope: COLLABORATOR,
      validateMatch: validateMcpMatch,
    },
    {
      id: "mcp-auth",
      methods: ["POST", "DELETE"],
      pattern: /^\/mcp\/([^/]+)\/auth$/,
      family: "mcp",
      minimumScope: COLLABORATOR,
      validateMatch: validateMcpMatch,
    },
    {
      id: "mcp-auth-completion",
      methods: ["POST"],
      pattern: /^\/mcp\/([^/]+)\/auth\/(?:callback|authenticate)$/,
      family: "mcp",
      minimumScope: COLLABORATOR,
      validateMatch: validateMcpMatch,
    },
    {
      id: "permission-reply",
      methods: ["POST"],
      pattern: /^\/permission\/[^/]+\/reply$/,
      family: "interaction",
      minimumScope: COLLABORATOR,
    },
    {
      id: "session-permission-reply-v2",
      methods: ["POST"],
      pattern: /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/,
      family: "interaction",
      minimumScope: COLLABORATOR,
    },
    {
      id: "question-reply",
      methods: ["POST"],
      pattern: /^\/question\/[^/]+\/reply$/,
      family: "interaction",
      minimumScope: COLLABORATOR,
    },
    {
      id: "instance-dispose",
      methods: ["POST"],
      pattern: /^\/instance\/dispose$/,
      family: "engine-instance",
      minimumScope: COLLABORATOR,
    },
  ] satisfies LocalOpencodeProxyRule[]);

function canonicalizeProxyPath(proxyPath: string): CanonicalPathResult {
  if (!proxyPath) return { ok: false, reason: "empty_path" };
  if (proxyPath.trim() !== proxyPath) {
    return { ok: false, reason: "path_contains_whitespace_padding" };
  }
  if (!proxyPath.startsWith("/")) {
    return { ok: false, reason: "path_must_be_absolute" };
  }
  if (proxyPath.includes("?") || proxyPath.includes("#")) {
    return { ok: false, reason: "path_contains_query_or_fragment" };
  }
  if (proxyPath.includes("\\")) {
    return { ok: false, reason: "path_contains_backslash" };
  }
  if (proxyPath.includes("\0")) {
    return { ok: false, reason: "path_contains_nul" };
  }
  if (proxyPath.includes("//")) {
    return { ok: false, reason: "path_contains_repeated_slash" };
  }

  const enginePath =
    proxyPath === "/opencode"
      ? "/"
      : proxyPath.startsWith("/opencode/")
        ? proxyPath.slice("/opencode".length)
        : proxyPath;

  if (enginePath.length > 1 && enginePath.endsWith("/")) {
    return { ok: false, reason: "path_contains_trailing_slash" };
  }

  const rawSegments = enginePath === "/" ? [] : enginePath.slice(1).split("/");
  const decodedSegments: string[] = [];
  const canonicalSegments: string[] = [];

  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return { ok: false, reason: "path_contains_malformed_encoding" };
    }

    // A remaining percent escape would be decoded differently by a downstream
    // router, so reject double-encoded and otherwise ambiguous path segments.
    if (/%[0-9a-f]{2}/i.test(decoded)) {
      return { ok: false, reason: "path_contains_ambiguous_encoding" };
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      return { ok: false, reason: "path_contains_encoded_separator" };
    }
    if (decoded === "." || decoded === "..") {
      return { ok: false, reason: "path_contains_dot_segment" };
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) {
      return { ok: false, reason: "path_contains_control_character" };
    }

    decodedSegments.push(decoded);
    canonicalSegments.push(encodeURIComponent(decoded));
  }

  return {
    ok: true,
    canonicalPath:
      canonicalSegments.length > 0 ? `/${canonicalSegments.join("/")}` : "/",
    decodedPath:
      decodedSegments.length > 0 ? `/${decodedSegments.join("/")}` : "/",
  };
}

export function decideLocalOpencodeProxy(
  method: string,
  proxyPath: string,
): LocalOpencodeProxyDecision {
  const canonical = canonicalizeProxyPath(proxyPath);
  if (!canonical.ok) {
    return {
      allowed: false,
      status: 400,
      code: "opencode_proxy_invalid_path",
      reason: canonical.reason,
    };
  }

  const normalizedMethod = method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalizedMethod)) {
    return {
      allowed: false,
      status: 404,
      code: "opencode_proxy_not_allowed",
      reason: "method_not_allowed",
      canonicalPath: canonical.canonicalPath,
    };
  }

  for (const rule of LOCAL_OPENCODE_PROXY_RULES) {
    if (!rule.methods.includes(normalizedMethod)) continue;
    const match = rule.pattern.exec(canonical.decodedPath);
    if (!match) continue;

    const rejection = rule.validateMatch?.(match) ?? null;
    if (rejection) {
      return {
        allowed: false,
        status: 404,
        code: "feature_disabled",
        reason: rejection.reason,
        canonicalPath: canonical.canonicalPath,
      };
    }

    return {
      allowed: true,
      method: normalizedMethod,
      canonicalPath: canonical.canonicalPath,
      family: rule.family,
      minimumScope: rule.minimumScope,
      ruleId: rule.id,
    };
  }

  const pathHasRule = LOCAL_OPENCODE_PROXY_RULES.some((rule) =>
    rule.pattern.test(canonical.decodedPath),
  );
  return {
    allowed: false,
    status: 404,
    code: "opencode_proxy_not_allowed",
    reason: pathHasRule ? "method_not_allowed" : "path_not_allowlisted",
    canonicalPath: canonical.canonicalPath,
  };
}
