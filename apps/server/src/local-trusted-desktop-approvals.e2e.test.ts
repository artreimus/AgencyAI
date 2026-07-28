import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MVP_FEATURES } from "@openwork/product-config";

import {
  AGENCYAI_DESKTOP_APPROVAL_HEADER,
  DesktopApprovalCredentialService,
  type DesktopApprovalGrant,
  type TrustedDesktopOperation,
} from "./desktop-approval-credentials.js";
import type { ServerProductPolicy } from "./product-policy.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { hashToken } from "./utils.js";

type Served = Awaited<ReturnType<typeof startServer>>;

const SELECTED_WORKSPACE_ID = "ws_trusted_desktop_selected";
const OTHER_WORKSPACE_ID = "ws_trusted_desktop_other";
const CLIENT_TOKEN = "owt_trusted_desktop_selected";
const SECOND_CLIENT_TOKEN = "owt_trusted_desktop_second";
const HOST_TOKEN = "owt_trusted_desktop_host";
const RENDERER_ORIGIN = "agencyai-internal://renderer";
const SPOOFED_CREDENTIAL = `aai_da_${"s".repeat(43)}`;

const LOCAL_MVP_POLICY = Object.freeze({
  profile: "local-mvp",
  features: LOCAL_MVP_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: RENDERER_ORIGIN,
}) satisfies ServerProductPolicy;

const environmentKeys = [
  "OPENWORK_STORAGE_ROOT",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_DATA_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
] as const;

const previousEnvironment = new Map<string, string | undefined>();
const issuedGrants: DesktopApprovalGrant[] = [];

let root = "";
let selectedWorkspaceRoot = "";
let otherWorkspaceRoot = "";
let serverConfigPath = "";
let runtimeDbPath = "";
let baseUrl = "";
let server: Served | null = null;
let credentials: DesktopApprovalCredentialService;
let approvalConfig: ServerConfig["approval"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(
  response: Response,
): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Expected a JSON object response");
  return body;
}

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

