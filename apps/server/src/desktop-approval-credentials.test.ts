import { describe, expect, test } from "bun:test";

import {
  AGENCYAI_DESKTOP_APPROVAL_HEADER,
  DEFAULT_DESKTOP_APPROVAL_CREDENTIAL_TTL_MS,
  DesktopApprovalCredentialError,
  DesktopApprovalCredentialService,
  TRUSTED_DESKTOP_OPERATIONS,
  type DesktopApprovalCredentialAuthenticationInput,
  type DesktopApprovalCredentialIssueInput,
  type DesktopApprovalCredentialErrorCode,
  type TrustedDesktopOperation,
} from "./desktop-approval-credentials.js";

const RENDERER_ORIGIN = "agencyai-internal://renderer";
const SERVER_ORIGIN = "http://127.0.0.1:48123";

function issueInput(
  overrides: Partial<DesktopApprovalCredentialIssueInput> = {},
): DesktopApprovalCredentialIssueInput {
  return {
    bearerToken: "owner-token",
    rendererOrigin: RENDERER_ORIGIN,
    serverOrigin: SERVER_ORIGIN,
    webContentsId: 17,
    workspaceId: "ws_selected",
    operation: "workspace.file.write",
    ...overrides,
  };
}

function authenticationInput(
  credential: string,
  overrides: Partial<DesktopApprovalCredentialAuthenticationInput> = {},
): DesktopApprovalCredentialAuthenticationInput {
  return {
    credential,
    bearerToken: "owner-token",
    rendererOrigin: RENDERER_ORIGIN,
    serverOrigin: SERVER_ORIGIN,
    workspaceId: "ws_selected",
    operation: "workspace.file.write",
    ...overrides,
  };
}

