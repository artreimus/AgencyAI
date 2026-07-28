import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  DesktopApprovalGrantRequest,
  DesktopApprovalOperation,
  DesktopFetchInit,
} from "@openwork/types/desktop-ipc";

import { desktopFetch } from "../src/app/lib/desktop";
import {
  createOpenworkServerClient,
  type OpenworkServerClient,
} from "../src/app/lib/openwork-server";

const LOCAL_BASE_URL = "http://127.0.0.1:43123";
const WORKSPACE_ID = "workspace_local";
const DEV_RENDERER_ORIGIN = "http://localhost:5173";
const TOKEN = "owner-token";

type RelayCall = {
  url: string;
  init: DesktopFetchInit;
};

type RendererFetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

type ProtectedCase = {
  name: string;
  operation: DesktopApprovalOperation;
  run: (client: OpenworkServerClient) => Promise<unknown>;
};

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

let grantRequests: DesktopApprovalGrantRequest[] = [];
let relayCalls: RelayCall[] = [];
let rendererFetchCalls: RendererFetchCall[] = [];
let storageOperations: string[] = [];
let nextGrantServerOrigin: string | null = null;

function storageCanary(): Storage {
  return {
    get length() {
      storageOperations.push("length");
      return 0;
    },
    clear() {
      storageOperations.push("clear");
    },
    getItem(key: string) {
      storageOperations.push(`get:${key}`);
      return null;
    },
    key(index: number) {
      storageOperations.push(`key:${index}`);
      return null;
    },
    removeItem(key: string) {
      storageOperations.push(`remove:${key}`);
    },
    setItem(key: string) {
      storageOperations.push(`set:${key}`);
    },
  };
}

function responsePayload(url: string, method: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith("/files/sessions") && method === "POST") {
    return JSON.stringify({ session: { id: "file-session-1" } });
  }
  if (pathname.endsWith("/files/sessions/file-session-1/ops")) {
    return JSON.stringify({
      items: [{ ok: true, path: "obsolete.txt" }],
    });
  }
  if (pathname.endsWith("/skills")) {
    return JSON.stringify({ items: [] });
  }
  return "{}";
}

function headerValue(call: RelayCall, expectedName: string): string | null {
  const entry = Object.entries(call.init.headers ?? {}).find(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase(),
  );
  return entry?.[1] ?? null;
}

function approvalHeader(call: RelayCall): string | null {
  return headerValue(call, "X-AgencyAI-Desktop-Approval");
}

function installDesktopWindow(origin = DEV_RENDERER_ORIGIN): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin },
      localStorage: storageCanary(),
      fetch: globalThis.fetch,
      __OPENWORK_ELECTRON__: {
        invokeDesktop: async (
          command: string,
          first?: string | DesktopApprovalGrantRequest,
          second?: DesktopFetchInit,
        ) => {
          if (command === "desktopApprovalGrant") {
            if (!first || typeof first === "string") {
              throw new Error("Missing desktop approval request");
            }
            grantRequests.push(first);
            const issuedAt = Date.now();
            return {
              credential: `one-use-grant-${grantRequests.length}`,
              credentialId: `grant-id-${grantRequests.length}`,
              serverOrigin: nextGrantServerOrigin ?? LOCAL_BASE_URL,
              workspaceId: first.workspaceId,
              operation: first.operation,
              issuedAt,
              expiresAt: issuedAt + 60_000,
            };
          }
          if (command === "__fetch") {
            if (typeof first !== "string") {
              throw new Error("Missing relay URL");
            }
            const init = second ?? {};
            relayCalls.push({ url: first, init });
            return {
              status: 200,
              statusText: "OK",
              headers: [["content-type", "application/json"]],
              body: responsePayload(first, init.method ?? "GET"),
            };
          }
          throw new Error(`Unexpected desktop command: ${command}`);
        },
      },
    },
  });
}

