import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildLocalMvpOpenCodeChildEnv,
  commandMatchesPackagedSidecar,
  createRuntimeManager,
  embeddedServerImportUrl,
  mergeRuntimeChildEnv,
  prioritizeWorkspacePaths,
  resolveAgencyAiTrustedPluginPaths,
  resolveRuntimeRemoteAccessEnabled,
  resolveOpenworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyOpenworkPortWorkspace,
  snapshotEngineState,
  waitForExactOpencodeHealth,
} from "./runtime.mjs";
import {
  STORAGE_LAYOUT_ENVIRONMENT_KEYS,
  resolveStorageLayout,
  storageLayoutEnvironment,
} from "./storage-layout.mjs";

describe("mergeRuntimeChildEnv", () => {
  it("keeps HOME while storage-owned paths override inherited and caller values", () => {
    const environment = mergeRuntimeChildEnv(
      {
        HOME: "/Users/ada",
        USERPROFILE: "/Users/ada",
        XDG_CONFIG_HOME: "/tmp/inherited-config",
        OPENWORK_RUNTIME_DB: "/tmp/inherited-runtime.sqlite",
      },
      { NODE_EXTRA_CA_CERTS: "/tmp/system-ca.pem" },
      {
        XDG_CONFIG_HOME: "/tmp/caller-config",
        OPENCODE_CONFIG_DIR: "/tmp/caller-opencode",
      },
      {
        XDG_CONFIG_HOME: "/tmp/agencyai/config",
        OPENWORK_RUNTIME_DB: "/tmp/agencyai/data/openwork/runtime.sqlite",
        OPENCODE_CONFIG_DIR: "/tmp/agencyai/config/opencode",
      },
    );

    assert.equal(environment.HOME, "/Users/ada");
    assert.equal(environment.USERPROFILE, "/Users/ada");
    assert.equal(environment.NODE_EXTRA_CA_CERTS, "/tmp/system-ca.pem");
    assert.equal(environment.XDG_CONFIG_HOME, "/tmp/agencyai/config");
    assert.equal(
      environment.OPENWORK_RUNTIME_DB,
      "/tmp/agencyai/data/openwork/runtime.sqlite",
    );
    assert.equal(environment.OPENCODE_CONFIG_DIR, "/tmp/agencyai/config/opencode");
  });

  it("does not add or replace HOME when the parent omitted it", () => {
    const environment = mergeRuntimeChildEnv(
      { PATH: "/usr/bin" },
      {},
      {},
      { XDG_DATA_HOME: "/tmp/agencyai/data" },
    );

    assert.equal(Object.hasOwn(environment, "HOME"), false);
    assert.equal(Object.hasOwn(environment, "USERPROFILE"), false);
    assert.equal(environment.XDG_DATA_HOME, "/tmp/agencyai/data");
  });
});

