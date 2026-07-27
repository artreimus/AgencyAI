import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandMatchesPackagedSidecar,
  createRuntimeManager,
  embeddedServerImportUrl,
  mergeRuntimeChildEnv,
  prioritizeWorkspacePaths,
  resolveRuntimeRemoteAccessEnabled,
  resolveOpenworkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyOpenworkPortWorkspace,
  snapshotEngineState,
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