function expectCredentialError(
  run: () => unknown,
  status: 401 | 403,
  code: DesktopApprovalCredentialErrorCode,
): void {
  try {
    run();
    throw new Error("Expected desktop approval credential authentication to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopApprovalCredentialError);
    expect((error as DesktopApprovalCredentialError).status).toBe(status);
    expect((error as DesktopApprovalCredentialError).code).toBe(code);
  }
}

describe("DesktopApprovalCredentialService", () => {
  test("exports the exact transport header and reviewed operation set", () => {
    expect(AGENCYAI_DESKTOP_APPROVAL_HEADER).toBe("X-AgencyAI-Desktop-Approval");
    expect(TRUSTED_DESKTOP_OPERATIONS).toContain("workspace.file.write");
    expect(TRUSTED_DESKTOP_OPERATIONS).toContain("config.write");
    expect(TRUSTED_DESKTOP_OPERATIONS).not.toContain("config.global.write");
    expect(TRUSTED_DESKTOP_OPERATIONS).not.toContain("mcp.auth.remove");
    expect(TRUSTED_DESKTOP_OPERATIONS).not.toContain(
      "config.authorized_folders.write",
    );
    expect(TRUSTED_DESKTOP_OPERATIONS).not.toContain("plugins.add");
    expect(TRUSTED_DESKTOP_OPERATIONS).not.toContain(
      "workspace.files.session.write",
    );
  });

  test("issues a cryptographically shaped, process-local grant with the default TTL", () => {
    let now = 10_000;
    const service = new DesktopApprovalCredentialService({ now: () => now });

    const first = service.issue(issueInput());
    now += 1;
    const second = service.issue(issueInput());

    expect(first.credential).toMatch(/^aai_da_[A-Za-z0-9_-]{43}$/);
    expect(first.credentialId).toMatch(/^aai_dac_[A-Za-z0-9_-]{22}$/);
    expect(first.credential).not.toBe(second.credential);
    expect(first.credentialId).not.toBe(second.credentialId);
    expect(first.issuedAt).toBe(10_000);
    expect(first.expiresAt).toBe(10_000 + DEFAULT_DESKTOP_APPROVAL_CREDENTIAL_TTL_MS);
    expect(first).toMatchObject({
      serverOrigin: SERVER_ORIGIN,
      workspaceId: "ws_selected",
      operation: "workspace.file.write",
    });
  });

  test("stores only the credential hash and never returns a raw secret in the actor", () => {
    const service = new DesktopApprovalCredentialService();
    const grant = service.issue(issueInput());
    const records = (
      service as unknown as {
        records: Map<string, Record<string, unknown>>;
      }
    ).records;
    const serializedRecords = JSON.stringify([...records.entries()]);

    expect(serializedRecords).not.toContain(grant.credential);
    expect(serializedRecords).toContain("tokenHash");

    const actor = service.authenticateAndConsume(authenticationInput(grant.credential));
    expect(actor).toEqual({
      type: "desktop",
      credentialId: grant.credentialId,
      webContentsId: 17,
      workspaceId: "ws_selected",
      operation: "workspace.file.write",
    });
    expect(actor).not.toHaveProperty("credential");
    expect(actor).not.toHaveProperty("bearerToken");
    expect(actor).not.toHaveProperty("bearerTokenHash");
  });

  test("authenticates exactly once and rejects replay", () => {
    const service = new DesktopApprovalCredentialService();
    const grant = service.issue(issueInput());

    expect(service.authenticateAndConsume(authenticationInput(grant.credential))).toMatchObject({
      type: "desktop",
      credentialId: grant.credentialId,
    });
    expectCredentialError(
      () => service.authenticateAndConsume(authenticationInput(grant.credential)),
      401,
      "desktop_approval_invalid",
    );
  });

  const bindingFailures: Array<{
    name: string;
    authentication: Partial<DesktopApprovalCredentialAuthenticationInput>;
    status: 401 | 403;
    code: DesktopApprovalCredentialErrorCode;
  }> = [
    {
      name: "wrong bearer",
      authentication: { bearerToken: "different-owner-token" },
      status: 401,
      code: "desktop_approval_invalid",
    },
    {
      name: "wrong renderer origin",
      authentication: { rendererOrigin: "agencyai-internal://other-renderer" },
      status: 403,
      code: "desktop_approval_scope_mismatch",
    },
    {
      name: "malformed renderer origin",
      authentication: { rendererOrigin: "not-an-origin" },
      status: 403,
      code: "desktop_approval_scope_mismatch",
    },
    {
      name: "wrong server origin",
      authentication: { serverOrigin: "http://127.0.0.1:48124" },
      status: 403,
      code: "desktop_approval_scope_mismatch",
    },
    {
      name: "wrong workspace",
      authentication: { workspaceId: "ws_other" },
      status: 403,
      code: "desktop_approval_scope_mismatch",
    },
    {
      name: "wrong action",
      authentication: { operation: "mcp.add" },
      status: 403,
      code: "desktop_approval_scope_mismatch",
    },
  ];

  for (const scenario of bindingFailures) {
    test(`fails closed and consumes the grant for ${scenario.name}`, () => {
      const service = new DesktopApprovalCredentialService();
      const grant = service.issue(issueInput());

      expectCredentialError(
        () => service.authenticateAndConsume(
          authenticationInput(grant.credential, scenario.authentication),
        ),
        scenario.status,
        scenario.code,
      );
      expectCredentialError(
        () => service.authenticateAndConsume(authenticationInput(grant.credential)),
        401,
        "desktop_approval_invalid",
      );
    });
  }

  test("rejects malformed and unknown credentials", () => {
    const service = new DesktopApprovalCredentialService();

    for (const credential of ["", "not-a-grant", `aai_da_${"x".repeat(42)}`, `aai_da_${"x".repeat(44)}`]) {
      expectCredentialError(
        () => service.authenticateAndConsume(authenticationInput(credential)),
        401,
        "desktop_approval_invalid",
      );
    }

    expectCredentialError(
      () => service.authenticateAndConsume(
        authenticationInput(`aai_da_${"x".repeat(43)}`),
      ),
      401,
      "desktop_approval_invalid",
    );
  });

  test("uses a configurable TTL and rejects at the exact expiry boundary", () => {
    let now = 500;
    const service = new DesktopApprovalCredentialService({
      ttlMs: 5_000,
      now: () => now,
    });
    const grant = service.issue(issueInput());

    expect(grant.expiresAt).toBe(5_500);
    now = grant.expiresAt;
    expectCredentialError(
      () => service.authenticateAndConsume(authenticationInput(grant.credential)),
      401,
      "desktop_approval_invalid",
    );
  });

  test("revokes every credential for one webContents without affecting another", () => {
    const service = new DesktopApprovalCredentialService();
    const first = service.issue(issueInput({ webContentsId: 17 }));
    const second = service.issue(issueInput({
      webContentsId: 17,
      operation: "mcp.add",
    }));
    const other = service.issue(issueInput({ webContentsId: 18 }));

    expect(service.revokeForWebContents(17)).toBe(2);
    expect(service.revokeForWebContents(17)).toBe(0);
    for (const grant of [first, second]) {
      expectCredentialError(
        () => service.authenticateAndConsume(authenticationInput(grant.credential, {
          operation: grant.operation,
        })),
        401,
        "desktop_approval_invalid",
      );
    }
    expect(service.authenticateAndConsume(authenticationInput(other.credential))).toMatchObject({
      webContentsId: 18,
    });
  });

  test("revokes all outstanding credentials", () => {
    const service = new DesktopApprovalCredentialService();
    const grants = [
      service.issue(issueInput()),
      service.issue(issueInput({ operation: "skills.upsert" })),
    ];

    expect(service.revokeAll()).toBe(2);
    expect(service.revokeAll()).toBe(0);
    for (const grant of grants) {
      expectCredentialError(
        () => service.authenticateAndConsume(authenticationInput(grant.credential, {
          operation: grant.operation,
        })),
        401,
        "desktop_approval_invalid",
      );
    }
  });

  test("rejects unsupported operations at issuance even from untyped callers", () => {
    const service = new DesktopApprovalCredentialService();
    expect(() =>
      service.issue(issueInput({
        operation: "config.global.write" as TrustedDesktopOperation,
      })),
    ).toThrow("Unsupported trusted desktop operation");
  });

  test("rejects invalid TTLs and issuance metadata", () => {
    expect(() => new DesktopApprovalCredentialService({ ttlMs: 0 })).toThrow(
      "ttlMs must be a positive safe integer",
    );

    const service = new DesktopApprovalCredentialService();
    const invalidInputs: Array<DesktopApprovalCredentialIssueInput> = [
      issueInput({ bearerToken: "" }),
      issueInput({ rendererOrigin: "null" }),
      issueInput({ serverOrigin: "http://127.0.0.1:48123/path" }),
      issueInput({ webContentsId: 0 }),
      issueInput({ workspaceId: "" }),
    ];
    for (const input of invalidInputs) {
      expect(() => service.issue(input)).toThrow();
    }
  });
});
