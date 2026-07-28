import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createRuntimeManager } from "./runtime.mjs";

const TRUSTED_RENDERER_ORIGIN = "agencyai-internal://renderer";
const RAW_GRANT = "aai_da_runtime-test-secret";

const cleanup = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()();
  }
});

async function listenJsonApi(workspacePath) {
  let baseUrl = "";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/tokens") {
      response.end(JSON.stringify({ token: "owner-token-exposed-to-renderer" }));
      return;
    }
    if (request.method === "GET" && request.url === "/workspaces") {
      response.end(JSON.stringify({
        items: [{
          id: "ws_selected",
          opencode: {
            baseUrl,
            directory: workspacePath,
          },
        }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl, port: address.port };
}

async function createHarness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agencyai-runtime-approval-"));
  const userData = path.join(root, "user-data");
  const workspacePath = path.join(root, "workspace");
  await mkdir(userData, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  const previousServerConfig = process.env.OPENWORK_SERVER_CONFIG;
  process.env.OPENWORK_SERVER_CONFIG = path.join(root, "server.json");
  cleanup.push(async () => {
    if (previousServerConfig === undefined) {
      delete process.env.OPENWORK_SERVER_CONFIG;
    } else {
      process.env.OPENWORK_SERVER_CONFIG = previousServerConfig;
    }
  });

  const api = await listenJsonApi(workspacePath);
  const launchOptions = [];
  const issueInputs = [];
  const revokedWebContents = [];
  let revokeAllCalls = 0;
  let stopCalls = 0;

  const productPolicy = {
    profile: "local-mvp",
    features: {
      remoteAccess: false,
      openworkCloud: false,
    },
    networkPolicy: "air-gapped",
    rendererOrigin: TRUSTED_RENDERER_ORIGIN,
  };

  const handle = {
    port: api.port,
    url: api.baseUrl,
    config: {
      workspaces: [{ id: "ws_selected", path: workspacePath }],
    },
    storage: null,
    managedOpencodeExecution: null,
    managedOpencode: null,
    ...(options.issueSupported === false
      ? {}
      : {
          async issueDesktopApprovalGrant(input) {
            issueInputs.push(input);
            return {
              credential: RAW_GRANT,
              credentialId: "aai_dac_runtime-test",
              serverOrigin: api.baseUrl,
              workspaceId: input.workspaceId,
              operation: input.operation,
              issuedAt: 1_000,
              expiresAt: 31_000,
            };
          },
        }),
    async revokeDesktopApprovalGrantsForWebContents(webContentsId) {
      revokedWebContents.push(webContentsId);
      return 1;
    },
    async revokeAllDesktopApprovalGrants() {
      revokeAllCalls += 1;
      return 2;
    },
    async stop() {
      stopCalls += 1;
    },
  };

  const runtime = createRuntimeManager({
    app: {
      getPath(name) {
        if (name === "userData") return userData;
        if (name === "exe") return path.join(root, "AgencyAI");
        if (name === "home") return root;
        throw new Error(`Unexpected app path: ${name}`);
      },
    },
    desktopRoot: path.join(root, "desktop"),
    listLocalWorkspacePaths: async () => [workspacePath],
    allowRemoteAccess: true,
    productPolicy,
    trustedRendererOrigin: TRUSTED_RENDERER_ORIGIN,
    embeddedServerModuleLoader: async () => ({
      async startEmbeddedServer(input) {
        launchOptions.push(input);
        return handle;
      },
    }),
  });
  cleanup.push(() => runtime.dispose());

  return {
    runtime,
    userData,
    workspacePath,
    productPolicy,
    launchOptions,
    issueInputs,
    revokedWebContents,
    counters: {
      get revokeAllCalls() {
        return revokeAllCalls;
      },
      get stopCalls() {
        return stopCalls;
      },
    },
  };
}

describe("desktop approval runtime plumbing", () => {
  it("launches local-mvp with immutable policy, loopback-only binding, exact CORS, and trusted approval mode", async () => {
    const harness = await createHarness();
    harness.productPolicy.features.remoteAccess = true;

    await harness.runtime.openworkServerRestart({ remoteAccessEnabled: true });

    assert.equal(harness.launchOptions.length, 1);
    const launch = harness.launchOptions[0];
    assert.equal(launch.host, "127.0.0.1");
    assert.deepEqual(launch.corsOrigins, [TRUSTED_RENDERER_ORIGIN]);
    assert.equal(launch.corsOrigins.includes("*"), false);
    assert.equal(launch.approvalMode, "trusted-local-ui");
    assert.equal(launch.trustedRendererOrigin, TRUSTED_RENDERER_ORIGIN);
    assert.equal(launch.productPolicy.profile, "local-mvp");
    assert.equal(launch.productPolicy.features.remoteAccess, false);
    assert.equal(Object.isFrozen(launch.productPolicy), true);
    assert.equal(Object.isFrozen(launch.productPolicy.features), true);

    const info = await harness.runtime.openworkServerInfo();
    assert.equal(info.remoteAccessEnabled, false);
    assert.equal(info.host, "127.0.0.1");
    assert.equal(info.connectUrl, null);
  });

  it("issues against the active handle with the exact origins and renderer-exposed owner bearer", async () => {
    const harness = await createHarness();
    await harness.runtime.openworkServerRestart();

    const grant = await harness.runtime.desktopApprovalGrant({
      workspaceId: "ws_selected",
      operation: "workspace.file.write",
      webContentsId: 17,
    });

    assert.deepEqual(grant, {
      credential: RAW_GRANT,
      credentialId: "aai_dac_runtime-test",
      serverOrigin: harness.launchOptions[0].host === "127.0.0.1"
        ? (await harness.runtime.openworkServerInfo()).baseUrl
        : null,
      workspaceId: "ws_selected",
      operation: "workspace.file.write",
      issuedAt: 1_000,
      expiresAt: 31_000,
    });
    assert.deepEqual(harness.issueInputs, [{
      bearerToken: "owner-token-exposed-to-renderer",
      rendererOrigin: TRUSTED_RENDERER_ORIGIN,
      serverOrigin: grant.serverOrigin,
      webContentsId: 17,
      workspaceId: "ws_selected",
      operation: "workspace.file.write",
    }]);
  });

  it("does not retain a raw grant in runtime snapshots or token persistence", async () => {
    const harness = await createHarness();
    await harness.runtime.openworkServerRestart();
    await harness.runtime.desktopApprovalGrant({
      workspaceId: "ws_selected",
      operation: "mcp.add",
      webContentsId: 19,
    });

    const snapshots = JSON.stringify({
      info: await harness.runtime.openworkServerInfo(),
      status: await harness.runtime.runtimeStatus(),
    });
    assert.equal(snapshots.includes(RAW_GRANT), false);
    assert.equal(snapshots.includes("aai_dac_runtime-test"), false);

    const tokenStore = await readFile(
      path.join(harness.userData, "openwork-server-tokens.json"),
      "utf8",
    );
    assert.equal(tokenStore.includes(RAW_GRANT), false);
    assert.equal(tokenStore.includes("aai_dac_runtime-test"), false);
  });

  it("fails when the embedded runtime is stopped or lacks an issuance method", async () => {
    const stopped = await createHarness();
    await assert.rejects(
      stopped.runtime.desktopApprovalGrant({
        workspaceId: "ws_selected",
        operation: "workspace.file.write",
        webContentsId: 17,
      }),
      /Embedded OpenWork server is not running/,
    );

    const unsupported = await createHarness({ issueSupported: false });
    await unsupported.runtime.openworkServerRestart();
    await assert.rejects(
      unsupported.runtime.desktopApprovalGrant({
        workspaceId: "ws_selected",
        operation: "workspace.file.write",
        webContentsId: 17,
      }),
      /does not support desktop approval grants/,
    );
  });

  it("forwards targeted revocation and revokes all grants during shutdown", async () => {
    const harness = await createHarness();
    await harness.runtime.openworkServerRestart();

    assert.equal(
      await harness.runtime.revokeDesktopApprovalGrantsForWebContents(42),
      1,
    );
    assert.deepEqual(harness.revokedWebContents, [42]);
    assert.equal(await harness.runtime.revokeAllDesktopApprovalGrants(), 2);

    await harness.runtime.dispose();
    assert.equal(harness.counters.revokeAllCalls, 2);
    assert.equal(harness.counters.stopCalls, 1);
  });
});
