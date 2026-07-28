export const LOCAL_CORS_ALLOWED_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const);

export const LOCAL_CORS_ALLOWED_REQUEST_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "x-openwork-host-token",
  "x-openwork-client-id",
  "x-opencode-directory",
  "x-agencyai-desktop-approval",
] as const);

export type LocalCorsAllowedMethod =
  (typeof LOCAL_CORS_ALLOWED_METHODS)[number];

export type LocalCorsAllowedRequestHeader =
  (typeof LOCAL_CORS_ALLOWED_REQUEST_HEADERS)[number];

export type LocalCorsResponseHeaders = Readonly<{
  Vary: string;
  "Access-Control-Allow-Origin"?: string;
  "Access-Control-Allow-Methods"?: string;
  "Access-Control-Allow-Headers"?: string;
}>;

export type LocalCorsDeniedReason =
  | "desktop_origin_not_configured"
  | "opaque_origin_denied"
  | "wildcard_origin_denied"
  | "origin_not_allowed"
  | "preflight_origin_required"
  | "preflight_method_required"
  | "preflight_method_not_allowed"
  | "preflight_headers_malformed"
  | "preflight_header_not_allowed";

export type LocalCorsRequestInput = Readonly<{
  configuredOrigin: string | null | undefined;
  requestMethod: string;
  origin: string | null;
  accessControlRequestMethod?: string | null;
  accessControlRequestHeaders?: string | null;
}>;

export type LocalCorsAllowedDecision =
  | {
      allowed: true;
      classification: "ordinary-api";
      isDesktopRequest: false;
      isPreflight: false;
      origin: null;
      requestedMethod: null;
      requestedHeaders: readonly [];
      responseHeaders: LocalCorsResponseHeaders;
    }
  | {
      allowed: true;
      classification: "desktop";
      isDesktopRequest: true;
      isPreflight: false;
      origin: string;
      requestedMethod: null;
      requestedHeaders: readonly [];
      responseHeaders: LocalCorsResponseHeaders;
    }
  | {
      allowed: true;
      classification: "desktop-preflight";
      isDesktopRequest: true;
      isPreflight: true;
      origin: string;
      requestedMethod: LocalCorsAllowedMethod;
      requestedHeaders: readonly LocalCorsAllowedRequestHeader[];
      responseHeaders: LocalCorsResponseHeaders;
    };

export type LocalCorsDeniedDecision = {
  allowed: false;
  status: 403;
  code: "cors_origin_denied" | "cors_preflight_denied";
  reason: LocalCorsDeniedReason;
  isPreflight: boolean;
  origin: string | null;
  requestedMethod?: string;
  rejectedHeader?: string;
  responseHeaders: LocalCorsResponseHeaders;
};

export type LocalCorsDecision =
  | LocalCorsAllowedDecision
  | LocalCorsDeniedDecision;

const VARY_ORIGIN = "Origin";
const VARY_PREFLIGHT =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
const ALLOW_METHODS = LOCAL_CORS_ALLOWED_METHODS.join(", ");
const ALLOW_HEADERS = LOCAL_CORS_ALLOWED_REQUEST_HEADERS.join(", ");
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const ALLOWED_METHODS = new Set<string>(LOCAL_CORS_ALLOWED_METHODS);
const ALLOWED_HEADERS = new Set<string>(LOCAL_CORS_ALLOWED_REQUEST_HEADERS);

function isExactConfiguredOrigin(
  configuredOrigin: string | null | undefined,
): configuredOrigin is string {
  if (!configuredOrigin) return false;
  if (configuredOrigin === "*" || configuredOrigin.toLowerCase() === "null") {
    return false;
  }
  if (configuredOrigin.trim() !== configuredOrigin) return false;
  if (/[\s,\u0000-\u001f\u007f]/.test(configuredOrigin)) return false;
  return true;
}

function responseHeaders(
  isPreflight: boolean,
  allowedOrigin?: string,
): LocalCorsResponseHeaders {
  if (!allowedOrigin) {
    return Object.freeze({
      Vary: isPreflight ? VARY_PREFLIGHT : VARY_ORIGIN,
    });
  }
  if (!isPreflight) {
    return Object.freeze({
      Vary: VARY_ORIGIN,
      "Access-Control-Allow-Origin": allowedOrigin,
    });
  }
  return Object.freeze({
    Vary: VARY_PREFLIGHT,
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
  });
}

function deny(
  input: {
    reason: LocalCorsDeniedReason;
    isPreflight: boolean;
    origin: string | null;
    requestedMethod?: string;
    rejectedHeader?: string;
  },
): LocalCorsDeniedDecision {
  const preflightReason = input.reason.startsWith("preflight_");
  return {
    allowed: false,
    status: 403,
    code: preflightReason ? "cors_preflight_denied" : "cors_origin_denied",
    reason: input.reason,
    isPreflight: input.isPreflight,
    origin: input.origin,
    ...(input.requestedMethod === undefined
      ? {}
      : { requestedMethod: input.requestedMethod }),
    ...(input.rejectedHeader === undefined
      ? {}
      : { rejectedHeader: input.rejectedHeader }),
    responseHeaders: responseHeaders(input.isPreflight),
  };
}