beforeEach(() => {
  grantRequests = [];
  relayCalls = [];
  rendererFetchCalls = [];
  storageOperations = [];
  nextGrantServerOrigin = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries(),
    );
    rendererFetchCalls.push({ url, method, headers });
    const diagnostics = new URL(url).pathname.includes("/diagnostics/");
    return new Response(
      diagnostics
        ? JSON.stringify({ code: "diagnostics_disabled", message: "diagnostics fixture" })
        : responsePayload(url, method),
      {
        status: diagnostics ? 503 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  installDesktopWindow();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("OpenWork server desktop approval transport", () => {
  test("issues one fresh grant for every protected local request with exact workspace/action scope", async () => {
    const protectedCases: ProtectedCase[] = [
      {
        name: "runtime config migration",
        operation: "config.runtime_migrate",
        run: (client) => client.migrateRuntimeConfig(WORKSPACE_ID),
      },
      {
        name: "config patch",
        operation: "config.patch",
        run: (client) => client.patchConfig(WORKSPACE_ID, { opencode: {} }),
      },
      {
        name: "project config write",
        operation: "config.write",
        run: (client) => client.writeOpencodeConfigFile(
          WORKSPACE_ID,
          "project",
          "{\"model\":\"local\"}",
        ),
      },
      {
        name: "skill upsert",
        operation: "skills.upsert",
        run: (client) => client.upsertSkill(WORKSPACE_ID, {
          name: "example-skill",
          content: "# Example",
        }),
      },
      {
        name: "skill delete",
        operation: "skills.delete",
        run: (client) => client.deleteSkill(WORKSPACE_ID, "example-skill"),
      },
      {
        name: "MCP add",
        operation: "mcp.add",
        run: (client) => client.addMcp(WORKSPACE_ID, {
          name: "example-mcp",
          config: { type: "local", command: ["example"] },
        }),
      },
      {
        name: "MCP remove",
        operation: "mcp.remove",
        run: (client) => client.removeMcp(WORKSPACE_ID, "example-mcp"),
      },
      {
        name: "MCP enable",
        operation: "mcp.enable",
        run: (client) => client.setMcpEnabled(WORKSPACE_ID, "example-mcp", true),
      },
      {
        name: "MCP disable",
        operation: "mcp.disable",
        run: (client) => client.setMcpEnabled(WORKSPACE_ID, "example-mcp", false),
      },
      {
        name: "command upsert",
        operation: "commands.upsert",
        run: (client) => client.upsertCommand(WORKSPACE_ID, {
          name: "example-command",
          template: "Do the task.",
        }),
      },
      {
        name: "command delete",
        operation: "commands.delete",
        run: (client) => client.deleteCommand(WORKSPACE_ID, "example-command"),
      },
      {
        name: "workspace import",
        operation: "config.import",
        run: (client) => client.importWorkspace(WORKSPACE_ID, { version: 1 }),
      },
      {
        name: "inbox upload",
        operation: "workspace.inbox.upload",
        run: (client) => client.uploadInbox(
          WORKSPACE_ID,
          new File([new Uint8Array([0, 255, 1, 128])], "payload.bin", {
            type: "application/octet-stream",
          }),
          { path: "nested/payload.bin" },
        ),
      },
      {
        name: "workspace text write",
        operation: "workspace.file.write",
        run: (client) => client.writeWorkspaceFile(WORKSPACE_ID, {
          path: "notes.txt",
          content: "hello",
        }),
      },
      {
        name: "workspace binary write",
        operation: "workspace.file.write",
        run: (client) => client.writeWorkspaceBinaryFile(WORKSPACE_ID, {
          path: "payload.bin",
          data: new Uint8Array([0, 255, 1, 128]).buffer,
        }),
      },
      {
        name: "workspace file session operations",
        operation: "workspace.files.session.ops",
        run: (client) => client.deleteWorkspaceFiles(WORKSPACE_ID, [
          { path: "obsolete.txt" },
        ]),
      },
    ];
    const client = createOpenworkServerClient({
      baseUrl: LOCAL_BASE_URL,
      token: TOKEN,
      hostToken: "host-token",
    });

    for (const item of protectedCases) {
      const grantsBefore = grantRequests.length;
      const relaysBefore = relayCalls.length;
      await item.run(client);

      expect(grantRequests.slice(grantsBefore), item.name).toEqual([
        { workspaceId: WORKSPACE_ID, operation: item.operation },
      ]);
      const requestRelays = relayCalls.slice(relaysBefore);
      expect(requestRelays, item.name).toHaveLength(1);
      expect(requestRelays[0]?.init.desktopApprovalCredential, item.name).toBe(
        `one-use-grant-${grantsBefore + 1}`,
      );
      expect(headerValue(requestRelays[0]!, "Origin"), item.name).toBe(DEV_RENDERER_ORIGIN);
      expect(approvalHeader(requestRelays[0]!), item.name).toBeNull();
      expect(new URL(requestRelays[0]!.url).origin, item.name).toBe(LOCAL_BASE_URL);
    }

    const credentials = relayCalls
      .map((call) => call.init.desktopApprovalCredential)
      .filter((credential): credential is string => typeof credential === "string");
    expect(credentials).toHaveLength(protectedCases.length);
    expect(new Set(credentials).size).toBe(protectedCases.length);
    expect(storageOperations).toEqual([]);

    const upload = relayCalls.find((call) => call.url.endsWith("/inbox"));
    expect(upload?.init.body).toBeUndefined();
    expect(upload?.init.bodyEnvelope).toEqual({
      kind: "multipart",
      parts: [
        {
          kind: "file",
          name: "file",
          fileName: "payload.bin",
          contentType: "application/octet-stream",
          bytes: new Uint8Array([0, 255, 1, 128]),
        },
        {
          kind: "field",
          name: "path",
          value: "nested/payload.bin",
        },
      ],
    });
  });

  test("does not request or attach a grant for remote protected calls", async () => {
    const client = createOpenworkServerClient({
      baseUrl: "https://remote.example.test",
      token: TOKEN,
    });

    await client.patchConfig(WORKSPACE_ID, { opencode: {} });

    expect(grantRequests).toEqual([]);
    expect(rendererFetchCalls).toEqual([]);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.init.desktopApprovalCredential).toBeUndefined();
    expect(headerValue(relayCalls[0]!, "Origin")).toBeNull();
    expect(approvalHeader(relayCalls[0]!)).toBeNull();
  });

  test("keeps manual mutations, global config, reads, diagnostics, and generic OpenCode-style fetches grant-free", async () => {
    const client = createOpenworkServerClient({
      baseUrl: LOCAL_BASE_URL,
      token: TOKEN,
    });

    await client.addPlugin(WORKSPACE_ID, "example-plugin");
    await client.removePlugin(WORKSPACE_ID, "example-plugin");
    await client.setAuthorizedFolders(WORKSPACE_ID, ["/workspace/allowed"]);
    await client.logoutMcpAuth(WORKSPACE_ID, "example-mcp");
    await client.writeOpencodeConfigFile(WORKSPACE_ID, "global", "{}");
    await client.listSkills(WORKSPACE_ID);
    await client.downloadWorkspaceFile(WORKSPACE_ID, "notes.txt");
    await expect(client.runAgentContextDiagnostics(WORKSPACE_ID, {
      organizationConnectionsProbe: {
        status: "skipped",
        code: "signed_out",
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
    })).rejects.toBeInstanceOf(Error);
    await desktopFetch(new Request("https://opencode.remote.test/session", {
      method: "POST",
      headers: { Authorization: "Bearer opencode-token" },
      body: "{}",
    }));

    expect(grantRequests).toEqual([]);
    expect(rendererFetchCalls).toHaveLength(8);
    for (const call of rendererFetchCalls) {
      expect(call.headers.origin).toBeUndefined();
      expect(call.headers["x-agencyai-desktop-approval"]).toBeUndefined();
    }
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.url).toBe("https://opencode.remote.test/session");
    expect(relayCalls[0]?.init.desktopApprovalCredential).toBeUndefined();
    expect(headerValue(relayCalls[0]!, "Origin")).toBeNull();
    expect(approvalHeader(relayCalls[0]!)).toBeNull();
    expect(storageOperations).toEqual([]);
  });

  test("uses the compiled internal renderer origin outside loopback dev", async () => {
    installDesktopWindow("null");
    const client = createOpenworkServerClient({
      baseUrl: LOCAL_BASE_URL,
      token: TOKEN,
    });

    await client.patchConfig(WORKSPACE_ID, { opencode: {} });

    expect(grantRequests).toHaveLength(1);
    expect(relayCalls).toHaveLength(1);
    expect(headerValue(relayCalls[0]!, "Origin")).toBe("agencyai-internal://renderer");
  });

  test("uses ordinary renderer fetch when Electron is absent", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: DEV_RENDERER_ORIGIN },
        localStorage: storageCanary(),
        fetch: globalThis.fetch,
      },
    });
    const client = createOpenworkServerClient({
      baseUrl: LOCAL_BASE_URL,
      token: TOKEN,
    });

    await client.patchConfig(WORKSPACE_ID, { opencode: {} });

    expect(grantRequests).toEqual([]);
    expect(relayCalls).toEqual([]);
    expect(rendererFetchCalls).toHaveLength(1);
    expect(rendererFetchCalls[0]?.headers.origin).toBeUndefined();
  });

  test("fails closed before HTTP when a grant is bound to another server", async () => {
    nextGrantServerOrigin = "http://127.0.0.1:43124";
    const client = createOpenworkServerClient({
      baseUrl: LOCAL_BASE_URL,
      token: TOKEN,
    });

    await expect(client.patchConfig(WORKSPACE_ID, { opencode: {} })).rejects.toThrow(
      "invalid desktop approval grant",
    );

    expect(grantRequests).toHaveLength(1);
    expect(relayCalls).toEqual([]);
    expect(rendererFetchCalls).toEqual([]);
  });
});
