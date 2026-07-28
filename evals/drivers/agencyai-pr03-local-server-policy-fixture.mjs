import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PREFIX = "agencyai-pr03-";
const RESULT_MARKER = "AGENCYAI_PR03_RESULT ";
const RENDERER_ORIGIN = "agencyai-internal://renderer";
const CLIENT_TOKEN = "owt_agencyai_pr03_client";
const HOST_TOKEN = "owt_agencyai_pr03_host";
const OPENCODE_PASSWORD = "agencyai-pr03-opencode-password";
const PROVIDER_SECRET = "agencyai-pr03-provider-secret";
const WORKSPACE_ID = "ws_agencyai_pr03";
const OTHER_WORKSPACE_ID = "ws_agencyai_pr03_other";

export const FRAME_DEFINITIONS = Object.freeze([
  Object.freeze({
    frame: 1,
    id: "readiness",
    claim: "Authenticated readiness is local-mvp, loopback-only, and non-secret",
  }),
  Object.freeze({
    frame: 2,
    id: "route-policy",
    claim: "Disabled product routes fail closed while ordinary local APIs remain available",
  }),
  Object.freeze({
    frame: 3,
    id: "mcp-quarantine",
    claim: "Persisted openwork-cloud MCP state is reversibly quarantined while ordinary MCP syncs",
  }),
  Object.freeze({
    frame: 4,
    id: "proxy-allowlist",
    claim: "The OpenCode proxy forwards only its reviewed local allowlist",
  }),
  Object.freeze({
    frame: 5,
    id: "desktop-approval",
    claim: "Desktop approval trust is exact-origin, one-use, workspace-scoped, and separate from OpenCode permission",
  }),
  Object.freeze({
    frame: 6,
    id: "local-agent",
    claim: "Local prompts and plugins omit hosted steering while a local task completes without unexpected egress",
  }),
]);

const SERVER_MODULES = Object.freeze({
  server: new URL("../../apps/server/src/server.ts", import.meta.url).href,
  runtimeConfig: new URL(
    "../../apps/server/src/runtime-opencode-config-store.ts",
    import.meta.url,
  ).href,
  runtimeDb: new URL("../../apps/server/src/runtime-db.ts", import.meta.url).href,
  productContract: new URL(
    "../../packages/product-config/src/contract.ts",
    import.meta.url,
  ).href,
  desktopApproval: new URL(
    "../../apps/server/src/desktop-approval-credentials.ts",
    import.meta.url,
  ).href,
  generatedConfig: new URL(
    "../../apps/server/src/openwork-runtime-config.ts",
    import.meta.url,
  ).href,
  localCapabilities: new URL(
    "../../apps/server/src/opencode-plugins/agencyai-local-capabilities.ts",
    import.meta.url,
  ).href,
  localExtensions: new URL(
    "../../apps/server/src/opencode-plugins/agencyai-local-extensions.ts",
    import.meta.url,
  ).href,
});

const ENVIRONMENT_KEYS = Object.freeze([
  "OPENWORK_STORAGE_ROOT",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_TOKEN_STORE",
  "OPENWORK_ENV_STORE",
  "OPENWORK_MCP_AUTH_PATH",
  "OPENWORK_DATA_DIR",
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
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function nestedKeys(value) {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...nestedKeys(entry),
  ]);
}

function normalizeMcpName(value) {
  return String(value).normalize("NFKC").trim().toLowerCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createChecks() {
  const checks = [];
  return {
    pass(label, actual) {
      checks.push({
        label,
        passed: true,
        ...(actual === undefined ? {} : { actual }),
      });
    },
    expect(condition, label, actual) {
      if (!condition) {
        throw new Error(
          `${label}${actual === undefined ? "" : ` (actual: ${stableJson(actual)})`}`,
        );
      }
      this.pass(label, actual);
    },
    list: checks,
  };
}

export function resolveFixtureRoot(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("fixture root is required");
  }
  const resolved = resolve(value);
  const temporaryRoot = resolve(tmpdir());
  const relation = relative(temporaryRoot, resolved);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || relation.includes(`${sep}..${sep}`)
    || basename(resolved).startsWith(FIXTURE_PREFIX) === false
  ) {
    throw new Error(
      `fixture root must be a ${FIXTURE_PREFIX}* directory inside ${temporaryRoot}`,
    );
  }
  return resolved;
}

async function createFixture(rootInput) {
  const root = resolveFixtureRoot(rootInput);
  const entries = await readdir(root);
  if (entries.length > 0) {
    throw new Error(`fixture root must be empty: ${root}`);
  }

  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  for (const directory of [workspace, otherWorkspace]) {
    await mkdir(join(directory, ".opencode"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, ".opencode", "opencode.jsonc"),
      "{}\n",
      "utf8",
    );
  }
  await writeFile(
    join(workspace, "README.md"),
    "# AgencyAI PR03 isolated acceptance fixture\n",
    "utf8",
  );

  return {
    root,
    workspace,
    otherWorkspace,
    configPath: join(root, "server.json"),
    runtimeDbPath: join(root, "runtime.sqlite"),
  };
}

function responseJson(value, status = 200) {
  return Response.json(value, { status });
}

