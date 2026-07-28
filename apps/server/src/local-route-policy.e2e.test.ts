import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MVP_FEATURES } from "@openwork/product-config";

import type { ServerProductPolicy } from "./product-policy.js";
import { serve, type ServeResult } from "./serve-node.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type DisabledRouteCase = Readonly<{
  label: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: "none" | "client" | "host";
  body?: unknown;
}>;

const WORKSPACE_ID = "ws_local_route_policy";
const CLIENT_TOKEN = "owt_local_route_policy_client";
const HOST_TOKEN = "owt_local_route_policy_host";
const OPENCODE_PASSWORD = "opencode-route-policy-secret";
const PROVIDER_SECRET = "provider-route-policy-secret";
const CONTROL_TOKEN = "control-route-policy-secret";
const RENDERER_ORIGIN = "agencyai-internal://renderer";
const REMOTE_WORKSPACE_ID = "remote_quarantined_route_policy";
const REMOTE_WORKSPACE_SECRET = "quarantined-remote-workspace-secret";
const UNKNOWN_FIELD_SECRET = "future-field-secret-sentinel";

const QUARANTINED_REMOTE_CONFIG = Object.freeze({
  id: REMOTE_WORKSPACE_ID,
  name: "Quarantined Remote",
  path: "",
  preset: "remote",
  workspaceType: "remote",
  remoteType: "openwork",
  baseUrl: "https://remote.invalid",
  openworkToken: REMOTE_WORKSPACE_SECRET,
  futureTransport: {
    kind: "future-tunnel",
    credential: UNKNOWN_FIELD_SECRET,
    flags: ["preserve", "verbatim"],
  },
  unknownTopLevel: 42,
});

const LOCAL_MVP_POLICY = Object.freeze({
  profile: "local-mvp",
  features: Object.freeze({
    ...LOCAL_MVP_FEATURES,
    browserAutomation: false,
  }),
  networkPolicy: "user-authorized",
  rendererOrigin: RENDERER_ORIGIN,
}) satisfies ServerProductPolicy;