describe("buildLocalMvpOpenCodeChildEnv", () => {
  it("preserves intentional provider/user values and scrubs ambient control variables", () => {
    const environment = buildLocalMvpOpenCodeChildEnv({
      userEnv: {
        NOTION_TOKEN: "intentional-user-value",
        CUSTOM_PROVIDER_BASE_URL: "http://127.0.0.1:11434/v1",
        OLLAMA_HOST: "http://127.0.0.1:11434",
        NODE_OPTIONS: "--require /tmp/user-injected.cjs",
        BUN_OPTIONS: "--preload /tmp/user-injected.ts",
        NODE_PATH: "/tmp/user-node-modules",
        DYLD_INSERT_LIBRARIES: "/tmp/user-injected.dylib",
        NPM_CONFIG_REGISTRY: "https://registry.invalid",
        PATH: "/tmp/user-bin",
      },
      parentEnv: {
        HOME: "/Users/ada",
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "provider-key",
        GITHUB_TOKEN: "ambient-non-provider-token",
        OPENCODE_MODELS_URL: "https://models.invalid",
        OPENCODE_ENABLE_EXA: "1",
        OPENCODE_SERVER_PASSWORD: "ambient-password",
        OPENWORK_TOKEN: "ambient-openwork-token",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.invalid",
        NODE_OPTIONS: "--require /tmp/injected.js",
      },
      caEnv: { NODE_EXTRA_CA_CERTS: "/tmp/system-ca.pem" },
      extra: {
        OPENWORK_SERVER_URL: "http://127.0.0.1:48000",
        OPENCODE_SERVER_USERNAME: "generated-user",
        OPENCODE_SERVER_PASSWORD: "generated-password",
        OPENCODE_ENABLE_EXA: "1",
      },
      storageEnvironment: {
        OPENCODE_CONFIG_DIR: "/tmp/agencyai/config/opencode",
        OPENCODE_DB: "/tmp/agencyai/data/opencode.sqlite",
      },
      toolchainDir:
        "/Applications/AgencyAI.app/Contents/Resources/toolchain/aarch64-apple-darwin",
      trustedPluginPaths: [
        "/Applications/AgencyAI.app/Contents/Resources/opencode-plugins/agencyai-local-policy.js",
      ],
    });

    assert.equal(environment.HOME, "/Users/ada");
    assert.equal(environment.ANTHROPIC_API_KEY, "provider-key");
    assert.equal(environment.NOTION_TOKEN, "intentional-user-value");
    assert.equal(environment.OLLAMA_HOST, "http://127.0.0.1:11434");
    assert.equal(
      environment.CUSTOM_PROVIDER_BASE_URL,
      "http://127.0.0.1:11434/v1",
    );
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.BUN_OPTIONS, undefined);
    assert.equal(environment.NODE_PATH, undefined);
    assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(environment.NPM_CONFIG_REGISTRY, undefined);
    assert.equal(environment.OPENWORK_TOKEN, undefined);
    assert.equal(
      environment.OPENWORK_SERVER_URL,
      "http://127.0.0.1:48000",
    );
    assert.equal(environment.OPENCODE_SERVER_USERNAME, "generated-user");
    assert.equal(environment.OPENCODE_SERVER_PASSWORD, "generated-password");
    assert.equal(
      environment.OPENCODE_CONFIG_DIR,
      "/tmp/agencyai/config/opencode",
    );
    assert.equal(environment.OPENCODE_DB, "/tmp/agencyai/data/opencode.sqlite");
    assert.equal(environment.OPENCODE_MODELS_URL, undefined);
    assert.equal(environment.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    assert.equal(environment.OPENCODE_DISABLE_RUNTIME_DOWNLOADS, "true");
    assert.equal(environment.OPENCODE_DISABLE_MODELS_FETCH, "true");
    assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, "true");
    assert.equal(environment.OPENCODE_DISABLE_SHARE, "true");
    assert.equal(environment.OPENCODE_DISABLE_LSP_DOWNLOAD, "true");
    assert.equal(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
    assert.equal(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS, "true");
    assert.equal(environment.OPENCODE_DISABLE_REMOTE_CONFIG, "true");
    assert.equal(environment.OPENCODE_DISABLE_REMOTE_INSTRUCTIONS, "true");
    assert.equal(environment.OPENCODE_DISABLE_REMOTE_SKILLS, "true");
    assert.equal(
      environment.OPENCODE_TRUSTED_PLUGIN_PATHS,
      JSON.stringify([
        "/Applications/AgencyAI.app/Contents/Resources/opencode-plugins/agencyai-local-policy.js",
      ]),
    );
    assert.equal(environment.OPENCODE_ENABLE_EXA, "false");
    assert.equal(
      environment.PATH,
      "/Applications/AgencyAI.app/Contents/Resources/toolchain/aarch64-apple-darwin:/usr/bin:/bin",
    );
  });

  it("resolves only the complete canonical packaged plugin allowlist", async () => {
    const resourcesPath = await mkdtemp(
      path.join(os.tmpdir(), "agencyai-trusted-plugins-"),
    );
    try {
      const pluginRoot = path.join(resourcesPath, "opencode-plugins");
      await mkdir(pluginRoot, { recursive: true });
      const names = [
        "agencyai-local-extensions",
        "agencyai-local-capabilities",
        "openwork-office-attachments",
        "openwork-anthropic-adaptive-thinking",
        "openwork-anthropic-tool-schema",
        "agencyai-local-policy",
      ];
      await Promise.all(
        names.map((name) =>
          writeFile(path.join(pluginRoot, `${name}.js`), "export {};\n")),
      );

      assert.deepEqual(
        resolveAgencyAiTrustedPluginPaths({ resourcesPath }),
        await Promise.all(
          names.map((name) => realpath(path.join(pluginRoot, `${name}.js`))),
        ),
      );

      await rm(path.join(pluginRoot, "agencyai-local-policy.js"));
      assert.throws(
        () => resolveAgencyAiTrustedPluginPaths({ resourcesPath }),
        /trusted OpenCode plugins are missing/,
      );
    } finally {
      await rm(resourcesPath, { recursive: true, force: true });
    }
  });
});