async function requestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const text = await request.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function startEngineTrap() {
  const requests = [];
  const pendingPermission = {
    id: "req_local",
    sessionID: "ses_local",
    permission: "bash",
    patterns: ["echo local"],
    metadata: {},
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await requestBody(request);
      requests.push({
        method: request.method,
        path: url.pathname,
        body,
      });

      if (url.pathname === "/global/health") {
        return responseJson({ healthy: true, version: "1.17.11" });
      }
      if (url.pathname === "/session" && request.method === "POST") {
        return responseJson({ id: "ses_local", title: "Local task" });
      }
      if (
        url.pathname === "/session/ses_local/prompt_async"
        && request.method === "POST"
      ) {
        return responseJson({ accepted: true });
      }
      if (
        url.pathname === "/session/ses_local/message"
        && request.method === "GET"
      ) {
        return responseJson([
          {
            info: { id: "msg_local", role: "assistant" },
            parts: [{ type: "text", text: "agencyai local task ok" }],
          },
        ]);
      }
      if (url.pathname === "/permission" && request.method === "GET") {
        return responseJson([pendingPermission]);
      }
      if (
        url.pathname === "/permission/req_local/reply"
        && request.method === "POST"
      ) {
        return responseJson({ ok: true });
      }
      if (url.pathname === "/provider") {
        return responseJson({ providers: [], default: {} });
      }
      if (url.pathname === "/mcp" && request.method === "GET") {
        return responseJson({ github: { status: "connected" } });
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = isRecord(body) && typeof body.name === "string"
          ? body.name
          : "unknown";
        return responseJson({ [name]: { status: "connected" } });
      }
      if (url.pathname === "/find/file") return responseJson([]);
      if (url.pathname === "/question") return responseJson([]);
      if (url.pathname === "/config") return responseJson({});
      if (url.pathname === "/session") return responseJson([]);
      return responseJson({ ok: true, path: url.pathname });
    },
  });
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

function applyFixtureEnvironment(fixture, trapBaseUrl) {
  const previous = new Map(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    OPENWORK_RUNTIME_DB: fixture.runtimeDbPath,
    OPENWORK_TOKEN_STORE: join(fixture.root, "tokens.json"),
    OPENWORK_ENV_STORE: join(fixture.root, "env.json"),
    OPENWORK_MCP_AUTH_PATH: join(fixture.root, "mcp-auth.json"),
    OPENWORK_DATA_DIR: join(fixture.root, "data"),
    OPENCODE_CONFIG_DIR: join(fixture.root, "opencode-config"),
    OPENCODE_DB: join(fixture.root, "opencode.db"),
    OPENWORK_CONTROL_BASE_URL: `${trapBaseUrl}/disabled-control`,
    OPENWORK_CONTROL_TOKEN: "agencyai-pr03-control-token",
    OPENWORK_GITHUB_API_BASE: `${trapBaseUrl}/disabled-github-api`,
    OPENWORK_GITHUB_RAW_BASE: `${trapBaseUrl}/disabled-github-raw`,
    OPENWORK_GOOGLE_WORKSPACE_TOKEN_BROKER_URL:
      `${trapBaseUrl}/disabled-google-workspace`,
    OPENWORK_API_KEY: PROVIDER_SECRET,
    OPENWORK_INFERENCE_BASE_URL: `${trapBaseUrl}/disabled-inference`,
    OPENWORK_TOY_UI: "1",
    OPENWORK_BROWSER_PROVIDER: "none",
    OPENWORK_SANDBOX_BACKEND: "none",
    OPENWORK_SANDBOX_ENABLED: "0",
    OPENWORK_DEV_LOG_FILE: join(fixture.root, "renderer.jsonl"),
  });
  delete process.env.OPENWORK_STORAGE_ROOT;
  delete process.env.OPENWORK_SERVER_CONFIG;
  delete process.env.OPENWORK_WEB_ROOT;

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function loadCoreModules() {
  const [
    server,
    productContract,
    desktopApproval,
  ] = await Promise.all([
    import(SERVER_MODULES.server),
    import(SERVER_MODULES.productContract),
    import(SERVER_MODULES.desktopApproval),
  ]);
  return { server, productContract, desktopApproval };
}

function localProductPolicy(features) {
  return Object.freeze({
    profile: "local-mvp",
    features: Object.freeze({
      ...features,
      browserAutomation: false,
      computerUse: false,
    }),
    networkPolicy: "user-authorized",
    rendererOrigin: RENDERER_ORIGIN,
  });
}

function buildServerConfig(
  fixture,
  trap,
  features,
  options = {},
) {
  const workspace = {
    id: WORKSPACE_ID,
    name: "PR03 Local Workspace",
    path: fixture.workspace,
    preset: "starter",
    workspaceType: "local",
    baseUrl: trap.baseUrl,
    directory: fixture.workspace,
  };
  const otherWorkspace = {
    id: OTHER_WORKSPACE_ID,
    name: "PR03 Other Workspace",
    path: fixture.otherWorkspace,
    preset: "starter",
    workspaceType: "local",
    baseUrl: trap.baseUrl,
    directory: fixture.otherWorkspace,
  };
  return {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: fixture.configPath,
    opencodeBaseUrl: trap.baseUrl,
    opencodeDirectory: fixture.workspace,
    opencodeUsername: "agencyai-pr03-engine",
    opencodePassword: OPENCODE_PASSWORD,
    approval: options.approval ?? { mode: "manual", timeoutMs: 250 },
    corsOrigins: [RENDERER_ORIGIN],
    workspaces: options.includeOtherWorkspace
      ? [workspace, otherWorkspace]
      : [workspace],
    authorizedRoots: options.includeOtherWorkspace
      ? [fixture.workspace, fixture.otherWorkspace]
      : [fixture.workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: localProductPolicy(features),
    ...(options.desktopApprovalCredentials
      ? { desktopApprovalCredentials: options.desktopApprovalCredentials }
      : {}),
  };
}

function clientHeaders(input = {}) {
  return {
    authorization: `Bearer ${input.token ?? CLIENT_TOKEN}`,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.credential
      ? { "x-agencyai-desktop-approval": input.credential }
      : {}),
    ...(input.json === false ? {} : { "content-type": "application/json" }),
  };
}