type ParsedRequestedHeaders =
  | {
      ok: true;
      headers: readonly LocalCorsAllowedRequestHeader[];
    }
  | {
      ok: false;
      reason:
        | "preflight_headers_malformed"
        | "preflight_header_not_allowed";
      rejectedHeader: string;
    };

function parseRequestedHeaders(
  value: string | null | undefined,
): ParsedRequestedHeaders {
  if (value == null || value.trim() === "") {
    return { ok: true, headers: [] };
  }

  const normalizedHeaders: LocalCorsAllowedRequestHeader[] = [];
  const seen = new Set<LocalCorsAllowedRequestHeader>();
  for (const part of value.split(",")) {
    const header = part.trim().toLowerCase();
    if (!header || !HEADER_NAME_PATTERN.test(header)) {
      return {
        ok: false,
        reason: "preflight_headers_malformed",
        rejectedHeader: header || part,
      };
    }
    if (!ALLOWED_HEADERS.has(header)) {
      return {
        ok: false,
        reason: "preflight_header_not_allowed",
        rejectedHeader: header,
      };
    }
    const allowedHeader = header as LocalCorsAllowedRequestHeader;
    if (!seen.has(allowedHeader)) {
      seen.add(allowedHeader);
      normalizedHeaders.push(allowedHeader);
    }
  }

  return { ok: true, headers: Object.freeze(normalizedHeaders) };
}

export function decideLocalCorsRequest(
  input: LocalCorsRequestInput,
): LocalCorsDecision {
  const normalizedRequestMethod = input.requestMethod.trim().toUpperCase();
  const isPreflight = normalizedRequestMethod === "OPTIONS";
  const origin = input.origin;

  if (origin === null) {
    if (isPreflight) {
      return deny({
        reason: "preflight_origin_required",
        isPreflight: true,
        origin,
      });
    }
    return {
      allowed: true,
      classification: "ordinary-api",
      isDesktopRequest: false,
      isPreflight: false,
      origin: null,
      requestedMethod: null,
      requestedHeaders: [],
      responseHeaders: responseHeaders(false),
    };
  }

  if (!isExactConfiguredOrigin(input.configuredOrigin)) {
    return deny({
      reason: "desktop_origin_not_configured",
      isPreflight,
      origin,
    });
  }
  if (origin === "null") {
    return deny({
      reason: "opaque_origin_denied",
      isPreflight,
      origin,
    });
  }
  if (origin === "*") {
    return deny({
      reason: "wildcard_origin_denied",
      isPreflight,
      origin,
    });
  }
  if (origin !== input.configuredOrigin) {
    return deny({
      reason: "origin_not_allowed",
      isPreflight,
      origin,
    });
  }

  if (!isPreflight) {
    return {
      allowed: true,
      classification: "desktop",
      isDesktopRequest: true,
      isPreflight: false,
      origin,
      requestedMethod: null,
      requestedHeaders: [],
      responseHeaders: responseHeaders(false, origin),
    };
  }

  const requestedMethod = input.accessControlRequestMethod;
  if (requestedMethod == null || requestedMethod === "") {
    return deny({
      reason: "preflight_method_required",
      isPreflight: true,
      origin,
    });
  }
  if (
    requestedMethod.trim() !== requestedMethod ||
    !ALLOWED_METHODS.has(requestedMethod)
  ) {
    return deny({
      reason: "preflight_method_not_allowed",
      isPreflight: true,
      origin,
      requestedMethod,
    });
  }

  const requestedHeaders = parseRequestedHeaders(
    input.accessControlRequestHeaders,
  );
  if (!requestedHeaders.ok) {
    return deny({
      reason: requestedHeaders.reason,
      isPreflight: true,
      origin,
      requestedMethod,
      rejectedHeader: requestedHeaders.rejectedHeader,
    });
  }

  return {
    allowed: true,
    classification: "desktop-preflight",
    isDesktopRequest: true,
    isPreflight: true,
    origin,
    requestedMethod: requestedMethod as LocalCorsAllowedMethod,
    requestedHeaders: requestedHeaders.headers,
    responseHeaders: responseHeaders(true, origin),
  };
}

export class LocalCorsPolicyError extends Error {
  readonly status: LocalCorsDeniedDecision["status"];
  readonly code: LocalCorsDeniedDecision["code"];
  readonly reason: LocalCorsDeniedReason;
  readonly decision: LocalCorsDeniedDecision;

  constructor(decision: LocalCorsDeniedDecision) {
    super(`CORS request denied: ${decision.reason}`);
    this.name = "LocalCorsPolicyError";
    this.status = decision.status;
    this.code = decision.code;
    this.reason = decision.reason;
    this.decision = decision;
  }
}

export function assertLocalCorsRequestAllowed(
  input: LocalCorsRequestInput,
): LocalCorsAllowedDecision {
  const decision = decideLocalCorsRequest(input);
  if (!decision.allowed) throw new LocalCorsPolicyError(decision);
  return decision;
}
