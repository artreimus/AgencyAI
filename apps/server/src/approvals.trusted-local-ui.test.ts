import { describe, expect, test } from "bun:test";

import {
  ApprovalService,
  type ApprovalRequestInput,
} from "./approvals.js";
import type {
  ApprovalActor,
  TrustedDesktopOperation,
} from "./desktop-approval-credentials.js";
import type { ApprovalConfig } from "./types.js";

const API_ACTOR = {
  type: "api",
  clientId: "api:test-client",
} as const;

const DESKTOP_ACTOR: ApprovalActor = {
  type: "desktop",
  credentialId: "aai_dac_safe-id",
  webContentsId: 17,
  workspaceId: "ws_selected",
  operation: "workspace.file.write",
};

function service(
  mode: ApprovalConfig["mode"],
  timeoutMs = 50,
): ApprovalService {
  return new ApprovalService({ mode, timeoutMs });
}

function request(
  overrides: Partial<ApprovalRequestInput> = {},
): ApprovalRequestInput {
  return {
    workspaceId: "ws_selected",
    action: "workspace.file.write",
    summary: "Write selected workspace file",
    paths: ["/workspace/selected.txt"],
    actor: API_ACTOR,
    ...overrides,
  };
}

async function expectPendingAndRespond(
  approvals: ApprovalService,
  promise: ReturnType<ApprovalService["requestApproval"]>,
  expectedAction: string,
): Promise<void> {
  const items = approvals.list();
  expect(items).toHaveLength(1);
  expect(items[0]?.action).toBe(expectedAction);

  const pendingId = items[0]?.id;
  expect(pendingId).toBeTruthy();
  const response = approvals.respond(pendingId!, "deny");
  if (!response) {
    throw new Error("Expected pending approval to accept a response");
  }
  expect(response).toMatchObject({ id: pendingId, allowed: false, reason: "denied" });
  expect(await promise).toEqual(response);
  expect(approvals.list()).toEqual([]);
}

describe("ApprovalService trusted-local-ui decisions", () => {
  const legacyAutoCases: Array<{
    name: string;
    request: Partial<ApprovalRequestInput>;
  }> = [
    { name: "missing approval actor", request: {} },
    { name: "API actor", request: { approvalActor: API_ACTOR } },
    {
      name: "mismatched desktop actor",
      request: {
        approvalActor: DESKTOP_ACTOR,
        workspaceId: "ws_other",
        action: "config.global.write",
      },
    },
  ];

  for (const scenario of legacyAutoCases) {
    test(`legacy auto retains unconditional approval for ${scenario.name}`, async () => {
      const approvals = service("auto");
      const result = await approvals.requestApproval(request(scenario.request));

      expect(result).toEqual({ id: "auto", allowed: true });
      expect(approvals.list()).toEqual([]);
    });
  }

  const manualCases: Array<{
    name: string;
    approvalActor?: ApprovalActor;
  }> = [
    { name: "missing actor" },
    { name: "API actor", approvalActor: API_ACTOR },
    { name: "matching desktop actor", approvalActor: DESKTOP_ACTOR },
  ];

  for (const scenario of manualCases) {
    test(`manual mode queues ${scenario.name}`, async () => {
      const approvals = service("manual");
      const approvalPromise = approvals.requestApproval(request({
        approvalActor: scenario.approvalActor,
      }));

      await expectPendingAndRespond(
        approvals,
        approvalPromise,
        "workspace.file.write",
      );
    });
  }

  test("trusted-local-ui auto-approves an exact trusted desktop actor", async () => {
    const approvals = service("trusted-local-ui");

    const result = await approvals.requestApproval(request({
      approvalActor: DESKTOP_ACTOR,
    }));

    expect(result).toEqual({ id: "trusted-local-ui", allowed: true });
    expect(approvals.list()).toEqual([]);
  });

  const trustedManualCases: Array<{
    name: string;
    request: Partial<ApprovalRequestInput>;
  }> = [
    {
      name: "missing approval actor",
      request: {},
    },
    {
      name: "API actor",
      request: { approvalActor: API_ACTOR },
    },
    {
      name: "workspace mismatch",
      request: {
        approvalActor: {
          ...DESKTOP_ACTOR,
          workspaceId: "ws_other",
        },
      },
    },
    {
      name: "operation mismatch",
      request: {
        approvalActor: {
          ...DESKTOP_ACTOR,
          operation: "mcp.add",
        },
      },
    },
    {
      name: "untrusted operation even when actor and request match",
      request: {
        action: "config.global.write",
        approvalActor: {
          ...DESKTOP_ACTOR,
          operation: "config.global.write" as TrustedDesktopOperation,
        },
      },
    },
  ];

  for (const scenario of trustedManualCases) {
    test(`trusted-local-ui keeps ${scenario.name} manual`, async () => {
      const approvals = service("trusted-local-ui");
      const approvalRequest = request(scenario.request);
      const approvalPromise = approvals.requestApproval(approvalRequest);

      await expectPendingAndRespond(
        approvals,
        approvalPromise,
        approvalRequest.action,
      );
    });
  }

  test("never persists approvalActor metadata or an unexpected raw secret", async () => {
    const approvals = service("manual");
    const rawSecret = "aai_da_raw-secret-must-not-be-serialized";
    const approvalActor = {
      ...DESKTOP_ACTOR,
      credential: rawSecret,
    } as ApprovalActor & { credential: string };
    const approvalPromise = approvals.requestApproval(request({ approvalActor }));

    const pending = approvals.list();
    const serialized = JSON.stringify(pending);
    expect(pending[0]).not.toHaveProperty("approvalActor");
    expect(pending[0]?.actor).toEqual(API_ACTOR);
    expect(serialized).not.toContain("approvalActor");
    expect(serialized).not.toContain(DESKTOP_ACTOR.credentialId);
    expect(serialized).not.toContain(rawSecret);

    await expectPendingAndRespond(
      approvals,
      approvalPromise,
      "workspace.file.write",
    );
  });

  test("manual timeout removes the pending request", async () => {
    const approvals = service("manual", 5);
    const resultPromise = approvals.requestApproval(request({
      approvalActor: DESKTOP_ACTOR,
    }));

    expect(approvals.list()).toHaveLength(1);
    expect(await resultPromise).toMatchObject({
      allowed: false,
      reason: "timeout",
    });
    expect(approvals.list()).toEqual([]);
  });
});
