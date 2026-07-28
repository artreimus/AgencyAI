import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_MVP_FEATURES,
  PRODUCT_FEATURES,
  type ProductFeatures,
} from "@openwork/product-config";
import { parse } from "jsonc-parser";

import {
  readLegacyConfigSweepState,
  sweepLegacyConfigContent,
  sweepLegacyOpenCodeConfig,
} from "./legacy-config-sweep.js";
import type { ServerProductPolicy } from "./product-policy.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const NOW = new Date("2026-07-15T12:34:56Z");
const LOCAL_MVP_POLICY = {
  profile: "local-mvp",
  features: LOCAL_MVP_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: "agencyai-internal://renderer",
} satisfies ServerProductPolicy;
const UPSTREAM_FEATURES = Object.freeze(
  Object.fromEntries(PRODUCT_FEATURES.map((feature) => [feature, true])),
) as ProductFeatures;
const UPSTREAM_POLICY = {
  profile: "upstream",
  features: UPSTREAM_FEATURES,
  networkPolicy: "user-authorized",
  rendererOrigin: "openwork-internal://renderer",
} satisfies ServerProductPolicy;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-legacy-config-sweep-"));
  roots.push(root);
  return root;
}

function configFor(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "owt_legacy_sweep_client",
    hostToken: "owt_legacy_sweep_host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function legacyDir(root: string): string {
  return join(root, ".config", "opencode");
}

async function writeLegacyFile(root: string, name: string, content: string): Promise<string> {
  await mkdir(legacyDir(root), { recursive: true });
  const path = join(legacyDir(root), name);
  await writeFile(path, content, "utf8");
  return path;
}

function parseRecord(content: string): Record<string, unknown> {
  const parsed: unknown = parse(content);
  return isRecord(parsed) ? parsed : {};
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("legacy OpenCode config sweep", () => {
  test("is side-effect free when legacy import is disabled", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const original = `{ "default_agent": "openwork" }\n`;
    const path = await writeLegacyFile(
      root,
      "opencode.jsonc",
      original,
    );

    const before = await readdir(root, { recursive: true });
    const state = await sweepLegacyOpenCodeConfig(config, {
      homeDir: root,
      now: NOW,
      productPolicy: LOCAL_MVP_POLICY,
    });

    expect(state).toEqual({
      version: 1,
      sweptAt: NOW.toISOString(),
      files: [],
      skipped: "feature_disabled",
    });
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(root, { recursive: true })).toEqual(before);
    expect(await readLegacyConfigSweepState(config)).toBeNull();
  });

  test("removes only OpenWork-managed legacy keys and preserves user content", () => {
    const original = `{
  // user MCP comment
  "mcp": {
    "my-notion": { "type": "remote", "url": "https://notion.example/mcp" },
    "openwork-cloud": { "type": "remote", "url": "https://cloud.example/mcp" }
  },
  "agent": {
    "openwork": { "mode": "primary" },
    "user-agent": { "mode": "subagent" }
  },
  "default_agent": "openwork",
  "plugin": [
    "user-plugin",
    "/tmp/opencode-plugins/openwork-office-attachments.js",
    "openwork-capabilities-knowledge"
  ],
  "userSetting": true
}
`;
    const swept = sweepLegacyConfigContent(original);
    const after = swept.content;
    const parsed = parseRecord(after);
    const mcp = isRecord(parsed.mcp) ? parsed.mcp : {};
    const agent = isRecord(parsed.agent) ? parsed.agent : {};
    const plugin = Array.isArray(parsed.plugin) ? parsed.plugin : [];

    expect(after).toContain("// user MCP comment");
    expect(mcp["my-notion"]).toEqual({ type: "remote", url: "https://notion.example/mcp" });
    expect(mcp["openwork-cloud"]).toBeUndefined();
    expect(agent["user-agent"]).toEqual({ mode: "subagent" });
    expect(agent.openwork).toBeUndefined();
    expect(parsed.default_agent).toBeUndefined();
    expect(plugin).toEqual(["user-plugin"]);
    expect(parsed.userSetting).toBe(true);
    expect(swept.removedKeys).toEqual([
      "mcp.openwork-cloud",
      "agent.openwork",
      "default_agent",
      "plugin",
    ]);
  });

  test("is idempotent after a successful content sweep", () => {
    const first = sweepLegacyConfigContent(
      `{ "default_agent": "openwork" }\n`,
    );
    const second = sweepLegacyConfigContent(first.content);

    expect(first.removedKeys).toEqual(["default_agent"]);
    expect(second).toEqual({
      content: first.content,
      removedKeys: [],
    });
  });

  test("leaves content without OpenWork-managed keys untouched", () => {
    const original = `{
  // keep this file exactly
  "mcp": { "my-notion": { "type": "remote" } },
  "plugin": ["user-plugin"]
}
`;
    expect(sweepLegacyConfigContent(original)).toEqual({
      content: original,
      removedKeys: [],
    });
  });

  test("cannot re-enable legacy import through a local runtime policy", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const original = `{ "default_agent": "openwork" }\n`;
    const path = await writeLegacyFile(root, "opencode.jsonc", original);
    const attemptedBroadening = {
      ...LOCAL_MVP_POLICY,
      features: {
        ...LOCAL_MVP_POLICY.features,
        legacyOpenWorkImport: true,
      },
    } satisfies ServerProductPolicy;

    const state = await sweepLegacyOpenCodeConfig(config, {
      homeDir: root,
      now: NOW,
      productPolicy: attemptedBroadening,
    });

    expect(state.skipped).toBe("feature_disabled");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readLegacyConfigSweepState(config)).toBeNull();
  });

  test("rejects an upstream runtime policy without touching local files", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const original = `{ "default_agent": "openwork" }\n`;
    const path = await writeLegacyFile(root, "opencode.jsonc", original);

    await expect(
      sweepLegacyOpenCodeConfig(config, {
        homeDir: root,
        now: NOW,
        productPolicy: UPSTREAM_POLICY,
      }),
    ).rejects.toThrow(
      "Server product profile upstream cannot replace compiled profile local-mvp",
    );
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readLegacyConfigSweepState(config)).toBeNull();
  });
});