function hostHeaders(json = false) {
  return {
    "x-openwork-host-token": HOST_TOKEN,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function responseValue(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]";
}

async function withRunningServer(rootInput, options, run) {
  const fixture = await createFixture(rootInput);
  const trap = startEngineTrap();
  const restoreEnvironment = applyFixtureEnvironment(fixture, trap.baseUrl);
  let openwork = null;
  try {
    const modules = await loadCoreModules();
    const config = buildServerConfig(
      fixture,
      trap,
      modules.productContract.LOCAL_MVP_FEATURES,
      options,
    );
    openwork = await modules.server.startServer(config);
    const baseUrl = `http://127.0.0.1:${openwork.port}`;
    return await run({
      fixture,
      trap,
      modules,
      config,
      openwork,
      baseUrl,
    });
  } finally {
    await openwork?.stop(true);
    trap.server.stop(true);
    restoreEnvironment();
  }
}

async function frameOne(rootInput) {
  return withRunningServer(rootInput, {}, async ({
    fixture,
    trap,
    baseUrl,
    openwork,
  }) => {
    const checks = createChecks();
    const response = await fetch(`${baseUrl}/ready`, {
      headers: clientHeaders({ json: false }),
    });
    const body = await responseValue(response);
    assert(isRecord(body), "readiness payload was not an object");

    checks.expect(response.status === 200, "authenticated readiness returns 200");
    checks.expect(body.ready === true, "readiness reports ready");
    checks.expect(
      body.productProfile === "local-mvp",
      "readiness reports the immutable local-mvp profile",
      body.productProfile,
    );
    const features = isRecord(body.features) ? body.features : {};
    for (const feature of [
      "openworkCloud",
      "analytics",
      "automaticUpdates",
      "runtimeDownloads",
    ]) {
      checks.expect(
        features[feature] === false,
        `${feature} is disabled`,
        features[feature],
      );
    }
    const bindings = isRecord(body.bindings) ? body.bindings : {};
    checks.expect(
      bindings.openwork === "loopback" && bindings.opencode === "loopback",
      "AgencyAI and OpenCode bindings are loopback-only",
      bindings,
    );
    const opencode = isRecord(body.opencode) ? body.opencode : {};
    checks.expect(
      opencode.healthy === true,
      "loopback OpenCode is healthy",
      opencode.healthy,
    );

    const forbiddenKeys = nestedKeys(body).filter((key) =>
      /token|port|path|workspace|provider|secret|credential|baseurl|directory/i
        .test(key)
    );
    checks.expect(
      forbiddenKeys.length === 0,
      "readiness has no secret or local-coordinate keys",
      forbiddenKeys,
    );
    const serialized = JSON.stringify(body);
    const forbiddenValues = [
      CLIENT_TOKEN,
      HOST_TOKEN,
      OPENCODE_PASSWORD,
      PROVIDER_SECRET,
      fixture.root,
      fixture.workspace,
      "PR03 Local Workspace",
      String(openwork.port),
      String(trap.server.port),
    ].filter((value) => serialized.includes(value));
    checks.expect(
      forbiddenValues.length === 0,
      "readiness exposes no token, port, local path, provider secret, or workspace name",
      forbiddenValues,
    );
    checks.expect(
      trap.requests.filter((entry) => entry.path === "/global/health").length
        === 1,
      "readiness performs one loopback health probe",
    );

    return {
      passed: true,
      frame: 1,
      checks: checks.list,
      evidence: {
        productProfile: body.productProfile,
        features: {
          openworkCloud: features.openworkCloud,
          analytics: features.analytics,
          automaticUpdates: features.automaticUpdates,
          runtimeDownloads: features.runtimeDownloads,
        },
        bindings,
        opencode: { healthy: opencode.healthy },
        secretScan: {
          forbiddenKeys: [],
          forbiddenValues: [],
        },
      },
    };
  });
}

async function frameTwo(rootInput) {
  return withRunningServer(rootInput, {}, async ({
    trap,
    baseUrl,
  }) => {
    const checks = createChecks();
    const disabledRoutes = [
      {
        category: "Cloud MCP",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/mcp/openwork-cloud/health`,
        auth: "client",
      },
      {
        category: "Connect",
        method: "GET",
        path: "/experimental/connect/state",
        auth: "client",
      },
      {
        category: "Google Workspace",
        method: "GET",
        path: "/experimental/google-workspace/status",
        auth: "client",
      },
      {
        category: "cloud sync",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/desktop-cloud-sync`,
        auth: "client",
      },
      {
        category: "cloud marketplace",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/cloud-plugins`,
        auth: "client",
      },
      {
        category: "voice",
        method: "POST",
        path: "/voice/realtime/session",
        auth: "host",
        body: {},
      },
      {
        category: "runtime upgrade",
        method: "POST",
        path: "/runtime/upgrade",
        auth: "host",
        body: {},
      },
      {
        category: "remote workspace",
        method: "POST",
        path: "/workspaces/remote",
        auth: "host",
        body: {
          baseUrl: "https://remote.invalid",
          remoteType: "opencode",
        },
      },
    ];
    const disabledEvidence = [];
    for (const route of disabledRoutes) {
      const before = trap.requests.length;
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.auth === "host"
          ? hostHeaders(route.body !== undefined)
          : clientHeaders({ json: route.body !== undefined }),
        ...(route.body === undefined
          ? {}
          : { body: JSON.stringify(route.body) }),
      });
      const body = await responseValue(response);
      const code = isRecord(body) && typeof body.code === "string"
        ? body.code
        : null;
      checks.expect(
        response.status === 404,
        `${route.category} route is absent`,
        response.status,
      );
      checks.expect(
        ["not_found", "feature_disabled", "opencode_proxy_not_allowed"]
          .includes(code),
        `${route.category} returns a stable disabled code`,
        code,
      );
      checks.expect(
        trap.requests.length === before,
        `${route.category} fails before dependency I/O`,
      );
      disabledEvidence.push({
        category: route.category,
        status: response.status,
        code,
        dependencyRequests: 0,
      });
    }

    const localRoutes = [
      {
        category: "workspace",
        method: "GET",
        path: "/workspaces",
        auth: "client",
      },
      {
        category: "session",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/opencode/session`,
        auth: "client",
      },
      {
        category: "provider",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/opencode/provider`,
        auth: "client",
      },
      {
        category: "file",
        method: "POST",
        path: `/workspace/${WORKSPACE_ID}/files/sessions`,
        auth: "client",
        body: { write: false },
      },
      {
        category: "artifact",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/artifacts`,
        auth: "client",
      },
      {
        category: "approval",
        method: "GET",
        path: "/approvals",
        auth: "host",
      },
      {
        category: "ordinary MCP",
        method: "GET",
        path: `/workspace/${WORKSPACE_ID}/mcp`,
        auth: "client",
      },
    ];
    const localEvidence = [];
    for (const route of localRoutes) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.auth === "host"
          ? hostHeaders(route.body !== undefined)
          : clientHeaders({ json: route.body !== undefined }),
        ...(route.body === undefined
          ? {}
          : { body: JSON.stringify(route.body) }),
      });
      checks.expect(
        response.status === 200,
        `${route.category} local API remains available`,
        response.status,
      );
      localEvidence.push({
        category: route.category,
        status: response.status,
      });
      await response.arrayBuffer();
    }

    return {
      passed: true,
      frame: 2,
      checks: checks.list,
      evidence: {
        disabledRoutes: disabledEvidence,
        localApis: localEvidence,
      },
    };
  });
}

