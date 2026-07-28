import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MVP_FEATURES } from "@openwork/product-config";

import {
  AGENCYAI_DESKTOP_APPROVAL_HEADER,
  DesktopApprovalCredentialService,
  type TrustedDesktopOperation,
} from "./desktop-approval-credentials.js";
import { buildOpenworkRuntimeConfigObject } from "./openwork-runtime-config.js";
import type { ServerProductPolicy } from "./product-policy.js";
import {
  mergeOpencodeConfigs,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderListForProduct,
  runtimeMcpMapForProduct,
  runtimePluginListForProduct,
  runtimeProviderMapForProduct,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_local_config_mutation";
const CLIENT_TOKEN = "owt_local_config_mutation_client";
const HOST_TOKEN = "owt_local_config_mutation_host";
const RENDERER_ORIGIN = "agencyai-internal://renderer";

const LOCAL_MVP_POLICY = Object.freeze({
  profile: "local-mvp",
  features: LOCAL_MVP_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: RENDERER_ORIGIN,
}) satisfies ServerProductPolicy;

const environmentKeys = [
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_DATA_DIR",
  "OPENWORK_CACHE_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
] as const;

const previousEnvironment = new Map<string, string | undefined>();
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

type Harness = {
  baseUrl: string;
  config: ServerConfig;
  credentials: DesktopApprovalCredentialService;
  workspaceRoot: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Expected JSON object response");
  return body;
}

function reserveEphemeralPort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  reservation.stop(true);
  if (typeof port !== "number") {
    throw new Error("Failed to reserve a loopback test port");
  }
  return port;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "agencyai-local-config-mutation-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "opencode.jsonc"), "{}\n", "utf8");
  await writeFile(
    join(root, "server.json"),
    JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2) + "\n",
    "utf8",
  );

  for (const key of environmentKeys) {
    if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key]);
  }
  Object.assign(process.env, {
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_TOKEN_STORE: join(root, "tokens.json"),
    OPENWORK_ENV_STORE: join(root, "env.json"),
    OPENWORK_MCP_AUTH_PATH: join(root, "mcp-auth.json"),
    OPENWORK_DATA_DIR: join(root, "data"),
    OPENWORK_CACHE_DIR: join(root, "cache"),
    OPENCODE_CONFIG_DIR: join(root, "global-opencode"),
    OPENCODE_DB: join(root, "opencode.db"),
  });

  const credentials = new DesktopApprovalCredentialService({ ttlMs: 60_000 });
  const config = {
    host: "127.0.0.1",
    port: reserveEphemeralPort(),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(root, "server.json"),
    approval: { mode: "trusted-local-ui", timeoutMs: 25 },
    corsOrigins: [RENDERER_ORIGIN],
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Local Workspace",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: LOCAL_MVP_POLICY,
    desktopApprovalCredentials: credentials,
  } satisfies ServerConfig;

  const server = await startServer(config);
  stops.push(() => server.stop());
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    config,
    credentials,
    workspaceRoot,
  };
}

function issueCredential(
  harness: Harness,
  operation: TrustedDesktopOperation,
): string {
  return harness.credentials.issue({
    bearerToken: CLIENT_TOKEN,
    rendererOrigin: RENDERER_ORIGIN,
    serverOrigin: harness.baseUrl,
    webContentsId: 17,
    workspaceId: WORKSPACE_ID,
    operation,
  }).credential;
}

function trustedHeaders(
  harness: Harness,
  operation: TrustedDesktopOperation,
): Record<string, string> {
  return {
    authorization: `Bearer ${CLIENT_TOKEN}`,
    origin: RENDERER_ORIGIN,
    "content-type": "application/json",
    [AGENCYAI_DESKTOP_APPROVAL_HEADER]: issueCredential(harness, operation),
  };
}

async function expectFeatureDisabled(response: Response): Promise<void> {
  const body = await responseRecord(response);
  expect(response.status).toBe(404);
  expect(body.code).toBe("feature_disabled");
}

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment.clear();
});