describe("waitForExactOpencodeHealth", () => {
  it("requires authenticated exact-version readiness", async () => {
    const requests = [];
    const payload = await waitForExactOpencodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "generated-user",
      password: "generated-password",
      expectedVersion: "1.17.11",
      timeoutMs: 500,
      async fetchImpl(url, init) {
        requests.push({ url, init });
        return new Response(JSON.stringify({
          healthy: true,
          version: "1.17.11",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.deepEqual(payload, { healthy: true, version: "1.17.11" });
    assert.equal(requests[0].url, "http://127.0.0.1:4096/global/health");
    assert.equal(
      requests[0].init.headers.Authorization,
      `Basic ${Buffer.from("generated-user:generated-password").toString("base64")}`,
    );
    assert.equal(requests[0].init.redirect, "error");
  });

  it("rejects a healthy response from a different OpenCode version", async () => {
    await assert.rejects(
      waitForExactOpencodeHealth({
        baseUrl: "http://127.0.0.1:4096",
        username: "generated-user",
        password: "generated-password",
        expectedVersion: "1.17.11",
        timeoutMs: 50,
        async fetchImpl() {
          return new Response(JSON.stringify({
            healthy: true,
            version: "1.17.12",
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
      /pinned runtime contract/,
    );
  });

  it("rejects redirects without requesting the second-hop health endpoint", async () => {
    let secondHopRequests = 0;
    const secondHop = createServer((_request, response) => {
      secondHopRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "1.17.11" }));
    });
    await new Promise((resolve) =>
      secondHop.listen(0, "127.0.0.1", () => resolve()));
    const secondAddress = secondHop.address();
    if (!secondAddress || typeof secondAddress === "string") {
      throw new Error("Second-hop test server did not bind to a TCP port");
    }

    const redirector = createServer((_request, response) => {
      response.writeHead(307, {
        Location: `http://127.0.0.1:${secondAddress.port}/global/health`,
      });
      response.end();
    });
    await new Promise((resolve) =>
      redirector.listen(0, "127.0.0.1", () => resolve()));
    const redirectAddress = redirector.address();
    if (!redirectAddress || typeof redirectAddress === "string") {
      throw new Error("Redirect test server did not bind to a TCP port");
    }

    try {
      await assert.rejects(
        waitForExactOpencodeHealth({
          baseUrl: `http://127.0.0.1:${redirectAddress.port}`,
          username: "generated-user",
          password: "generated-password",
          expectedVersion: "1.17.11",
          timeoutMs: 50,
        }),
      );
      assert.equal(secondHopRequests, 0);
    } finally {
      await Promise.all([
        new Promise((resolve, reject) =>
          redirector.close((error) => error ? reject(error) : resolve())),
        new Promise((resolve, reject) =>
          secondHop.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });
});

describe("resolveRuntimeRemoteAccessEnabled", () => {
  it("forces remote access off when the compiled product disallows it", () => {
    assert.equal(resolveRuntimeRemoteAccessEnabled(true, false), false);
    assert.equal(resolveRuntimeRemoteAccessEnabled(false, false), false);
  });

  it("preserves upstream opt-in behavior when the product allows it", () => {
    assert.equal(resolveRuntimeRemoteAccessEnabled(true, true), true);
    assert.equal(resolveRuntimeRemoteAccessEnabled(false, true), false);
    assert.equal(resolveRuntimeRemoteAccessEnabled(undefined, true), false);
  });
});

describe("runtimeStatus storage projection", () => {
  it("does not claim server-attested storage before the embedded server starts", async () => {
    const layout = resolveStorageLayout({
      appDataPath: "/tmp",
      appIdentifier: "com.artreimus.agencyai",
      platform: "linux",
    });
    const runtimeManager = createRuntimeManager({
      app: {
        getPath(name) {
          if (name === "userData") return layout.userData;
          if (name === "exe") return "/tmp/AgencyAI";
          if (name === "home") return "/home/ada";
          throw new Error(`unexpected app path ${name}`);
        },
      },
      desktopRoot: "/tmp/agencyai-desktop",
      listLocalWorkspacePaths: async () => [],
      storageLayout: layout,
      storageEnvironment: {
        ...storageLayoutEnvironment(layout),
        HOME: "/home/ada",
        OPENWORK_TOKEN: "secret-token",
      },
    });

    const status = await runtimeManager.runtimeStatus();
    assert.equal(status.storage, null);
  });
});

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyOpenworkPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyOpenworkPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyOpenworkPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/OpenWork.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/OpenWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("embeddedServerImportUrl", () => {
  it("returns the same file URL for unchanged metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");

      const first = embeddedServerImportUrl(embeddedPath);
      const second = embeddedServerImportUrl(embeddedPath);
      const url = new URL(first);

      assert.equal(first, second);
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url), embeddedPath);
      assert.ok(url.searchParams.get("mtimeMs"));
      assert.equal(url.searchParams.get("size"), String("export const value = 1;\n".length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when the file metadata changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwork-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");
      const first = embeddedServerImportUrl(embeddedPath);

      await writeFile(embeddedPath, "export const value = 12;\n");

      assert.notEqual(embeddedServerImportUrl(embeddedPath), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain file URL if stat fails", () => {
    const missingPath = path.join(os.tmpdir(), "openwork-missing-embedded.js");

    assert.equal(embeddedServerImportUrl(missingPath), pathToFileURL(missingPath).href);
  });
});

describe("resolveOpenworkServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveOpenworkServerConfigPath({ OPENWORK_SERVER_CONFIG: "/tmp/openwork/server.json" }),
      "/tmp/openwork/server.json",
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveOpenworkServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/openwork/server.json",
    );
  });
});

describe("snapshotEngineState", () => {
  it("reports server-managed OpenCode liveness and pid without a child handle", () => {
    const snapshot = snapshotEngineState({
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: null,
      opencodePassword: null,
      opencodeBinPath: null,
      opencodeBinSource: null,
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: null,
      lastStderr: null,
      execution: null,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.managedByServer, true);
    assert.equal(snapshot.pid, 12345);
  });
});