async function frameThree(rootInput) {
  const fixture = await createFixture(rootInput);
  const trap = startEngineTrap();
  const restoreEnvironment = applyFixtureEnvironment(fixture, trap.baseUrl);
  let openwork = null;
  try {
    const [
      modules,
      runtimeConfig,
      runtimeDb,
      sqliteModule,
    ] = await Promise.all([
      loadCoreModules(),
      import(SERVER_MODULES.runtimeConfig),
      import(SERVER_MODULES.runtimeDb),
      import("bun:sqlite"),
    ]);
    const config = buildServerConfig(
      fixture,
      trap,
      modules.productContract.LOCAL_MVP_FEATURES,
    );
    await runtimeConfig.writeRuntimeOpencodeConfig(
      config,
      WORKSPACE_ID,
      () => ({
        mcp: {
          ordinary: {
            type: "remote",
            url: "https://ordinary-third-party.invalid/mcp",
            enabled: true,
          },
        },
      }),
    );

    const sqlite = new sqliteModule.Database(runtimeDb.runtimeDbPath(config));
    try {
      sqlite.query(`
        UPDATE runtime_opencode_configs
        SET config_json = ?, updated_at = ?
        WHERE workspace_id = ?
      `).run(JSON.stringify({
        mcp: {
          "openwork-cloud": {
            type: "remote",
            url: "https://openwork-cloud.invalid/mcp",
            enabled: true,
            headers: { authorization: "Bearer reversible-marker" },
          },
          ordinary: {
            type: "remote",
            url: "https://ordinary-third-party.invalid/mcp",
            enabled: true,
          },
        },
      }), Date.now(), WORKSPACE_ID);
    } finally {
      sqlite.close();
    }

    openwork = await modules.server.startServer(config);
    await runtimeConfig.prepareRuntimeOpencodeConfigForProduct(
      config,
      WORKSPACE_ID,
    );
    await modules.server.syncAllWorkspacesRuntimeMcpToEngine(config);
    await Bun.sleep(25);

    const checks = createChecks();
    const persisted = await runtimeConfig.readRuntimeOpencodeConfig(
      config,
      WORKSPACE_ID,
    );
    const quarantine = await runtimeConfig.readRuntimeMcpPolicyQuarantine(
      config,
      WORKSPACE_ID,
    );
    const cloud = persisted.mcp?.["openwork-cloud"];
    const ordinary = persisted.mcp?.ordinary;
    checks.expect(
      isRecord(cloud) && cloud.enabled === false,
      "persisted openwork-cloud record is preserved but disabled",
      cloud,
    );
    checks.expect(
      isRecord(cloud) && cloud.url === "https://openwork-cloud.invalid/mcp",
      "cloud MCP payload remains reversible",
    );
    checks.expect(
      isRecord(ordinary) && ordinary.enabled === true,
      "ordinary MCP remains enabled",
      ordinary,
    );
    const originalEnabled =
      quarantine.mcp?.["openwork-cloud"]?.originalEnabled;
    checks.expect(
      isRecord(originalEnabled)
        && originalEnabled.present === true
        && originalEnabled.value === true,
      "quarantine records the cloud MCP original enabled state",
      originalEnabled,
    );

    const registrationRequests = trap.requests.filter((entry) =>
      entry.method === "POST" && entry.path === "/mcp"
    );
    const registeredNames = registrationRequests.flatMap((entry) =>
      isRecord(entry.body) && typeof entry.body.name === "string"
        ? [entry.body.name]
        : []
    );
    checks.expect(
      registeredNames.includes("ordinary"),
      "ordinary MCP is synchronized to the loopback engine",
      registeredNames,
    );
    checks.expect(
      registeredNames.every((name) =>
        normalizeMcpName(name) !== "openwork-cloud"
      ),
      "openwork-cloud is never registered with the engine",
      registeredNames,
    );
    checks.expect(
      trap.requests.every((entry) =>
        !JSON.stringify(entry).includes("openwork-cloud.invalid")
      ),
      "the quarantined cloud endpoint is never contacted or forwarded",
    );

    return {
      passed: true,
      frame: 3,
      checks: checks.list,
      evidence: {
        restartBoundary: [
          "persisted enabled cloud record seeded",
          "AgencyAI startup policy applied",
          "OpenCode engine reload sync completed",
        ],
        cloudRecord: {
          preserved: true,
          enabled: false,
          originalEnabled: true,
          registeredWithEngine: false,
        },
        ordinaryMcp: {
          enabled: true,
          registeredWithEngine: true,
        },
      },
    };
  } finally {
    await openwork?.stop(true);
    trap.server.stop(true);
    restoreEnvironment();
  }
}