const DISABLED_ROUTES: readonly DisabledRouteCase[] = [
  {
    label: "cloud MCP health",
    method: "GET",
    path: `/workspace/${WORKSPACE_ID}/mcp/openwork-cloud/health`,
    auth: "client",
  },
  {
    label: "cloud MCP engine refresh",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/mcp/openwork-cloud/engine-refresh`,
    auth: "client",
    body: {},
  },
  {
    label: "cloud MCP reconcile",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/mcp/openwork-cloud/reconcile`,
    auth: "client",
    body: {},
  },
  {
    label: "Connect state read",
    method: "GET",
    path: "/experimental/connect/state",
    auth: "client",
  },
  {
    label: "Connect skill catalog",
    method: "GET",
    path: "/experimental/connect/skills",
    auth: "client",
  },
  {
    label: "Connect state mutation",
    method: "PUT",
    path: "/experimental/connect/state",
    auth: "host",
    body: { connectEnabled: true },
  },
  {
    label: "Google Workspace status",
    method: "GET",
    path: "/experimental/google-workspace/status",
    auth: "client",
  },
  {
    label: "Google Workspace connect",
    method: "POST",
    path: "/experimental/google-workspace/connect/start",
    auth: "client",
    body: { features: ["drive"] },
  },
  {
    label: "Google Workspace flow status",
    method: "GET",
    path: "/experimental/google-workspace/connect/status/flow_1",
    auth: "client",
  },
  {
    label: "Google Workspace disconnect",
    method: "POST",
    path: "/experimental/google-workspace/disconnect",
    auth: "client",
    body: {},
  },
  {
    label: "Google Workspace active account",
    method: "POST",
    path: "/experimental/google-workspace/active-account",
    auth: "client",
    body: { accountId: "account_1" },
  },
  {
    label: "Google Workspace connection test",
    method: "POST",
    path: "/experimental/google-workspace/test",
    auth: "client",
    body: {},
  },
  {
    label: "Google Workspace smoke test",
    method: "POST",
    path: "/experimental/google-workspace/smoke-test",
    auth: "client",
    body: {},
  },
  {
    label: "voice session",
    method: "POST",
    path: "/voice/realtime/session",
    auth: "host",
    body: { model: "trap-model" },
  },
  {
    label: "runtime versions",
    method: "GET",
    path: "/runtime/versions",
    auth: "client",
  },
  {
    label: "runtime upgrade",
    method: "POST",
    path: "/runtime/upgrade",
    auth: "host",
    body: {},
  },
  {
    label: "mounted runtime versions",
    method: "GET",
    path: `/w/${WORKSPACE_ID}/runtime/versions`,
    auth: "client",
  },
  {
    label: "mounted runtime upgrade",
    method: "POST",
    path: `/w/${WORKSPACE_ID}/runtime/upgrade`,
    auth: "host",
    body: {},
  },
  {
    label: "desktop cloud sync read",
    method: "GET",
    path: `/workspace/${WORKSPACE_ID}/desktop-cloud-sync`,
    auth: "client",
  },
  {
    label: "desktop cloud sync write",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/desktop-cloud-sync`,
    auth: "client",
    body: { snapshot: {} },
  },
  {
    label: "cloud plugin list",
    method: "GET",
    path: `/workspace/${WORKSPACE_ID}/cloud-plugins`,
    auth: "client",
  },
  {
    label: "cloud plugin install",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/cloud-plugins`,
    auth: "client",
    body: { resolved: {} },
  },
  {
    label: "cloud plugin removal",
    method: "DELETE",
    path: `/workspace/${WORKSPACE_ID}/cloud-plugins/plugin_1`,
    auth: "client",
  },
  {
    label: "Claude plugin install",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/claude-plugins`,
    auth: "client",
    body: {
      url: "https://github.com/trap-owner/trap-plugin",
      dryRun: true,
    },
  },
  {
    label: "remote workspace creation",
    method: "POST",
    path: "/workspaces/remote",
    auth: "host",
    body: {
      baseUrl: "https://remote-workspace.invalid",
      remoteType: "opencode",
    },
  },
  {
    label: "quarantined remote workspace activation",
    method: "POST",
    path: `/workspaces/${REMOTE_WORKSPACE_ID}/activate`,
    auth: "host",
    body: { persist: false },
  },
  {
    label: "quarantined remote workspace rename",
    method: "PATCH",
    path: `/workspaces/${REMOTE_WORKSPACE_ID}/display-name`,
    auth: "host",
    body: { displayName: "Must Not Change" },
  },
  {
    label: "quarantined remote workspace deletion",
    method: "DELETE",
    path: `/workspaces/${REMOTE_WORKSPACE_ID}`,
    auth: "host",
  },
  {
    label: "plugin install",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/plugins`,
    auth: "client",
    body: { spec: "trap-plugin" },
  },
  {
    label: "plugin removal",
    method: "DELETE",
    path: `/workspace/${WORKSPACE_ID}/plugins/trap-plugin`,
    auth: "client",
  },
  {
    label: "canonical cloud MCP OpenCode proxy",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/opencode/mcp/openwork-cloud/connect`,
    auth: "client",
    body: {},
  },
  {
    label: "canonical OpenWork provider proxy",
    method: "PUT",
    path: `/workspace/${WORKSPACE_ID}/opencode/auth/openwork`,
    auth: "client",
    body: {},
  },
  {
    label: "canonical runtime-control OpenCode proxy",
    method: "POST",
    path: `/workspace/${WORKSPACE_ID}/opencode/global/upgrade`,
    auth: "client",
    body: {},
  },
  {
    label: "legacy workspace OpenCode proxy",
    method: "GET",
    path: `/w/${WORKSPACE_ID}/opencode/global/health`,
    auth: "client",
  },
  {
    label: "aggregate OpenCode proxy",
    method: "GET",
    path: "/opencode/global/health",
    auth: "client",
  },
  {
    label: "static root",
    method: "GET",
    path: "/",
    auth: "none",
  },
  {
    label: "static index",
    method: "GET",
    path: "/index.html",
    auth: "none",
  },
  {
    label: "static asset",
    method: "GET",
    path: "/assets/app.js",
    auth: "none",
  },
  {
    label: "toy UI",
    method: "GET",
    path: "/ui",
    auth: "none",
  },
  {
    label: "mounted toy UI",
    method: "GET",
    path: `/w/${WORKSPACE_ID}/ui`,
    auth: "none",
  },
  {
    label: "toy UI stylesheet",
    method: "GET",
    path: "/ui/assets/toy.css",
    auth: "none",
  },
  {
    label: "toy UI script",
    method: "GET",
    path: "/ui/assets/toy.js",
    auth: "none",
  },
  {
    label: "toy UI image",
    method: "GET",
    path: "/ui/assets/openwork-mark.svg",
    auth: "none",
  },
  {
    label: "dev log read",
    method: "GET",
    path: "/dev/log",
    auth: "none",
  },
  {
    label: "dev log write",
    method: "POST",
    path: "/dev/log",
    auth: "none",
    body: { level: "error", message: "must not be written" },
  },
] as const;

const dependencyHits: Array<{ method: string; path: string }> = [];
const environmentKeys = [
  "OPENWORK_STORAGE_ROOT",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENWORK_CONTROL_BASE_URL",
  "OPENWORK_CONTROL_TOKEN",
  "OPENWORK_GITHUB_API_BASE",
  "OPENWORK_GITHUB_RAW_BASE",
  "OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL",
  "OPENWORK_API_KEY",
  "OPENWORK_INFERENCE_BASE_URL",
  "OPENWORK_WEB_ROOT",
  "OPENWORK_TOY_UI",
  "OPENWORK_BROWSER_PROVIDER",
  "OPENWORK_SANDBOX_BACKEND",
  "OPENWORK_SANDBOX_ENABLED",
  "OPENWORK_DEV_LOG_FILE",
] as const;

const previousEnvironment = new Map<string, string | undefined>();
let root = "";
let workspaceRoot = "";
let devLogPath = "";
let serverConfigPath = "";
let baseUrl = "";
let trapBaseUrl = "";
let openworkServer: Served | null = null;
let dependencyTrap: ServeResult | null = null;
let opencodeHealthMode:
  | "healthy"
  | "unhealthy"
  | "redirect"
  | "wrong-version" = "healthy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestHeaders(
  auth: DisabledRouteCase["auth"],
  hasBody = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth === "client") headers.authorization = `Bearer ${CLIENT_TOKEN}`;
  if (auth === "host") headers["x-openwork-host-token"] = HOST_TOKEN;
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("expected a JSON object response");
  return body;
}

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...nestedKeys(entry),
  ]);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agencyai-local-route-policy-"));
  workspaceRoot = join(root, "workspace");
  serverConfigPath = join(root, "server.json");
  const webRoot = join(root, "web");
  devLogPath = join(root, "logs", "renderer.jsonl");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "opencode.jsonc"),
    "{}\n",
    "utf8",
  );
  await writeFile(
    join(webRoot, "index.html"),
    "<html><body>upstream static UI must stay absent</body></html>",
    "utf8",
  );
  await writeFile(
    join(webRoot, "assets", "app.js"),
    "throw new Error('upstream static asset must stay absent');\n",
    "utf8",
  );

  dependencyTrap = await serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      dependencyHits.push({ method: request.method, path: url.pathname });
      if (url.pathname === "/global/health") {
        if (opencodeHealthMode === "redirect") {
          return new Response(null, {
            status: 302,
            headers: {
              location: `${trapBaseUrl}/readiness-redirect-target`,
            },
          });
        }
        if (opencodeHealthMode === "unhealthy") {
          return Response.json(
            { code: "opencode_unhealthy" },
            { status: 503 },
          );
        }
        return Response.json({
          healthy: true,
          version: opencodeHealthMode === "wrong-version"
            ? "1.17.12"
            : "1.17.11",
          source: "dependency-trap",
        });
      }
      return Response.json(
        { code: "dependency_trap_hit", path: url.pathname },
        { status: 599 },
      );
    },
  });
  trapBaseUrl = `http://127.0.0.1:${dependencyTrap.port}`;

  for (const key of environmentKeys) {
    previousEnvironment.set(key, process.env[key]);
  }
  delete process.env.OPENWORK_STORAGE_ROOT;
  Object.assign(process.env, {
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_TOKEN_STORE: join(root, "tokens.json"),
    OPENWORK_ENV_STORE: join(root, "env.json"),
    OPENWORK_MCP_AUTH_PATH: join(root, "mcp-auth.json"),
    OPENCODE_CONFIG_DIR: join(root, "global-opencode"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENWORK_CONTROL_BASE_URL: trapBaseUrl,
    OPENWORK_CONTROL_TOKEN: CONTROL_TOKEN,
    OPENWORK_GITHUB_API_BASE: trapBaseUrl,
    OPENWORK_GITHUB_RAW_BASE: trapBaseUrl,
    OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL: trapBaseUrl,
    OPENWORK_API_KEY: PROVIDER_SECRET,
    OPENWORK_INFERENCE_BASE_URL: trapBaseUrl,
    OPENWORK_WEB_ROOT: webRoot,
    OPENWORK_TOY_UI: "1",
    OPENWORK_BROWSER_PROVIDER: "host-interactive",
    OPENWORK_SANDBOX_BACKEND: "none",
    OPENWORK_SANDBOX_ENABLED: "1",
    OPENWORK_DEV_LOG_FILE: devLogPath,
  });

  const config = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: serverConfigPath,
    opencodeBaseUrl: trapBaseUrl,
    opencodeDirectory: workspaceRoot,
    opencodeUsername: "route-policy-engine",
    opencodePassword: OPENCODE_PASSWORD,
    approval: { mode: "manual", timeoutMs: 10 },
    corsOrigins: [RENDERER_ORIGIN],
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: "Local Route Policy",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: trapBaseUrl,
        directory: workspaceRoot,
      },
    ],
    quarantinedRemoteWorkspaces: [
      {
        id: REMOTE_WORKSPACE_ID,
        name: "Quarantined Remote",
        path: "",
        preset: "remote",
        workspaceType: "remote",
        remoteType: "openwork",
        baseUrl: "https://remote.invalid",
        openworkToken: REMOTE_WORKSPACE_SECRET,
      },
    ],
    quarantinedRemoteWorkspaceConfigs: [QUARANTINED_REMOTE_CONFIG],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: LOCAL_MVP_POLICY,
    opencodeDistribution: {
      source: "bundled-patched",
      binarySha256:
        "e25766b4da87ee02ec182dc7b78d2fc7fc051bb1e875b97e165485f82fc6640a",
      sourceBinarySha256:
        "e25766b4da87ee02ec182dc7b78d2fc7fc051bb1e875b97e165485f82fc6640a",
      upstreamCommit: "67aec2212010d67775c35e696d8b8b54902eb338",
      forkCommit: "1f29421c5386d77e1655f6adbf4585cedce03bc1",
      forkTag: "product-opencode-v1.17.11-p3",
      patchset: "local-runtime-policy-v1",
    },
  } satisfies ServerConfig;

  openworkServer = await startServer(config);
  baseUrl = `http://127.0.0.1:${openworkServer.port}`;
  expect(dependencyHits).toEqual([]);
});

