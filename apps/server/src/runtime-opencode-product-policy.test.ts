import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerProductPolicy } from "./product-policy.js";
import { runtimeDbPath } from "./runtime-db.js";
import {
  mergeOpencodeConfigs,
  prepareRuntimeOpencodeConfigForProduct,
  readRuntimeMcpConfig,
  readRuntimeMcpPolicyQuarantine,
  readRuntimeOpencodeConfig,
  runtimeMcpMapForProduct,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const WORKSPACE_ID = "ws_local_policy";

async function setup(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "agencyai-runtime-mcp-policy-"));
  roots.push(root);
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "manual", timeoutMs: 1_000 },
    corsOrigins: ["agencyai://renderer"],
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Local",
      path: root,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
    productPolicy: resolveServerProductPolicy(),
  };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("local runtime MCP policy", () => {
  test("retains exact cloud records disabled while effective projections omit them", async () => {
    const config = await setup();
    const ordinary = { type: "remote", url: "https://ordinary.example/mcp", enabled: true };
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://blocked.example/mcp",
          enabled: true,
          headers: { authorization: "Bearer retained" },
        },
        " OpenWork-Cloud ": {
          type: "remote",
          url: "https://blocked-2.example/mcp",
          headers: { "x-retained": "yes" },
        },
        "openwork-cloud-dev": ordinary,
        posthog: ordinary,
      },
    }));

    const raw = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
    expect(raw.mcp?.["openwork-cloud"]).toEqual({
      type: "remote",
      url: "https://blocked.example/mcp",
      enabled: false,
      headers: { authorization: "Bearer retained" },
    });
    expect(raw.mcp?.[" OpenWork-Cloud "]).toEqual({
      type: "remote",
      url: "https://blocked-2.example/mcp",
      enabled: false,
      headers: { "x-retained": "yes" },
    });
    expect(runtimeMcpMapForProduct(raw, config.productPolicy)).toEqual({
      "openwork-cloud-dev": ordinary,
      posthog: ordinary,
    });
    expect(await readRuntimeMcpConfig(config, WORKSPACE_ID, "openwork-cloud")).toBeNull();
    expect(await readRuntimeMcpConfig(config, WORKSPACE_ID, "posthog")).toEqual(ordinary);

    const quarantine = await readRuntimeMcpPolicyQuarantine(config, WORKSPACE_ID);
    expect(quarantine.mcp["openwork-cloud"]?.originalEnabled).toEqual({
      present: true,
      value: true,
    });
    expect(quarantine.mcp[" OpenWork-Cloud "]?.originalEnabled).toEqual({
      present: false,
    });
  });

  test("is idempotent and never overwrites the first reversible state marker", async () => {
    const config = await setup();
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({
      mcp: {
        "openwork-cloud": {
          type: "remote",
          url: "https://blocked.example/mcp",
          enabled: true,
        },
      },
    }));
    const first = await readRuntimeMcpPolicyQuarantine(config, WORKSPACE_ID);

    const attemptedReenable = await writeRuntimeOpencodeConfig(
      config,
      WORKSPACE_ID,
      (current) => ({
        ...current,
        mcp: {
          ...current.mcp,
          "openwork-cloud": {
            ...current.mcp?.["openwork-cloud"],
            enabled: true,
          },
        },
      }),
    );
    const prepared = await prepareRuntimeOpencodeConfigForProduct(config, WORKSPACE_ID);
    const second = await readRuntimeMcpPolicyQuarantine(config, WORKSPACE_ID);

    expect(attemptedReenable.config.mcp?.["openwork-cloud"]?.enabled).toBe(false);
    expect(prepared.changed).toBe(false);
    expect(second).toEqual(first);
  });

  test("startup preparation quarantines a previously persisted enabled record", async () => {
    const config = await setup();
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({
      mcp: { ordinary: { type: "local", command: ["ordinary"] } },
    }));

    const sqlite = new Database(runtimeDbPath(config));
    try {
      sqlite.query(`
        UPDATE runtime_opencode_configs
        SET config_json = ?, updated_at = ?
        WHERE workspace_id = ?
      `).run(JSON.stringify({
        mcp: {
          "OPENWORK-CLOUD": {
            type: "remote",
            url: "https://blocked.example/mcp",
            enabled: true,
            headers: { "x-retained": "yes" },
          },
          ordinary: { type: "local", command: ["ordinary"] },
        },
      }), Date.now(), WORKSPACE_ID);
    } finally {
      sqlite.close();
    }

    const prepared = await prepareRuntimeOpencodeConfigForProduct(config, WORKSPACE_ID);
    expect(prepared.changed).toBe(true);
    expect(prepared.config.mcp?.["OPENWORK-CLOUD"]).toEqual({
      type: "remote",
      url: "https://blocked.example/mcp",
      enabled: false,
      headers: { "x-retained": "yes" },
    });
    expect(prepared.config.mcp?.ordinary).toEqual({
      type: "local",
      command: ["ordinary"],
    });
  });

  test("filters exact cloud names from persisted and runtime merge layers", async () => {
    const config = await setup();
    const merged = mergeOpencodeConfigs(
      {
        mcp: {
          " OpenWork-Cloud ": { type: "remote", url: "https://project-blocked.example/mcp" },
          project: { type: "local", command: ["project"] },
        },
      },
      {
        mcp: {
          "openwork-cloud": { type: "remote", url: "https://runtime-blocked.example/mcp" },
          runtime: { type: "local", command: ["runtime"] },
          "openwork-cloud-dev": { type: "local", command: ["near-match"] },
        },
      },
      config.productPolicy,
    );

    expect(merged.mcp).toEqual({
      project: { type: "local", command: ["project"] },
      runtime: { type: "local", command: ["runtime"] },
      "openwork-cloud-dev": { type: "local", command: ["near-match"] },
    });
  });
});
