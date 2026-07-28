import { describe, expect, test } from "bun:test";

import {
  assertLocalCorsRequestAllowed,
  decideLocalCorsRequest,
  LOCAL_CORS_ALLOWED_METHODS,
  LOCAL_CORS_ALLOWED_REQUEST_HEADERS,
  LocalCorsPolicyError,
  type LocalCorsDeniedReason,
  type LocalCorsRequestInput,
} from "./cors-policy.js";

const DESKTOP_ORIGIN = "http://localhost:5173";
const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";
const ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "x-openwork-host-token",
  "x-openwork-client-id",
  "x-opencode-directory",
  "x-agencyai-desktop-approval",
].join(", ");
const VARY_PREFLIGHT =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

function request(
  overrides: Partial<LocalCorsRequestInput> = {},
): LocalCorsRequestInput {
  return {
    configuredOrigin: DESKTOP_ORIGIN,
    requestMethod: "GET",
    origin: DESKTOP_ORIGIN,
    ...overrides,
  };
}

describe("local CORS reviewed contract", () => {
  test("exports only the reviewed preflight methods", () => {
    expect(LOCAL_CORS_ALLOWED_METHODS).toEqual([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
  });

  test("exports only the reviewed lower-case request headers", () => {
    expect(LOCAL_CORS_ALLOWED_REQUEST_HEADERS).toEqual([
      "authorization",
      "content-type",
      "x-openwork-host-token",
      "x-openwork-client-id",
      "x-opencode-directory",
      "x-agencyai-desktop-approval",
    ]);
  });
});

describe("decideLocalCorsRequest ordinary requests", () => {
  test("classifies the one exact configured origin as desktop", () => {
    expect(decideLocalCorsRequest(request())).toEqual({
      allowed: true,
      classification: "desktop",
      isDesktopRequest: true,
      isPreflight: false,
      origin: DESKTOP_ORIGIN,
      requestedMethod: null,
      requestedHeaders: [],
      responseHeaders: {
        Vary: "Origin",
        "Access-Control-Allow-Origin": DESKTOP_ORIGIN,
      },
    });
  });

  test("supports the exact custom renderer origin used by desktop builds", () => {
    const origin = "agencyai://renderer";
    expect(
      decideLocalCorsRequest(
        request({
          configuredOrigin: origin,
          origin,
        }),
      ),
    ).toMatchObject({
      allowed: true,
      classification: "desktop",
      isDesktopRequest: true,
      responseHeaders: {
        Vary: "Origin",
        "Access-Control-Allow-Origin": origin,
      },
    });
  });

  test("allows a missing Origin as ordinary API traffic, never desktop", () => {
    expect(
      decideLocalCorsRequest(
        request({
          configuredOrigin: null,
          requestMethod: "POST",
          origin: null,
        }),
      ),
    ).toEqual({
      allowed: true,
      classification: "ordinary-api",
      isDesktopRequest: false,
      isPreflight: false,
      origin: null,
      requestedMethod: null,
      requestedHeaders: [],
      responseHeaders: { Vary: "Origin" },
    });
  });

  const deniedOrigins: ReadonlyArray<
    [origin: string, reason: LocalCorsDeniedReason]
  > = [
    ["null", "opaque_origin_denied"],
    ["*", "wildcard_origin_denied"],
    ["http://localhost.evil.test:5173", "origin_not_allowed"],
    ["http://localhost:51730", "origin_not_allowed"],
    ["http://127.0.0.1:5173", "origin_not_allowed"],
    ["https://localhost:5173", "origin_not_allowed"],
    ["http://LOCALHOST:5173", "origin_not_allowed"],
    ["http://localhost:5173/", "origin_not_allowed"],
    ["http://localhost@evil.test:5173", "origin_not_allowed"],
    ["http://evil.test/?next=http://localhost:5173", "origin_not_allowed"],
  ];

  for (const [origin, reason] of deniedOrigins) {
    test(`rejects supplied origin ${origin}`, () => {
      expect(
        decideLocalCorsRequest(request({ origin })),
      ).toEqual({
        allowed: false,
        status: 403,
        code: "cors_origin_denied",
        reason,
        isPreflight: false,
        origin,
        responseHeaders: { Vary: "Origin" },
      });
    });
  }

  const invalidConfiguredOrigins: ReadonlyArray<
    string | null | undefined
  > = [
    null,
    undefined,
    "",
    "*",
    "null",
    "NULL",
    " http://localhost:5173",
    "http://localhost:5173 ",
    "http://localhost:5173,https://example.test",
    "http://localhost:5173\n",
  ];

  for (const configuredOrigin of invalidConfiguredOrigins) {
    test(`does not reflect invalid configured origin ${JSON.stringify(configuredOrigin)}`, () => {
      const origin = configuredOrigin ?? DESKTOP_ORIGIN;
      expect(
        decideLocalCorsRequest(
          request({
            configuredOrigin,
            origin,
          }),
        ),
      ).toEqual({
        allowed: false,
        status: 403,
        code: "cors_origin_denied",
        reason: "desktop_origin_not_configured",
        isPreflight: false,
        origin,
        responseHeaders: { Vary: "Origin" },
      });
    });
  }

  test("rejects a mismatched origin before inspecting preflight metadata", () => {
    expect(
      decideLocalCorsRequest(
        request({
          requestMethod: "OPTIONS",
          origin: "https://evil.test",
          accessControlRequestMethod: "CONNECT",
          accessControlRequestHeaders: "x-evil",
        }),
      ),
    ).toEqual({
      allowed: false,
      status: 403,
      code: "cors_origin_denied",
      reason: "origin_not_allowed",
      isPreflight: true,
      origin: "https://evil.test",
      responseHeaders: { Vary: VARY_PREFLIGHT },
    });
  });
});

describe("decideLocalCorsRequest preflight", () => {
  for (const method of LOCAL_CORS_ALLOWED_METHODS) {
    test(`allows reviewed method ${method}`, () => {
      expect(
        decideLocalCorsRequest(
          request({
            requestMethod: "OPTIONS",
            accessControlRequestMethod: method,
          }),
        ),
      ).toEqual({
        allowed: true,
        classification: "desktop-preflight",
        isDesktopRequest: true,
        isPreflight: true,
        origin: DESKTOP_ORIGIN,
        requestedMethod: method,
        requestedHeaders: [],
        responseHeaders: {
          Vary: VARY_PREFLIGHT,
          "Access-Control-Allow-Origin": DESKTOP_ORIGIN,
          "Access-Control-Allow-Methods": ALLOW_METHODS,
          "Access-Control-Allow-Headers": ALLOW_HEADERS,
        },
      });
    });
  }

  for (const header of LOCAL_CORS_ALLOWED_REQUEST_HEADERS) {
    test(`allows reviewed request header ${header}`, () => {
      expect(
        decideLocalCorsRequest(
          request({
            requestMethod: "OPTIONS",
            accessControlRequestMethod: "POST",
            accessControlRequestHeaders: header.toUpperCase(),
          }),
        ),
      ).toMatchObject({
        allowed: true,
        requestedHeaders: [header],
      });
    });
  }

  test("normalizes, de-duplicates, and returns reviewed requested headers", () => {
    const requestedHeaders =
      "Authorization, Content-Type, X-OpenWork-Host-Token, " +
      "X-OpenWork-Client-Id, X-OpenCode-Directory, " +
      "X-AgencyAI-Desktop-Approval, authorization";
    expect(
      decideLocalCorsRequest(
        request({
          requestMethod: "options",
          accessControlRequestMethod: "PATCH",
          accessControlRequestHeaders: requestedHeaders,
        }),
      ),
    ).toMatchObject({
      allowed: true,
      classification: "desktop-preflight",
      requestedMethod: "PATCH",
      requestedHeaders: [...LOCAL_CORS_ALLOWED_REQUEST_HEADERS],
      responseHeaders: {
        Vary: VARY_PREFLIGHT,
        "Access-Control-Allow-Origin": DESKTOP_ORIGIN,
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
      },
    });
  });

  test("requires Origin for OPTIONS even when other metadata is valid", () => {
    expect(
      decideLocalCorsRequest(
        request({
          requestMethod: "OPTIONS",
          origin: null,
          accessControlRequestMethod: "GET",
        }),
      ),
    ).toEqual({
      allowed: false,
      status: 403,
      code: "cors_preflight_denied",
      reason: "preflight_origin_required",
      isPreflight: true,
      origin: null,
      responseHeaders: { Vary: VARY_PREFLIGHT },
    });
  });

  for (const accessControlRequestMethod of [null, undefined, ""] as const) {
    test(`requires requested method ${JSON.stringify(accessControlRequestMethod)}`, () => {
      expect(
        decideLocalCorsRequest(
          request({
            requestMethod: "OPTIONS",
            accessControlRequestMethod,
          }),
        ),
      ).toMatchObject({
        allowed: false,
        code: "cors_preflight_denied",
        reason: "preflight_method_required",
      });
    });
  }

  for (const accessControlRequestMethod of [
    "OPTIONS",
    "CONNECT",
    "TRACE",
    "get",
    " GET ",
    "GET,POST",
  ]) {
    test(`rejects requested method ${JSON.stringify(accessControlRequestMethod)}`, () => {
      expect(
        decideLocalCorsRequest(
          request({
            requestMethod: "OPTIONS",
            accessControlRequestMethod,
          }),
        ),
      ).toMatchObject({
        allowed: false,
        code: "cors_preflight_denied",
        reason: "preflight_method_not_allowed",
        requestedMethod: accessControlRequestMethod,
      });
    });
  }

  const rejectedHeaders: ReadonlyArray<
    [
      headers: string,
      reason: LocalCorsDeniedReason,
      rejectedHeader: string,
    ]
  > = [
    ["x-unknown", "preflight_header_not_allowed", "x-unknown"],
    [
      "authorization, x-evil",
      "preflight_header_not_allowed",
      "x-evil",
    ],
    ["*", "preflight_header_not_allowed", "*"],
    [
      "authorization,,content-type",
      "preflight_headers_malformed",
      "",
    ],
    [",authorization", "preflight_headers_malformed", ""],
    ["bad header", "preflight_headers_malformed", "bad header"],
    ["authorization, ", "preflight_headers_malformed", " "],
  ];

  for (const [headers, reason, rejectedHeader] of rejectedHeaders) {
    test(`rejects requested headers ${JSON.stringify(headers)}`, () => {
      expect(
        decideLocalCorsRequest(
          request({
            requestMethod: "OPTIONS",
            accessControlRequestMethod: "POST",
            accessControlRequestHeaders: headers,
          }),
        ),
      ).toMatchObject({
        allowed: false,
        status: 403,
        code: "cors_preflight_denied",
        reason,
        rejectedHeader,
        responseHeaders: { Vary: VARY_PREFLIGHT },
      });
    });
  }
});

describe("assertLocalCorsRequestAllowed", () => {
  test("returns the allowed decision", () => {
    expect(assertLocalCorsRequestAllowed(request())).toMatchObject({
      allowed: true,
      classification: "desktop",
    });
  });

  test("throws a typed policy error containing the denial decision", () => {
    try {
      assertLocalCorsRequestAllowed(
        request({ origin: "https://not-desktop.test" }),
      );
      throw new Error("expected assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalCorsPolicyError);
      const policyError = error as LocalCorsPolicyError;
      expect(policyError).toMatchObject({
        name: "LocalCorsPolicyError",
        message: "CORS request denied: origin_not_allowed",
        status: 403,
        code: "cors_origin_denied",
        reason: "origin_not_allowed",
      });
      expect(policyError.decision.responseHeaders).toEqual({
        Vary: "Origin",
      });
    }
  });
});
