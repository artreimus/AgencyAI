import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgencyAiLocalExtensions } from "./agencyai-local-extensions.js";

const originalFetch = globalThis.fetch;
const originalStorageRoot = process.env.OPENWORK_STORAGE_ROOT;
const originalUiControlDiscovery =
  process.env.OPENWORK_UI_CONTROL_DISCOVERY;
const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;
const stops: Array<() => void> = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  while (stops.length) stops.pop()?.();
  while (temporaryRoots.length) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
  for (const [key, value] of [
    ["OPENWORK_STORAGE_ROOT", originalStorageRoot],
    ["OPENWORK_UI_CONTROL_DISCOVERY", originalUiControlDiscovery],
    ["OPENWORK_SERVER_URL", originalServerUrl],
    ["OPENWORK_SERVER_TOKEN", originalServerToken],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("AgencyAI local extensions plugin", () => {
  test("keeps local UI/session tools without Connect prompt or network probes", async () => {
    let fetchCalls = 0;
    let engineStatusCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected network call");
    }) as unknown as typeof fetch;

    const plugin = await AgencyAiLocalExtensions({
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
      directory: "/tmp/agencyai-workspace",
    });

    const output = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]({}, output);
    const prompt = output.system.join("\n");

    expect(prompt).toContain("AgencyAI app context");
    expect(prompt).toContain("AgencyAI local extensions");
    expect(prompt).toContain("Skill creation: Local");
    expect(prompt).not.toContain("OpenWork Cloud");
    expect(prompt).not.toContain("Settings → Connect");
    expect(prompt).not.toContain("remote skill");
    expect(fetchCalls).toBe(0);
    expect(engineStatusCalls).toBe(0);

    expect(Object.keys(plugin.tool).sort()).toEqual([
      "openwork_context",
      "openwork_execute",
      "openwork_query",
    ]);

    const context = JSON.parse(
      await plugin.tool.openwork_context.execute(),
    ) as {
      context: {
        contributions?: Array<{
          featureId?: string;
          provider?: { id?: string };
        }>;
      } | null;
      contributions?: Array<{
        featureId?: string;
        provider?: { id?: string };
      }>;
    };
    const contributions =
      context.context?.contributions ?? context.contributions ?? [];
    const serialized = JSON.stringify(contributions);

    expect(engineStatusCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(serialized).toContain("mcp:github");
    expect(serialized).not.toContain("openwork-cloud");
    expect(serialized).not.toContain("\"connect\"");
  });

  test("rejects non-loopback UI bridge and server URLs before fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "agencyai-local-plugin-"));
    temporaryRoots.push(root);
    const discoveryPath = join(root, "openwork-ui-control.json");
    await writeFile(
      discoveryPath,
      `${JSON.stringify({
        baseUrl: "https://example.invalid",
        token: "untrusted-bridge-token",
      })}\n`,
      "utf8",
    );
    Object.assign(process.env, {
      OPENWORK_STORAGE_ROOT: root,
      OPENWORK_UI_CONTROL_DISCOVERY: discoveryPath,
      OPENWORK_SERVER_URL: "https://example.invalid",
      OPENWORK_SERVER_TOKEN: "untrusted-server-token",
    });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;

    const plugin = await AgencyAiLocalExtensions();
    const context = JSON.parse(
      await plugin.tool.openwork_context.execute(),
    ) as { ui?: { ok?: boolean } };
    expect(context.ui?.ok).toBe(false);
    await expect(
      plugin.tool.openwork_query.execute({
        id: "extension.actions",
        args: {},
      }),
    ).rejects.toThrow("exact loopback HTTP origin");
    await expect(
      plugin.tool.openwork_execute.execute({
        id: "extension.call",
        args: {
          extensionId: "local-extension",
          action: "run",
          args: {},
        },
      }, {}),
    ).rejects.toThrow("exact loopback HTTP origin");
    expect(fetchCalls).toBe(0);
  });

  test("rejects every local bridge and server redirect before a second hop", async () => {
    const root = await mkdtemp(join(tmpdir(), "agencyai-local-plugin-"));
    temporaryRoots.push(root);
    const secondHop: Array<{ method: string; path: string }> = [];
    const second = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        secondHop.push({ method: request.method, path: url.pathname });
        return Response.json({ ok: true });
      },
    });
    stops.push(() => second.stop(true));
    const firstHop: Array<{
      method: string;
      path: string;
      body: string;
    }> = [];
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        firstHop.push({
          method: request.method,
          path: url.pathname,
          body: await request.text(),
        });
        return new Response(null, {
          status: 307,
          headers: {
            location:
              `http://127.0.0.1:${second.port}${url.pathname}${url.search}`,
          },
        });
      },
    });
    stops.push(() => first.stop(true));
    const discoveryPath = join(root, "openwork-ui-control.json");
    await writeFile(
      discoveryPath,
      `${JSON.stringify({
        baseUrl: `http://127.0.0.1:${first.port}`,
        token: "local-bridge-token",
      })}\n`,
      "utf8",
    );
    Object.assign(process.env, {
      OPENWORK_STORAGE_ROOT: root,
      OPENWORK_UI_CONTROL_DISCOVERY: discoveryPath,
      OPENWORK_SERVER_URL: `http://127.0.0.1:${first.port}`,
      OPENWORK_SERVER_TOKEN: "local-server-token",
    });

    const plugin = await AgencyAiLocalExtensions();
    await plugin.tool.openwork_context.execute();
    await plugin.tool.openwork_query.execute({
      id: "settings.panel.open",
      args: {},
    });
    await plugin.tool.openwork_execute.execute({
      id: "settings.panel.open",
      args: {},
    }, {});
    await expect(
      plugin.tool.openwork_query.execute({
        id: "extension.actions",
        args: {},
      }),
    ).rejects.toThrow();
    await expect(
      plugin.tool.openwork_execute.execute({
        id: "extension.call",
        args: {
          extensionId: "local-extension",
          action: "run",
          args: { marker: "must-not-replay" },
        },
      }, {}),
    ).rejects.toThrow();

    expect(firstHop.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/context" },
      { method: "POST", path: "/query" },
      { method: "POST", path: "/command" },
      { method: "GET", path: "/experimental/extensions/actions" },
      { method: "POST", path: "/experimental/extensions/call" },
    ]);
    expect(
      firstHop
        .filter((request) => request.method === "POST")
        .every((request) => request.body.length > 0),
    ).toBe(true);
    expect(secondHop).toEqual([]);
  });
});
