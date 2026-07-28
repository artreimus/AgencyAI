import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const previousSandboxBackend = process.env.OPENWORK_SANDBOX_BACKEND;
const previousSandboxEnabled = process.env.OPENWORK_SANDBOX_ENABLED;

afterEach(() => {
  if (previousSandboxBackend === undefined) {
    delete process.env.OPENWORK_SANDBOX_BACKEND;
  } else {
    process.env.OPENWORK_SANDBOX_BACKEND = previousSandboxBackend;
  }
  if (previousSandboxEnabled === undefined) {
    delete process.env.OPENWORK_SANDBOX_ENABLED;
  } else {
    process.env.OPENWORK_SANDBOX_ENABLED = previousSandboxEnabled;
  }
});

test("upstream compatibility keeps an explicit sandbox enable flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-capabilities-policy-"));
  process.env.OPENWORK_SANDBOX_BACKEND = "none";
  process.env.OPENWORK_SANDBOX_ENABLED = "1";
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_capabilities_policy_client",
    hostToken: "owt_capabilities_policy_host",
    configPath: join(root, "server.json"),
    approval: { mode: "manual", timeoutMs: 100 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
  const server = await startServer(config);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/capabilities`,
      {
        headers: {
          authorization: `Bearer ${config.token}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sandbox: {
        enabled: true,
        backend: "none",
      },
    });
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