async function frameFour(rootInput) {
  return withRunningServer(rootInput, {}, async ({
    trap,
    baseUrl,
  }) => {
    const checks = createChecks();
    const allowed = [
      { family: "session", method: "GET", path: "/session" },
      { family: "provider", method: "GET", path: "/provider" },
      { family: "MCP", method: "GET", path: "/mcp" },
      { family: "file", method: "GET", path: "/find/file" },
      { family: "question", method: "GET", path: "/question" },
      { family: "permission", method: "GET", path: "/permission" },
    ];
    const allowedEvidence = [];
    for (const route of allowed) {
      const before = trap.requests.length;
      const response = await fetch(
        `${baseUrl}/workspace/${WORKSPACE_ID}/opencode${route.path}`,
        { method: route.method, headers: clientHeaders({ json: false }) },
      );
      checks.expect(
        response.status === 200,
        `${route.family} allowlisted method succeeds`,
        response.status,
      );
      const forwarded = trap.requests.slice(before);
      checks.expect(
        forwarded.length === 1
          && forwarded[0].method === route.method
          && forwarded[0].path === route.path,
        `${route.family} reaches the loopback engine exactly once`,
        forwarded,
      );
      allowedEvidence.push({
        family: route.family,
        method: route.method,
        path: route.path,
        status: response.status,
        engineRequests: 1,
      });
      await response.arrayBuffer();
    }

    const denied = [
      { family: "global upgrade", method: "POST", path: "/global/upgrade" },
      { family: "sharing", method: "POST", path: "/session/ses_local/share" },
      { family: "account", method: "GET", path: "/api/account" },
      {
        family: "control-plane",
        method: "POST",
        path: "/experimental/control-plane/move-session",
      },
      { family: "upstream web UI", method: "GET", path: "/" },
      {
        family: "configuration mutation",
        method: "PATCH",
        path: "/config",
      },
    ];
    const deniedEvidence = [];
    for (const route of denied) {
      const before = trap.requests.length;
      const response = await fetch(
        `${baseUrl}/workspace/${WORKSPACE_ID}/opencode${route.path}`,
        {
          method: route.method,
          headers: clientHeaders({ json: route.method !== "GET" }),
          ...(route.method === "GET" ? {} : { body: "{}" }),
        },
      );
      const body = await responseValue(response);
      const code = isRecord(body) && typeof body.code === "string"
        ? body.code
        : null;
      checks.expect(
        response.status === 404 && code === "opencode_proxy_not_allowed",
        `${route.family} is denied by the proxy`,
        { status: response.status, code },
      );
      checks.expect(
        trap.requests.length === before,
        `${route.family} is denied before the engine sees it`,
      );
      deniedEvidence.push({
        family: route.family,
        method: route.method,
        path: route.path,
        status: response.status,
        code,
        engineRequests: 0,
      });
    }

    return {
      passed: true,
      frame: 4,
      checks: checks.list,
      evidence: {
        allowed: allowedEvidence,
        denied: deniedEvidence,
      },
    };
  });
}