describe("local-MVP immutable config mutation policy", () => {
  test("trusted config.patch cannot add runtime plugins or blocked provider/MCP identities", async () => {
    const harness = await createHarness();
    const blockedUpdates = [
      { plugin: ["https://plugins.invalid/remote-plugin.js"] },
      { provider: { openwork: { npm: "@openwork/models" } } },
      { provider: { " LPR_Team ": { npm: "@openwork/team-provider" } } },
      {
        mcp: {
          " OpenWork-Cloud ": {
            type: "remote",
            url: "https://api.openworklabs.com/mcp/agent",
          },
        },
      },
    ];

    for (const opencode of blockedUpdates) {
      const response = await fetch(
        `${harness.baseUrl}/workspace/${WORKSPACE_ID}/config`,
        {
          method: "PATCH",
          headers: trustedHeaders(harness, "config.patch"),
          body: JSON.stringify({ opencode }),
        },
      );
      await expectFeatureDisabled(response);
    }

    expect(await readRuntimeOpencodeConfig(harness.config, WORKSPACE_ID)).toEqual({});
  });

  test("engine-visible runtime ignores hostile stored plugins/providers and forces hosted provider denial", async () => {
    const harness = await createHarness();
    await writeRuntimeOpencodeConfig(harness.config, WORKSPACE_ID, () => ({
      plugin: ["https://plugins.invalid/remote-plugin.js"],
      disabled_providers: [],
      provider: {
        openwork: { npm: "@openwork/models" },
        " LPR_Team ": { npm: "@openwork/team-provider" },
        ordinary: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
        },
      },
      experimental: {
        allowedLocalSetting: "preserved",
        openTelemetry: true,
      },
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://api.openworklabs.com/mcp/agent",
        },
        ordinary: { type: "local", command: ["ordinary-mcp"] },
      },
    }));

    const stored = await readRuntimeOpencodeConfig(harness.config, WORKSPACE_ID);
    expect(stored.plugin).toEqual(["https://plugins.invalid/remote-plugin.js"]);
    expect(stored.provider).toHaveProperty("openwork");
    expect(stored.provider).toHaveProperty(" LPR_Team ");
    expect(runtimePluginListForProduct(
      stored,
      harness.config.productPolicy,
    )).toEqual([]);
    expect(runtimeProviderMapForProduct(
      stored,
      harness.config.productPolicy,
    )).toEqual({
      ordinary: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
      },
    });
    expect(runtimeDisabledProviderListForProduct(
      stored,
      harness.config.productPolicy,
    )).toEqual(["opencode"]);
    expect(runtimeMcpMapForProduct(
      stored,
      harness.config.productPolicy,
    )).toEqual({
      ordinary: { type: "local", command: ["ordinary-mcp"] },
    });

    const effective = await buildOpenworkRuntimeConfigObject(
      harness.config,
      WORKSPACE_ID,
    );
    const plugins = Array.isArray(effective.plugin) ? effective.plugin : [];
    const providers = isRecord(effective.provider) ? effective.provider : {};
    const disabledProviders = Array.isArray(effective.disabled_providers)
      ? effective.disabled_providers
      : [];

    expect(plugins).not.toContain("https://plugins.invalid/remote-plugin.js");
    expect(providers).toEqual({
      ordinary: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1" },
      },
    });
    expect(disabledProviders).toContain("opencode");
    expect(effective.experimental).toEqual({
      allowedLocalSetting: "preserved",
      openTelemetry: false,
    });
    expect(effective.mcp).toEqual({
      ordinary: { type: "local", command: ["ordinary-mcp"] },
    });

    const merged = mergeOpencodeConfigs(
      {
        plugin: ["https://plugins.invalid/project-plugin.js"],
        disabled_providers: [],
        provider: {
          lpr_project: { npm: "@openwork/project-provider" },
          persisted: { npm: "@ai-sdk/anthropic" },
        },
        mcp: {
          " OPENWORK-CLOUD ": { type: "remote", url: "https://blocked.invalid" },
          persisted: { type: "local", command: ["persisted-mcp"] },
        },
        experimental: {
          persistedSetting: true,
          openTelemetry: true,
        },
      },
      stored,
      harness.config.productPolicy,
    );
    expect(merged).toMatchObject({
      autoupdate: false,
      share: "disabled",
      plugin: [],
      disabled_providers: ["opencode"],
      provider: {
        persisted: { npm: "@ai-sdk/anthropic" },
        ordinary: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:11434/v1" },
        },
      },
      mcp: {
        persisted: { type: "local", command: ["persisted-mcp"] },
        ordinary: { type: "local", command: ["ordinary-mcp"] },
      },
      experimental: {
        persistedSetting: true,
        allowedLocalSetting: "preserved",
        openTelemetry: false,
      },
    });
  });

  test("raw project/global config writes cannot broaden local product policy", async () => {
    const harness = await createHarness();
    const blockedProjectConfigs = [
      { plugin: ["https://plugins.invalid/remote-plugin.js"] },
      { provider: { openwork: { npm: "@openwork/models" } } },
      { provider: { lpr_team: { npm: "@openwork/team-provider" } } },
      {
        mcp: {
          "OPENWORK-CLOUD": {
            type: "remote",
            url: "https://api.openworklabs.com/mcp/agent",
          },
        },
      },
      { share: "auto" },
      { autoupdate: true },
      { experimental: { openTelemetry: true } },
    ];

    for (const content of blockedProjectConfigs) {
      const response = await fetch(
        `${harness.baseUrl}/workspace/${WORKSPACE_ID}/opencode-config`,
        {
          method: "POST",
          headers: trustedHeaders(harness, "config.write"),
          body: JSON.stringify({
            scope: "project",
            content: JSON.stringify(content),
          }),
        },
      );
      await expectFeatureDisabled(response);
    }

    const globalResponse = await fetch(
      `${harness.baseUrl}/workspace/${WORKSPACE_ID}/opencode-config`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${CLIENT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: "global",
          content: JSON.stringify({ provider: { ordinary: {} } }),
        }),
      },
    );
    await expectFeatureDisabled(globalResponse);

    expect(
      await readFile(
        join(harness.workspaceRoot, ".opencode", "opencode.jsonc"),
        "utf8",
      ),
    ).toBe("{}\n");
  });

  test("legacy runtime migration is absent when legacy import is compiled out", async () => {
    const harness = await createHarness();
    const response = await fetch(
      `${harness.baseUrl}/workspace/${WORKSPACE_ID}/runtime-config/migrate`,
      {
        method: "POST",
        headers: trustedHeaders(harness, "config.runtime_migrate"),
        body: "{}",
      },
    );

    expect(response.status).toBe(404);
    expect(await responseRecord(response)).toMatchObject({
      code: "not_found",
    });
  });

  test("disabled-provider mutation requires the same trusted config.patch grant", async () => {
    const harness = await createHarness();
    const path = `${harness.baseUrl}/workspace/${WORKSPACE_ID}/runtime-config/disabled-providers`;
    const denied = await fetch(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ providers: ["anthropic"] }),
    });

    expect(denied.status).toBe(403);
    expect(await responseRecord(denied)).toMatchObject({
      code: "write_denied",
      details: { reason: "timeout" },
    });
    expect(await readRuntimeOpencodeConfig(
      harness.config,
      WORKSPACE_ID,
    )).toEqual({});

    const allowed = await fetch(path, {
      method: "POST",
      headers: trustedHeaders(harness, "config.patch"),
      body: JSON.stringify({ providers: ["anthropic"] }),
    });

    expect(allowed.status).toBe(200);
    expect(await responseRecord(allowed)).toEqual({
      ok: true,
      disabledProviders: ["anthropic", "opencode"],
    });
  });
});