function clientHeaders(input?: {
  token?: string;
  credential?: string;
  origin?: string;
  json?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input?.token ?? CLIENT_TOKEN}`,
  };
  if (input?.credential !== undefined) {
    headers[AGENCYAI_DESKTOP_APPROVAL_HEADER] = input.credential;
  }
  if (input?.origin !== undefined) headers.origin = input.origin;
  if (input?.json !== false) headers["content-type"] = "application/json";
  return headers;
}

function hostHeaders(json = false): Record<string, string> {
  return {
    "x-openwork-host-token": HOST_TOKEN,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function issueGrant(input?: {
  bearerToken?: string;
  workspaceId?: string;
  operation?: TrustedDesktopOperation;
}): DesktopApprovalGrant {
  const grant = credentials.issue({
    bearerToken: input?.bearerToken ?? CLIENT_TOKEN,
    rendererOrigin: RENDERER_ORIGIN,
    serverOrigin: baseUrl,
    webContentsId: 17,
    workspaceId: input?.workspaceId ?? SELECTED_WORKSPACE_ID,
    operation: input?.operation ?? "config.patch",
  });
  issuedGrants.push(grant);
  return grant;
}

function patchWorkspace(
  workspaceId: string,
  openwork: Record<string, unknown>,
  input?: {
    token?: string;
    credential?: string;
    origin?: string;
  },
): Promise<Response> {
  return apiFetch(`/workspace/${workspaceId}/config`, {
    method: "PATCH",
    headers: clientHeaders({
      token: input?.token,
      credential: input?.credential,
      origin: input?.origin,
    }),
    body: JSON.stringify({ openwork }),
  });
}

async function getWorkspaceConfig(
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(`/workspace/${workspaceId}/config`, {
    headers: clientHeaders({ json: false }),
  });
  expect(response.status).toBe(200);
  return responseRecord(response);
}

async function getPendingApprovals(): Promise<Record<string, unknown>[]> {
  const response = await apiFetch("/approvals", {
    headers: hostHeaders(),
  });
  expect(response.status).toBe(200);
  const body = await responseRecord(response);
  return Array.isArray(body.items)
    ? body.items.filter(isRecord)
    : [];
}

async function waitForPendingApproval(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const items = await getPendingApprovals();
    if (items[0]) return items[0];
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for a manual approval request");
}

async function listRegularFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listRegularFiles(path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agencyai-trusted-desktop-approval-"));
  selectedWorkspaceRoot = join(root, "selected-workspace");
  otherWorkspaceRoot = join(root, "other-workspace");
  serverConfigPath = join(root, "server.json");
  runtimeDbPath = join(root, "runtime.sqlite");
  const tokenStorePath = join(root, "tokens.json");
  const dataDir = join(root, "data");

  for (const workspaceRoot of [selectedWorkspaceRoot, otherWorkspaceRoot]) {
    await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".opencode", "opencode.jsonc"),
      "{}\n",
      "utf8",
    );
  }
  await writeFile(
    serverConfigPath,
    JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    tokenStorePath,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: Date.now(),
      tokens: [
        {
          id: "secondary-client",
          hash: hashToken(SECOND_CLIENT_TOKEN),
          scope: "collaborator",
          createdAt: Date.now(),
        },
      ],
    }, null, 2) + "\n",
    "utf8",
  );

  for (const key of environmentKeys) {
    previousEnvironment.set(key, process.env[key]);
  }
  delete process.env.OPENWORK_STORAGE_ROOT;
  delete process.env.OPENWORK_SERVER_CONFIG;
  Object.assign(process.env, {
    OPENWORK_RUNTIME_DB: runtimeDbPath,
    OPENWORK_TOKEN_STORE: tokenStorePath,
    OPENWORK_DATA_DIR: dataDir,
    OPENCODE_CONFIG_DIR: join(root, "opencode-config"),
    OPENCODE_DB: join(root, "opencode.db"),
  });

  credentials = new DesktopApprovalCredentialService({ ttlMs: 120_000 });
  approvalConfig = { mode: "trusted-local-ui", timeoutMs: 5_000 };
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: serverConfigPath,
    approval: approvalConfig,
    corsOrigins: [RENDERER_ORIGIN],
    workspaces: [
      {
        id: SELECTED_WORKSPACE_ID,
        name: "Selected Workspace",
        path: selectedWorkspaceRoot,
        preset: "starter",
        workspaceType: "local",
      },
      {
        id: OTHER_WORKSPACE_ID,
        name: "Other Workspace",
        path: otherWorkspaceRoot,
        preset: "starter",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [selectedWorkspaceRoot, otherWorkspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: LOCAL_MVP_POLICY,
    desktopApprovalCredentials: credentials,
  } satisfies ServerConfig;

  server = await startServer(config);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.stop();
  for (const key of environmentKeys) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local trusted desktop approval HTTP contract", () => {
  test("exact origin, bearer, workspace, and operation approve one config write only", async () => {
    const grant = issueGrant();
    const response = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      {
        desktopApprovalContract: {
          status: "approved-once",
        },
      },
      {
        credential: grant.credential,
        origin: RENDERER_ORIGIN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      RENDERER_ORIGIN,
    );
    expect(await responseRecord(response)).toHaveProperty("updatedAt");
    expect(await getPendingApprovals()).toEqual([]);

    const replay = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      {
        desktopApprovalContract: {
          status: "replayed",
        },
      },
      {
        credential: grant.credential,
        origin: RENDERER_ORIGIN,
      },
    );
    const replayBody = await responseRecord(replay);

    expect(replay.status).toBe(401);
    expect(replayBody.code).toBe("desktop_approval_invalid");
    expect(await getPendingApprovals()).toEqual([]);

    const persisted = await getWorkspaceConfig(SELECTED_WORKSPACE_ID);
    expect(persisted.openwork).toMatchObject({
      desktopApprovalContract: {
        status: "approved-once",
      },
    });

    const auditResponse = await apiFetch(
      `/workspace/${SELECTED_WORKSPACE_ID}/audit`,
      { headers: clientHeaders({ json: false }) },
    );
    const audit = await responseRecord(auditResponse);
    expect(auditResponse.status).toBe(200);
    expect(audit.items).toEqual([
      expect.objectContaining({
        workspaceId: SELECTED_WORKSPACE_ID,
        actor: {
          type: "desktop",
          scope: "collaborator",
          webContentsId: 17,
          workspaceId: SELECTED_WORKSPACE_ID,
          operation: "config.patch",
        },
        action: "config.patch",
        summary: "Patched workspace config",
      }),
    ]);

    for (const serialized of [
      JSON.stringify(persisted),
      JSON.stringify(audit),
    ]) {
      expect(serialized).not.toContain(grant.credential);
      expect(serialized).not.toContain(CLIENT_TOKEN);
    }
  });

  test("a manually reviewed desktop request remains attributed as desktop in approval and audit", async () => {
    approvalConfig.mode = "manual";
    const grant = issueGrant();
    try {
      const writeResponse = patchWorkspace(
        SELECTED_WORKSPACE_ID,
        {
          desktopApprovalContract: {
            status: "manually-approved",
          },
        },
        {
          credential: grant.credential,
          origin: RENDERER_ORIGIN,
        },
      );
      const pending = await waitForPendingApproval();

      expect(pending).toMatchObject({
        workspaceId: SELECTED_WORKSPACE_ID,
        action: "config.patch",
        actor: {
          type: "desktop",
          scope: "collaborator",
          webContentsId: 17,
          workspaceId: SELECTED_WORKSPACE_ID,
          operation: "config.patch",
        },
      });
      expect(pending).not.toHaveProperty("approvalActor");
      expect(JSON.stringify(pending)).not.toContain(grant.credential);
      expect(JSON.stringify(pending)).not.toContain(grant.credentialId);

      const approvalId = pending.id;
      if (typeof approvalId !== "string") {
        throw new Error("Expected a pending approval id");
      }
      const approval = await apiFetch(`/approvals/${approvalId}`, {
        method: "POST",
        headers: hostHeaders(true),
        body: JSON.stringify({ reply: "allow" }),
      });
      expect(approval.status).toBe(200);
      expect(await responseRecord(approval)).toEqual({
        ok: true,
        allowed: true,
      });

      const write = await writeResponse;
      expect(write.status).toBe(200);

      const auditResponse = await apiFetch(
        `/workspace/${SELECTED_WORKSPACE_ID}/audit?limit=1`,
        { headers: clientHeaders({ json: false }) },
      );
      const audit = await responseRecord(auditResponse);
      expect(audit.items).toEqual([
        expect.objectContaining({
          action: "config.patch",
          actor: {
            type: "desktop",
            scope: "collaborator",
            webContentsId: 17,
            workspaceId: SELECTED_WORKSPACE_ID,
            operation: "config.patch",
          },
        }),
      ]);
    } finally {
      approvalConfig.mode = "trusted-local-ui";
    }
  });

  test("replay and every mismatched or spoofed grant fail closed", async () => {
    const wrongWorkspace = issueGrant();
    const wrongWorkspaceResponse = await patchWorkspace(
      OTHER_WORKSPACE_ID,
      { wrongWorkspaceAttempt: true },
      {
        credential: wrongWorkspace.credential,
        origin: RENDERER_ORIGIN,
      },
    );
    expect(wrongWorkspaceResponse.status).toBe(403);
    expect((await responseRecord(wrongWorkspaceResponse)).code).toBe(
      "desktop_approval_scope_mismatch",
    );

    const wrongOperation = issueGrant({ operation: "skills.upsert" });
    const wrongOperationResponse = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { wrongOperationAttempt: true },
      {
        credential: wrongOperation.credential,
        origin: RENDERER_ORIGIN,
      },
    );
    expect(wrongOperationResponse.status).toBe(403);
    expect((await responseRecord(wrongOperationResponse)).code).toBe(
      "desktop_approval_scope_mismatch",
    );

    const wrongBearer = issueGrant();
    const wrongBearerResponse = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { wrongBearerAttempt: true },
      {
        token: SECOND_CLIENT_TOKEN,
        credential: wrongBearer.credential,
        origin: RENDERER_ORIGIN,
      },
    );
    expect(wrongBearerResponse.status).toBe(401);
    expect((await responseRecord(wrongBearerResponse)).code).toBe(
      "desktop_approval_invalid",
    );

    const consumedAfterMismatch = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { consumedMismatchReplayAttempt: true },
      {
        credential: wrongBearer.credential,
        origin: RENDERER_ORIGIN,
      },
    );
    expect(consumedAfterMismatch.status).toBe(401);
    expect((await responseRecord(consumedAfterMismatch)).code).toBe(
      "desktop_approval_invalid",
    );

    const spoofedResponse = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { spoofedCredentialAttempt: true },
      {
        credential: SPOOFED_CREDENTIAL,
        origin: RENDERER_ORIGIN,
      },
    );
    expect(spoofedResponse.status).toBe(401);
    expect((await responseRecord(spoofedResponse)).code).toBe(
      "desktop_approval_invalid",
    );

    const wrongOrigin = issueGrant();
    const wrongOriginResponse = await patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { wrongOriginAttempt: true },
      {
        credential: wrongOrigin.credential,
        origin: "agencyai-internal://other-renderer",
      },
    );
    const wrongOriginBody = await responseRecord(wrongOriginResponse);
    expect(wrongOriginResponse.status).toBe(403);
    expect(wrongOriginBody).toMatchObject({
      code: "cors_origin_denied",
      details: { reason: "origin_not_allowed" },
    });

    expect(await getPendingApprovals()).toEqual([]);
    const selected = await getWorkspaceConfig(SELECTED_WORKSPACE_ID);
    const other = await getWorkspaceConfig(OTHER_WORKSPACE_ID);
    const serialized = JSON.stringify({ selected, other });
    for (const rejectedKey of [
      "wrongWorkspaceAttempt",
      "wrongOperationAttempt",
      "wrongBearerAttempt",
      "consumedMismatchReplayAttempt",
      "spoofedCredentialAttempt",
      "wrongOriginAttempt",
    ]) {
      expect(serialized).not.toContain(rejectedKey);
    }
  });

  test("a bearer without a desktop grant remains manual and can be denied", async () => {
    const writeResponse = patchWorkspace(
      SELECTED_WORKSPACE_ID,
      { absentGrantAttempt: true },
      { origin: RENDERER_ORIGIN },
    );
    const pending = await waitForPendingApproval();
    const pendingSerialized = JSON.stringify(pending);

    expect(pending).toMatchObject({
      workspaceId: SELECTED_WORKSPACE_ID,
      action: "config.patch",
      actor: {
        type: "api",
        scope: "collaborator",
      },
    });
    expect(pending).not.toHaveProperty("approvalActor");
    expect(pendingSerialized).not.toContain(CLIENT_TOKEN);
    expect(pendingSerialized).not.toContain(AGENCYAI_DESKTOP_APPROVAL_HEADER);
    for (const grant of issuedGrants) {
      expect(pendingSerialized).not.toContain(grant.credential);
    }

    const approvalId = pending.id;
    if (typeof approvalId !== "string") {
      throw new Error("Expected a pending approval id");
    }
    const denial = await apiFetch(`/approvals/${approvalId}`, {
      method: "POST",
      headers: hostHeaders(true),
      body: JSON.stringify({ reply: "deny" }),
    });
    expect(denial.status).toBe(200);
    expect(await responseRecord(denial)).toEqual({
      ok: true,
      allowed: false,
    });

    const deniedWrite = await writeResponse;
    const deniedBody = await responseRecord(deniedWrite);
    expect(deniedWrite.status).toBe(403);
    expect(deniedBody).toMatchObject({
      code: "write_denied",
      details: { reason: "denied" },
    });
    expect(await getPendingApprovals()).toEqual([]);

    const persisted = await getWorkspaceConfig(SELECTED_WORKSPACE_ID);
    expect(JSON.stringify(persisted)).not.toContain("absentGrantAttempt");
  });

  test("raw credentials never enter approval, audit, or config persistence", async () => {
    const [approvalsResponse, auditResponse, configResponse] = await Promise.all([
      apiFetch("/approvals", { headers: hostHeaders() }),
      apiFetch(`/workspace/${SELECTED_WORKSPACE_ID}/audit`, {
        headers: clientHeaders({ json: false }),
      }),
      apiFetch(`/workspace/${SELECTED_WORKSPACE_ID}/config`, {
        headers: clientHeaders({ json: false }),
      }),
    ]);
    const serializedPublicState = JSON.stringify({
      approvals: await responseRecord(approvalsResponse),
      audit: await responseRecord(auditResponse),
      config: await responseRecord(configResponse),
    });

    expect(approvalsResponse.status).toBe(200);
    expect(auditResponse.status).toBe(200);
    expect(configResponse.status).toBe(200);
    expect(await Bun.file(runtimeDbPath).exists()).toBe(true);

    const rawSecrets = [
      CLIENT_TOKEN,
      SECOND_CLIENT_TOKEN,
      SPOOFED_CREDENTIAL,
      ...issuedGrants.flatMap((grant) => [
        grant.credential,
        grant.credentialId,
      ]),
    ];
    for (const rawSecret of rawSecrets) {
      expect(serializedPublicState).not.toContain(rawSecret);
    }

    const persistedFiles = await listRegularFiles(root);
    expect(persistedFiles).toContain(runtimeDbPath);
    expect(persistedFiles).toContain(serverConfigPath);
    for (const path of persistedFiles) {
      const bytes = await readFile(path);
      for (const rawSecret of rawSecrets) {
        expect(bytes.includes(Buffer.from(rawSecret))).toBe(false);
      }
    }
  });
});