async function frameFive(rootInput) {
  const fixture = await createFixture(rootInput);
  const trap = startEngineTrap();
  const restoreEnvironment = applyFixtureEnvironment(fixture, trap.baseUrl);
  let openwork = null;
  let clock = 1_000;
  try {
    const modules = await loadCoreModules();
    const credentials =
      new modules.desktopApproval.DesktopApprovalCredentialService({
        ttlMs: 1_000,
        now: () => clock,
      });
    const config = buildServerConfig(
      fixture,
      trap,
      modules.productContract.LOCAL_MVP_FEATURES,
      {
        approval: { mode: "trusted-local-ui", timeoutMs: 5_000 },
        includeOtherWorkspace: true,
        desktopApprovalCredentials: credentials,
      },
    );
    openwork = await modules.server.startServer(config);
    const baseUrl = `http://127.0.0.1:${openwork.port}`;
    const checks = createChecks();

    const issue = (workspaceId = WORKSPACE_ID) => credentials.issue({
      bearerToken: CLIENT_TOKEN,
      rendererOrigin: RENDERER_ORIGIN,
      serverOrigin: baseUrl,
      webContentsId: 17,
      workspaceId,
      operation: "config.patch",
    });
    const patch = (workspaceId, value, input = {}) => fetch(
      `${baseUrl}/workspace/${workspaceId}/config`,
      {
        method: "PATCH",
        headers: clientHeaders({
          origin: input.origin ?? RENDERER_ORIGIN,
          credential: input.credential,
        }),
        body: JSON.stringify({ openwork: value }),
      },
    );

    const exactGrant = issue();
    const approved = await patch(
      WORKSPACE_ID,
      { acceptance: "approved-once" },
      { credential: exactGrant.credential },
    );
    checks.expect(
      approved.status === 200,
      "fresh credential at the exact renderer origin auto-approves one reviewed wrapper operation",
      approved.status,
    );
    await approved.arrayBuffer();

    const replay = await patch(
      WORKSPACE_ID,
      { acceptance: "replay" },
      { credential: exactGrant.credential },
    );
    checks.expect(
      replay.status === 401,
      "the desktop credential is single-use",
      replay.status,
    );
    await replay.arrayBuffer();

    const wrongOriginGrant = issue();
    const wrongOrigin = await patch(
      WORKSPACE_ID,
      { acceptance: "wrong-origin" },
      {
        credential: wrongOriginGrant.credential,
        origin: "agencyai-internal://other-renderer",
      },
    );
    checks.expect(
      wrongOrigin.status === 403,
      "an unapproved renderer origin is denied",
      wrongOrigin.status,
    );
    await wrongOrigin.arrayBuffer();

    const wrongWorkspaceGrant = issue();
    const wrongWorkspace = await patch(
      OTHER_WORKSPACE_ID,
      { acceptance: "wrong-workspace" },
      { credential: wrongWorkspaceGrant.credential },
    );
    checks.expect(
      wrongWorkspace.status === 403,
      "a desktop credential cannot cross workspace scope",
      wrongWorkspace.status,
    );
    await wrongWorkspace.arrayBuffer();

    const spoofed = await patch(
      WORKSPACE_ID,
      { acceptance: "spoofed" },
      { credential: `aai_da_${"s".repeat(43)}` },
    );
    checks.expect(
      spoofed.status === 401,
      "a spoofed desktop credential is denied",
      spoofed.status,
    );
    await spoofed.arrayBuffer();

    const expiredGrant = issue();
    clock = expiredGrant.expiresAt;
    const expired = await patch(
      WORKSPACE_ID,
      { acceptance: "expired" },
      { credential: expiredGrant.credential },
    );
    checks.expect(
      expired.status === 401,
      "an expired desktop credential is denied",
      expired.status,
    );
    await expired.arrayBuffer();

    const bearerWrite = patch(
      WORKSPACE_ID,
      { acceptance: "bearer-only" },
    );
    let pending = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/approvals`, {
        headers: hostHeaders(),
      });
      const body = await responseValue(response);
      const items = isRecord(body) && Array.isArray(body.items)
        ? body.items
        : [];
      if (items[0]) {
        pending = items[0];
        break;
      }
      await Bun.sleep(10);
    }
    assert(isRecord(pending), "bearer-only request did not enter manual review");
    checks.expect(
      isRecord(pending.actor) && pending.actor.type === "api",
      "a bearer request without the desktop credential remains manual",
      pending.actor,
    );
    const approvalId = pending.id;
    assert(typeof approvalId === "string", "manual approval id was missing");
    const denial = await fetch(`${baseUrl}/approvals/${approvalId}`, {
      method: "POST",
      headers: hostHeaders(true),
      body: JSON.stringify({ reply: "deny" }),
    });
    checks.expect(
      denial.status === 200,
      "manual bearer request can be explicitly denied",
      denial.status,
    );
    await denial.arrayBuffer();
    const deniedBearerWrite = await bearerWrite;
    checks.expect(
      deniedBearerWrite.status === 403,
      "denied bearer-only wrapper mutation does not execute",
      deniedBearerWrite.status,
    );
    await deniedBearerWrite.arrayBuffer();

    const replyRequestsBefore = trap.requests.filter((entry) =>
      entry.path === "/permission/req_local/reply"
    ).length;
    const permissionResponse = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/permission`,
      { headers: clientHeaders({ json: false }) },
    );
    const permissions = await responseValue(permissionResponse);
    checks.expect(
      permissionResponse.status === 200
        && Array.isArray(permissions)
        && permissions.some((entry) =>
          isRecord(entry) && entry.id === "req_local"
        ),
      "OpenCode's pending tool-permission prompt remains visible",
      permissions,
    );
    checks.expect(
      replyRequestsBefore === 0,
      "wrapper auto-approval does not answer OpenCode permission",
      replyRequestsBefore,
    );
    const permissionReply = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/permission/req_local/reply`,
      {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify({ reply: "once" }),
      },
    );
    checks.expect(
      permissionReply.status === 200,
      "OpenCode permission succeeds only after an explicit answer",
      permissionReply.status,
    );
    await permissionReply.arrayBuffer();
    const replyRequestsAfter = trap.requests.filter((entry) =>
      entry.path === "/permission/req_local/reply"
    ).length;
    checks.expect(
      replyRequestsAfter === 1,
      "the explicit OpenCode permission answer reaches the engine once",
      replyRequestsAfter,
    );

    const auditResponse = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/audit`,
      { headers: clientHeaders({ json: false }) },
    );
    const audit = await responseValue(auditResponse);
    const auditItems = isRecord(audit) && Array.isArray(audit.items)
      ? audit.items
      : [];
    checks.expect(
      auditItems.some((entry) =>
        isRecord(entry)
        && isRecord(entry.actor)
        && entry.actor.type === "desktop"
      ),
      "approved wrapper operation is attributed to the desktop actor",
    );

    return {
      passed: true,
      frame: 5,
      checks: checks.list,
      evidence: {
        desktopApproval: {
          exactOriginFreshCredential: "approved once",
          replay: "denied",
          unapprovedOrigin: "denied",
          otherWorkspace: "denied",
          spoofed: "denied",
          expired: "denied",
          bearerWithoutCredential: "manual then denied",
          actor: "desktop",
        },
        opencodePermission: {
          promptVisible: true,
          wrapperAutoAnswered: false,
          explicitReplyRequired: true,
        },
      },
    };
  } finally {
    await openwork?.stop(true);
    trap.server.stop(true);
    restoreEnvironment();
  }
}

