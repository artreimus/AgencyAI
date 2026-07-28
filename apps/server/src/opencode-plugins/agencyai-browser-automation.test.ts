import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Hooks,
  ToolContext,
} from "@opencode-ai/plugin";

import { AgencyAiBrowserAutomation } from "./agencyai-browser-automation.js";

const originalStorageRoot = process.env.OPENWORK_STORAGE_ROOT;
const originalDiscoveryPath = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
const bridgeToken = "a".repeat(64);

let storageRoot = "";
let discoveryPath = "";
let authorizedTargetIds = ["browser-target"];
let cdpRequests = 0;
let cdpServer: ReturnType<typeof Bun.serve>;
let bridgeServer: ReturnType<typeof Bun.serve>;
let hooks: Hooks;

const toolContext = {
  sessionID: "session",
  messageID: "message",
  agent: "agencyai",
  directory: "/tmp/workspace",
  worktree: "/tmp/workspace",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
} satisfies ToolContext;

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), "agencyai-browser-wrapper-"));
  discoveryPath = join(
    storageRoot,
    "electron",
    "user-data",
    "openwork-ui-control.json",
  );
  mkdirSync(join(storageRoot, "electron", "user-data"), { recursive: true });

  cdpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      cdpRequests += 1;
      const url = new URL(request.url);
      if (url.pathname !== "/json/list") {
        return new Response("not found", { status: 404 });
      }
      return Response.json([
        {
          id: "browser-target",
          type: "page",
          title: "Authorized page",
          url: "https://example.com/",
        },
        {
          id: "main-app-target",
          type: "page",
          title: "AgencyAI",
          url: "agencyai-internal://renderer/",
        },
      ]);
    },
  });

  bridgeServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/browser/targets"
        || request.headers.get("Authorization") !== `Bearer ${bridgeToken}`
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({
        ok: true,
        browser_url: `http://127.0.0.1:${cdpServer.port}`,
        target_ids: authorizedTargetIds,
      });
    },
  });

  writeFileSync(
    discoveryPath,
    `${JSON.stringify({
      baseUrl: `http://127.0.0.1:${bridgeServer.port}`,
      token: bridgeToken,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(discoveryPath, 0o600);
  process.env.OPENWORK_STORAGE_ROOT = storageRoot;
  process.env.OPENWORK_UI_CONTROL_DISCOVERY = discoveryPath;

  hooks = await AgencyAiBrowserAutomation({} as never);
});

afterAll(async () => {
  await Promise.all([
    bridgeServer?.stop(true),
    cdpServer?.stop(true),
  ]);
  rmSync(storageRoot, { recursive: true, force: true });
  if (originalStorageRoot === undefined) {
    delete process.env.OPENWORK_STORAGE_ROOT;
  } else {
    process.env.OPENWORK_STORAGE_ROOT = originalStorageRoot;
  }
  if (originalDiscoveryPath === undefined) {
    delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  } else {
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = originalDiscoveryPath;
  }
});

function browserTool(name: string) {
  const definition = hooks.tool?.[name];
  if (!definition) throw new Error(`Missing browser tool: ${name}`);
  return definition;
}

describe("AgencyAI browser automation wrapper", () => {
  test("exposes no model-controlled CDP endpoint and requires target IDs", async () => {
    const version = await browserTool("browser_version").execute(
      {},
      toolContext,
    );
    expect(version).toBe(
      "agencyai-browser-automation@1.0.4 (opencode-chrome-devtools@1.0.4)",
    );

    const snapshot = browserTool("browser_snapshot");
    expect("browser_url" in snapshot.args).toBe(false);
    expect(() => (
      snapshot.args.target_id as unknown as { parse(value: unknown): unknown }
    ).parse(undefined)).toThrow();
  });

  test("rejects app and unknown targets before contacting CDP", async () => {
    cdpRequests = 0;
    authorizedTargetIds = ["browser-target"];

    await expect(
      browserTool("browser_snapshot").execute(
        { target_id: "main-app-target" },
        toolContext,
      ),
    ).rejects.toThrow(/not authorized/);
    expect(cdpRequests).toBe(0);
  });

  test("rejects non-web navigation before contacting CDP", async () => {
    cdpRequests = 0;
    await expect(
      browserTool("browser_navigate").execute(
        {
          target_id: "browser-target",
          url: "agencyai-internal://renderer/",
        },
        toolContext,
      ),
    ).rejects.toThrow(/HTTP or HTTPS/);
    expect(cdpRequests).toBe(0);
  });

  test("filters browser discovery to the authenticated desktop allowlist", async () => {
    cdpRequests = 0;
    authorizedTargetIds = ["browser-target"];

    const output = await browserTool("browser_list").execute({}, toolContext);
    expect(output).toContain("[browser-target] Authorized page");
    expect(output).not.toContain("main-app-target");
    expect(output).not.toContain("AgencyAI");
    expect(cdpRequests).toBe(1);
  });
});