afterAll(async () => {
  await openworkServer?.stop(true);
  await dependencyTrap?.stop();
  for (const key of environmentKeys) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local-mvp route policy", () => {
  test("exposes only the minimal unauthenticated health payload", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(dependencyHits).toHaveLength(before);
  });

  test("keeps authenticated readiness free of local secrets and coordinates", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch("/ready", {
      headers: requestHeaders("client"),
    });
    const body = await responseRecord(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ready: true,
      productProfile: "local-mvp",
      features: {
        openworkCloud: false,
        analytics: false,
        automaticUpdates: false,
        runtimeDownloads: false,
      },
      bindings: {
        openwork: "loopback",
        opencode: "loopback",
      },
      opencode: {
        version: "1.17.11",
        healthy: true,
        source: "bundled-patched",
        binarySha256:
          "e25766b4da87ee02ec182dc7b78d2fc7fc051bb1e875b97e165485f82fc6640a",
        sourceBinarySha256:
          "e25766b4da87ee02ec182dc7b78d2fc7fc051bb1e875b97e165485f82fc6640a",
        upstreamCommit: "67aec2212010d67775c35e696d8b8b54902eb338",
        forkCommit: "1f29421c5386d77e1655f6adbf4585cedce03bc1",
        forkTag: "product-opencode-v1.17.11-p3",
        patchset: "local-runtime-policy-v1",
      },
      modelCatalog: { source: "opencode-embedded" },
    });
    expect(
      nestedKeys(body).filter((key) =>
        /token|port|path|workspace|provider|secret|credential|baseurl|directory/i.test(
          key,
        )
      ),
    ).toEqual([]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      CLIENT_TOKEN,
      HOST_TOKEN,
      OPENCODE_PASSWORD,
      PROVIDER_SECRET,
      CONTROL_TOKEN,
      REMOTE_WORKSPACE_SECRET,
      UNKNOWN_FIELD_SECRET,
      workspaceRoot,
      trapBaseUrl,
      String(openworkServer?.port),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(dependencyHits.slice(before)).toEqual([
      { method: "GET", path: "/global/health" },
    ]);
  });

  test("does not claim readiness when the loopback OpenCode health probe fails", async () => {
    const before = dependencyHits.length;
    opencodeHealthMode = "unhealthy";
    try {
      const response = await apiFetch("/ready", {
        headers: requestHeaders("client"),
      });
      const body = await responseRecord(response);

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        ready: false,
        bindings: {
          openwork: "loopback",
          opencode: "loopback",
        },
        opencode: {
          healthy: false,
        },
      });
      expect(dependencyHits.slice(before)).toEqual([
        { method: "GET", path: "/global/health" },
      ]);
    } finally {
      opencodeHealthMode = "healthy";
    }
  });

  test("does not follow redirects while probing OpenCode readiness", async () => {
    const before = dependencyHits.length;
    opencodeHealthMode = "redirect";
    try {
      const response = await apiFetch("/ready", {
        headers: requestHeaders("client"),
      });
      const body = await responseRecord(response);

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        ready: false,
        bindings: {
          openwork: "loopback",
          opencode: "loopback",
        },
        opencode: {
          healthy: false,
        },
      });
      expect(dependencyHits.slice(before)).toEqual([
        { method: "GET", path: "/global/health" },
      ]);
    } finally {
      opencodeHealthMode = "healthy";
    }
  });

  test("capabilities reflect omitted and runtime-narrowed local features", async () => {
    const response = await apiFetch("/capabilities", {
      headers: requestHeaders("client"),
    });
    const body = await responseRecord(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      plugins: {
        read: true,
        write: false,
      },
      ui: {
        toy: false,
      },
      sandbox: {
        enabled: false,
        backend: "none",
      },
      toolProviders: {
        browser: {
          enabled: false,
          placement: "external",
          mode: "none",
        },
      },
    });
  });

  for (const entry of DISABLED_ROUTES) {
    test(`keeps ${entry.label} absent without dependency I/O`, async () => {
      const before = dependencyHits.length;
      const hasBody = entry.body !== undefined;
      const response = await apiFetch(entry.path, {
        method: entry.method,
        headers: requestHeaders(entry.auth, hasBody),
        ...(hasBody ? { body: JSON.stringify(entry.body) } : {}),
      });
      const body = await responseRecord(response);

      expect(response.status).toBe(404);
      expect([
        "not_found",
        "feature_disabled",
        "opencode_proxy_not_allowed",
      ]).toContain(typeof body.code === "string" ? body.code : "");
      expect(dependencyHits).toHaveLength(before);
      if (entry.label === "dev log write") {
        expect(await Bun.file(devLogPath).exists()).toBe(false);
      }
    });
  }

  test("returns only effective local workspaces", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch("/workspaces", {
      headers: requestHeaders("client"),
    });
    const body = await responseRecord(response);
    const items = Array.isArray(body.items) ? body.items : [];
    const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];

    expect(response.status).toBe(200);
    expect(items).toHaveLength(1);
    expect(workspaces).toHaveLength(1);
    expect(items.every((item) =>
      isRecord(item) && item.workspaceType === "local"
    )).toBe(true);
    expect(workspaces.every((item) =>
      isRecord(item) && item.workspaceType === "local"
    )).toBe(true);
    expect(JSON.stringify(body)).not.toContain(REMOTE_WORKSPACE_ID);
    expect(JSON.stringify(body)).not.toContain(REMOTE_WORKSPACE_SECRET);
    expect(JSON.stringify(body)).not.toContain(UNKNOWN_FIELD_SECRET);
    expect(dependencyHits).toHaveLength(before);
  });

  test("preserves quarantined remote JSON verbatim across a local workspace write", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch(
      `/workspaces/${WORKSPACE_ID}/display-name`,
      {
        method: "PATCH",
        headers: requestHeaders("host", true),
        body: JSON.stringify({ displayName: "Renamed Local Workspace" }),
      },
    );
    const persisted: unknown = JSON.parse(
      await readFile(serverConfigPath, "utf8"),
    );
    const workspaces = isRecord(persisted) && Array.isArray(persisted.workspaces)
      ? persisted.workspaces
      : [];
    const quarantined = workspaces.find(
      (workspace) =>
        isRecord(workspace) && workspace.id === REMOTE_WORKSPACE_ID,
    );

    expect(response.status).toBe(200);
    expect(quarantined).toEqual(QUARANTINED_REMOTE_CONFIG);
    expect(dependencyHits).toHaveLength(before);
  });

  const allowedLocalRoutes = [
    { label: "client identity", path: "/whoami", auth: "client" },
    { label: "capabilities", path: "/capabilities", auth: "client" },
    {
      label: "workspace config",
      path: `/workspace/${WORKSPACE_ID}/config`,
      auth: "client",
    },
    {
      label: "plugin reads",
      path: `/workspace/${WORKSPACE_ID}/plugins`,
      auth: "client",
    },
    { label: "host token listing", path: "/tokens", auth: "host" },
    { label: "host env status", path: "/env/status", auth: "host" },
  ] as const;

  for (const entry of allowedLocalRoutes) {
    test(`keeps ordinary local route ${entry.label} available`, async () => {
      const before = dependencyHits.length;
      const response = await apiFetch(entry.path, {
        headers: requestHeaders(entry.auth),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(dependencyHits).toHaveLength(before);
    });
  }

  test("allows authenticated API traffic without Origin but never reflects one", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch("/whoami", {
      headers: requestHeaders("client"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin");
    expect(dependencyHits).toHaveLength(before);
  });

  test("handles exact-origin preflight without dependency I/O", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch(
      `/workspace/${WORKSPACE_ID}/opencode/global/health`,
      {
        method: "OPTIONS",
        headers: {
          origin: RENDERER_ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers":
            "Authorization, X-OpenCode-Directory",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      RENDERER_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, POST, PUT, PATCH, DELETE",
    );
    expect(response.headers.get("vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    expect(dependencyHits).toHaveLength(before);
  });

  test("allows the exact desktop origin and blocks bad origins before trap I/O", async () => {
    const beforeAllowed = dependencyHits.length;
    const allowed = await apiFetch(
      `/workspace/${WORKSPACE_ID}/opencode/global/health`,
      {
        headers: {
          ...requestHeaders("client"),
          origin: RENDERER_ORIGIN,
        },
      },
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      healthy: true,
      source: "dependency-trap",
      version: "1.17.11",
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      RENDERER_ORIGIN,
    );
    expect(dependencyHits.slice(beforeAllowed)).toEqual([
      { method: "GET", path: "/global/health" },
    ]);

    for (const origin of [
      "null",
      "*",
      "https://evil.invalid",
      `${RENDERER_ORIGIN}.evil.invalid`,
    ]) {
      const beforeDenied = dependencyHits.length;
      const denied = await apiFetch(
        `/workspace/${WORKSPACE_ID}/opencode/global/health`,
        {
          headers: {
            ...requestHeaders("client"),
            origin,
          },
        },
      );
      const body = await responseRecord(denied);

      expect(denied.status).toBe(403);
      expect(body.code).toBe("cors_origin_denied");
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      expect(dependencyHits).toHaveLength(beforeDenied);
    }
  });

  test("rejects an unknown preflight header before trap I/O", async () => {
    const before = dependencyHits.length;
    const response = await apiFetch(
      `/workspace/${WORKSPACE_ID}/opencode/global/health`,
      {
        method: "OPTIONS",
        headers: {
          origin: RENDERER_ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization, x-unknown",
        },
      },
    );
    const body = await responseRecord(response);

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "cors_preflight_denied",
      details: { reason: "preflight_header_not_allowed" },
    });
    expect(dependencyHits).toHaveLength(before);
  });

  test("does not claim readiness for a different OpenCode version", async () => {
    const before = dependencyHits.length;
    opencodeHealthMode = "wrong-version";
    try {
      const response = await apiFetch("/ready", {
        headers: requestHeaders("client"),
      });
      const body = await responseRecord(response);

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        ready: false,
        opencode: {
          version: "1.17.11",
          healthy: false,
          source: "bundled-patched",
        },
      });
      expect(dependencyHits.slice(before)).toEqual([
        { method: "GET", path: "/global/health" },
      ]);
    } finally {
      opencodeHealthMode = "healthy";
    }
  });
});