async function frameSix(rootInput) {
  const fixture = await createFixture(rootInput);
  const trap = startEngineTrap();
  const restoreEnvironment = applyFixtureEnvironment(fixture, trap.baseUrl);
  const originalFetch = globalThis.fetch;
  const requestAudit = [];
  let openwork = null;
  try {
    globalThis.fetch = async (input, init) => {
      const rawUrl = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
      const url = new URL(rawUrl);
      requestAudit.push({
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
      });
      return originalFetch(input, init);
    };

    const [
      modules,
      generatedConfigModule,
      localCapabilitiesModule,
      localExtensionsModule,
    ] = await Promise.all([
      loadCoreModules(),
      import(SERVER_MODULES.generatedConfig),
      import(SERVER_MODULES.localCapabilities),
      import(SERVER_MODULES.localExtensions),
    ]);
    const checks = createChecks();
    const generated =
      generatedConfigModule.buildOpenworkRuntimeConfigObjectFromSnapshot({
        provider: {
          local: {
            name: "Local provider",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:11434/v1" },
          },
        },
        plugin: [
          "/plugins/user-plugin.ts",
          "/plugins/openwork-extensions-preview.ts",
          "/plugins/openwork-capabilities-knowledge.ts",
        ],
        mcp: {
          "openwork-cloud": {
            type: "remote",
            url: "https://openwork-cloud.invalid/mcp",
          },
          ordinary: { type: "local", command: ["ordinary"] },
        },
      }, true);
    const agents = isRecord(generated.agent) ? generated.agent : {};
    const localAgent = isRecord(agents.agencyai) ? agents.agencyai : {};
    const generatedPrompt = typeof localAgent.prompt === "string"
      ? localAgent.prompt
      : "";
    const capabilityPrompt =
      localCapabilitiesModule.agencyAiLocalCapabilitiesPrompt();

    let engineStatusCalls = 0;
    const plugin = await localExtensionsModule.AgencyAiLocalExtensions({
      client: {
        mcp: {
          async status() {
            engineStatusCalls += 1;
            return {
              data: {
                "openwork-cloud": { status: "connected" },
                github: { status: "connected" },
              },
            };
          },
        },
      },
      directory: fixture.workspace,
    });
    const extensionOutput = { system: [] };
    await plugin["experimental.chat.system.transform"]({}, extensionOutput);
    const extensionPrompt = extensionOutput.system.join("\n");
    const pluginNetworkRequests = requestAudit.length;
    const context = JSON.parse(await plugin.tool.openwork_context.execute());
    const pluginNetworkRequestsAfterContext = requestAudit.length;
    const serializedContext = JSON.stringify(context);

    const combinedGuidance = [
      generatedPrompt,
      capabilityPrompt,
      extensionPrompt,
    ].join("\n");
    const forbiddenSteering = [
      "OpenWork Cloud",
      "OpenWork Connect",
      "openwork-cloud",
      "Memory Bank",
      "search_capabilities",
      "execute_capability",
      "Google Workspace",
      "Voice Mode",
      "OpenAI Realtime",
      "Settings > Connect",
      "app.openworklabs.com",
      "api.openworklabs.com",
      "models.openworklabs.com",
      "/mcp/agent",
      "Den sign-in",
    ];
    const foundSteering = forbiddenSteering.filter((term) =>
      combinedGuidance.toLowerCase().includes(term.toLowerCase())
    );
    checks.expect(
      foundSteering.length === 0,
      "generated prompt and local plugins contain no cloud, Connect, Memory Bank, Google, or voice steering",
      foundSteering,
    );
    checks.expect(
      pluginNetworkRequests === 0
        && pluginNetworkRequestsAfterContext === 0,
      "local extensions perform no Connect or network probe",
      {
        transform: pluginNetworkRequests,
        context: pluginNetworkRequestsAfterContext,
      },
    );
    checks.expect(
      engineStatusCalls === 1
        && serializedContext.includes("mcp:github")
        && !serializedContext.includes("openwork-cloud"),
      "local extension context keeps ordinary MCP and filters openwork-cloud",
      { engineStatusCalls },
    );

    const pluginNames = Array.isArray(generated.plugin)
      ? generated.plugin
        .filter((value) => typeof value === "string")
        .map((value) => basename(value.replaceAll("\\", "/")))
      : [];
    checks.expect(
      pluginNames.includes("agencyai-local-capabilities.ts")
        && pluginNames.includes("agencyai-local-extensions.ts")
        && pluginNames.at(-1) === "agencyai-local-policy.ts",
      "generated config uses the local capabilities, extensions, and final policy plugins",
      pluginNames,
    );
    checks.expect(
      isRecord(generated.mcp)
        && isRecord(generated.mcp.ordinary)
        && !Object.keys(generated.mcp).some((name) =>
          normalizeMcpName(name) === "openwork-cloud"
        ),
      "generated config keeps ordinary MCP and removes exact openwork-cloud",
    );
    for (const surface of [
      "workspace",
      "session",
      "Skills",
      "Artifacts",
      "providers",
      "MCP",
    ]) {
      checks.expect(
        combinedGuidance.toLowerCase().includes(surface.toLowerCase()),
        `local guidance retains ${surface} support`,
      );
    }

    const config = buildServerConfig(
      fixture,
      trap,
      modules.productContract.LOCAL_MVP_FEATURES,
    );
    openwork = await modules.server.startServer(config);
    const baseUrl = `http://127.0.0.1:${openwork.port}`;
    const createSession = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/session`,
      {
        method: "POST",
        headers: clientHeaders(),
        body: "{}",
      },
    );
    const session = await responseValue(createSession);
    checks.expect(
      createSession.status === 200
        && isRecord(session)
        && session.id === "ses_local",
      "local session creation works",
      session,
    );
    const prompt = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/session/ses_local/prompt_async`,
      {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify({
          parts: [{ type: "text", text: "Return local success" }],
        }),
      },
    );
    checks.expect(
      prompt.status === 200,
      "local task prompt reaches OpenCode",
      prompt.status,
    );
    await prompt.arrayBuffer();
    const messagesResponse = await fetch(
      `${baseUrl}/workspace/${WORKSPACE_ID}/opencode/session/ses_local/message`,
      { headers: clientHeaders({ json: false }) },
    );
    const messages = await responseValue(messagesResponse);
    checks.expect(
      messagesResponse.status === 200
        && JSON.stringify(messages).includes("agencyai local task ok"),
      "local task returns the expected result",
      messages,
    );

    const nonLoopback = requestAudit.filter((entry) =>
      entry.protocol !== "http:"
      || !isLoopbackHostname(entry.hostname)
    );
    checks.expect(
      nonLoopback.length === 0,
      "request audit contains zero unexpected non-loopback traffic",
      nonLoopback,
    );

    return {
      passed: true,
      frame: 6,
      checks: checks.list,
      evidence: {
        steeringScan: {
          forbiddenTermsFound: [],
          connectProbeRequests: 0,
        },
        localSurfaces: [
          "sessions",
          "skills",
          "artifacts",
          "providers",
          "ordinary MCP",
          "task execution",
        ],
        localTask: "agencyai local task ok",
        requestAudit: {
          nonLoopbackRequests: 0,
          loopbackRequests: requestAudit.length,
        },
      },
    };
  } finally {
    globalThis.fetch = originalFetch;
    await openwork?.stop(true);
    trap.server.stop(true);
    restoreEnvironment();
  }
}

const FRAME_RUNNERS = new Map([
  [1, frameOne],
  [2, frameTwo],
  [3, frameThree],
  [4, frameFour],
  [5, frameFive],
  [6, frameSix],
]);

function resultLine(value) {
  return `${RESULT_MARKER}${JSON.stringify(value)}\n`;
}

async function main() {
  const mode = process.argv[2] ?? "";
  if (mode === "list") {
    process.stdout.write(
      `${stableJson({ passed: true, frames: FRAME_DEFINITIONS })}\n`,
    );
    return;
  }
  const frame = Number(mode);
  const root = process.argv[3] ?? "";
  const runner = FRAME_RUNNERS.get(frame);
  if (!runner) {
    throw new Error(
      "usage: agencyai-pr03-local-server-policy-fixture.mjs list|1|2|3|4|5|6 <fixture-root>",
    );
  }
  const result = await runner(root);
  process.stdout.write(resultLine(result));
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
