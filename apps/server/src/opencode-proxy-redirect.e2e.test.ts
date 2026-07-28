import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MVP_FEATURES } from "@openwork/product-config";

import type { ServerProductPolicy } from "./product-policy.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { createWorkspaceOpencodeClient, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type RedirectTrapRequest = Readonly<{
  method: string;
  pathname: string;
  authorization: string | null;
  directory: string | null;
  sentinel: string | null;
  body: string;
}>;

const WORKSPACE_ID = "ws_redirect_guard";
const CLIENT_TOKEN = "owt_redirect_guard_client";
const HOST_TOKEN = "owt_redirect_guard_host";
const ENGINE_PASSWORD = "engine-redirect-secret";
const RENDERER_ORIGIN = "agencyai-internal://renderer";
const SENTINEL_HEADER_VALUE = "renderer-header-must-not-follow";
const LOCAL_MVP_POLICY = Object.freeze({
  profile: "local-mvp",
  features: LOCAL_MVP_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: RENDERER_ORIGIN,
}) satisfies ServerProductPolicy;

let root = "";
let workspaceRoot = "";
let trap: Served | null = null;
let engine: Served | null = null;
let openwork: Served | null = null;
let config: ServerConfig | null = null;
let baseUrl = "";
let previousRuntimeDb: string | undefined;
const trapRequests: RedirectTrapRequest[] = [];

function authHeaders(extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${CLIENT_TOKEN}`,
    ...extra,
  };
}

function redirectLabel(pathname: string) {
  if (pathname === "/global/health") return "proxy-read";
  if (/^\/session\/[^/]+\/command$/.test(pathname)) return "proxy-async-command";
  if (pathname === "/instance/dispose") return "engine-reload";
  if (pathname === "/mcp") return "runtime-mcp-sync";
  if (/^\/mcp\/[^/]+\/disconnect$/.test(pathname)) return "runtime-mcp-disconnect";
  return "unexpected-engine-route";
}

async function waitForTrapSettlement() {
  await Bun.sleep(75);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agencyai-opencode-redirect-"));
  workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");

  trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      trapRequests.push({
        method: request.method,
        pathname: url.pathname,
        authorization: request.headers.get("authorization"),
        directory: request.headers.get("x-opencode-directory"),
        sentinel: request.headers.get("x-redirect-sentinel"),
        body: await request.text(),
      });
      return Response.json({ reached: true });
    },
  }) as Served;

  engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      return new Response(null, {
        status: 307,
        headers: {
          Location: `http://127.0.0.1:${trap?.port}/capture/${redirectLabel(pathname)}`,
        },
      });
    },
  }) as Served;

  config = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    opencodeBaseUrl: `http://127.0.0.1:${engine.port}`,
    opencodeDirectory: workspaceRoot,
    opencodeUsername: "redirect-guard",
    opencodePassword: ENGINE_PASSWORD,
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: [RENDERER_ORIGIN],
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Redirect Guard",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${engine.port}`,
      directory: workspaceRoot,
      opencodeUsername: "redirect-guard",
      opencodePassword: ENGINE_PASSWORD,
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: LOCAL_MVP_POLICY,
  };

  openwork = await startServer(config) as Served;
  baseUrl = `http://127.0.0.1:${openwork.port}`;
});

beforeEach(() => {
  trapRequests.length = 0;
});

afterAll(async () => {
  await openwork?.stop(true);
  await engine?.stop(true);
  await trap?.stop(true);
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local-mvp OpenCode redirect boundary", () => {
  test("rejects redirects from SDK clients without a second-hop request", async () => {
    if (!config) throw new Error("test server config was not initialized");
    const workspace = config.workspaces.find((entry) => entry.id === WORKSPACE_ID);
    if (!workspace) throw new Error("test workspace was not initialized");
    const client = createWorkspaceOpencodeClient(config, workspace);

    const sdkRequests = [
      () => client.global.health(),
      () => client.config.get(),
      () => client.provider.list(),
      () => client.session.list(),
      () => client.mcp.status(),
    ];
    for (const request of sdkRequests) {
      await request().catch(() => undefined);
    }
    await waitForTrapSettlement();

    // A redirect-following client would forward its workspace directory and
    // potentially engine Authorization to the capture origin. Zero requests
    // is the only acceptable second-hop contract.
    expect(trapRequests).toEqual([]);
  });

  test("rejects a proxied read redirect without forwarding renderer headers", async () => {
    const response = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/global/health`,
      {
        headers: authHeaders({
          "X-Redirect-Sentinel": SENTINEL_HEADER_VALUE,
        }),
      },
    );
    await waitForTrapSettlement();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_engine_redirect_rejected",
    });
    expect(trapRequests).toEqual([]);
  });

  test("does not follow redirects from fire-and-forget session commands", async () => {
    const response = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/session/ses_redirect/command`,
      {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "X-Redirect-Sentinel": SENTINEL_HEADER_VALUE,
        }),
        body: JSON.stringify({ command: "review", arguments: "" }),
      },
    );
    await waitForTrapSettlement();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
    expect(trapRequests).toEqual([]);
  });

  test("rejects an engine-reload redirect with the stable proxy error", async () => {
    const response = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/engine/reload`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    await waitForTrapSettlement();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_engine_redirect_rejected",
    });
    expect(trapRequests).toEqual([]);
  });

  test("does not follow redirects while hot-syncing a runtime MCP", async () => {
    const response = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/mcp`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          name: "redirect-sync",
          config: {
            type: "remote",
            url: "https://mcp.example.invalid/mcp",
            enabled: true,
          },
        }),
      },
    );
    await waitForTrapSettlement();

    // Runtime registration is deliberately best-effort; the config write
    // succeeds even when delivery to the live engine is rejected.
    expect(response.status).toBe(200);
    expect(trapRequests).toEqual([]);
  });

  test("does not follow redirects while disconnecting a removed runtime MCP", async () => {
    if (!config) throw new Error("test server config was not initialized");
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      mcp: {
        ...(current.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp)
          ? current.mcp as Record<string, unknown>
          : {}),
        "redirect-disconnect": {
          type: "remote",
          url: "https://mcp.example.invalid/mcp",
          enabled: true,
        },
      },
    }));

    const response = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/mcp/redirect-disconnect`,
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );
    await waitForTrapSettlement();

    expect(response.status).toBe(200);
    expect(trapRequests).toEqual([]);
  });
});
