import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  STORAGE_LAYOUT_ENVIRONMENT_KEYS,
  applyStorageLayoutEnvironment,
  createStorageRuntimeProjection,
  ensureStorageLayout,
  resolveElectronStorageLayout,
  resolveStorageLayout,
  storageLayoutEnvironment,
} from "./storage-layout.mjs";

describe("resolveStorageLayout", () => {
  it("derives the complete product-owned layout from one root", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.artreimus.agencyai",
      platform: "darwin",
    });
    const root = "/Users/ada/Library/Application Support/com.artreimus.agencyai";

    assert.deepEqual(layout, {
      root,
      userData: `${root}/electron/user-data`,
      sessionData: `${root}/electron/session-data`,
      logs: `${root}/logs`,
      crashDumps: `${root}/crash-dumps`,
      openworkConfig: `${root}/config/openwork`,
      openworkData: `${root}/data/openwork`,
      openworkCache: `${root}/cache/openwork`,
      runtimeDb: `${root}/data/openwork/runtime.sqlite`,
      bootstrap: `${root}/config/openwork/desktop-bootstrap.json`,
      opencodeConfig: `${root}/config/opencode`,
      opencodeData: `${root}/data/opencode`,
      opencodeCache: `${root}/cache/opencode`,
      opencodeState: `${root}/state/opencode`,
      mcpAuth: `${root}/data/opencode/mcp-auth.json`,
    });
    assert.equal(Object.isFrozen(layout), true);
  });

  it("uses platform-native Windows paths", () => {
    const layout = resolveStorageLayout({
      appDataPath: "C:\\Users\\Ada\\AppData\\Roaming",
      appIdentifier: "com.artreimus.agencyai",
      platform: "win32",
    });

    assert.equal(layout.root, "C:\\Users\\Ada\\AppData\\Roaming\\com.artreimus.agencyai");
    assert.equal(layout.sessionData, `${layout.root}\\electron\\session-data`);
    assert.equal(layout.runtimeDb, `${layout.root}\\data\\openwork\\runtime.sqlite`);
    assert.equal(layout.mcpAuth, `${layout.root}\\data\\opencode\\mcp-auth.json`);
  });

  it("preserves an explicit development userData path as the isolated root", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.artreimus.agencyai.dev",
      platform: "darwin",
      userDataOverride: "/private/tmp/agencyai-test-profile",
    });

    assert.equal(layout.root, "/private/tmp/agencyai-test-profile");
    assert.equal(layout.userData, "/private/tmp/agencyai-test-profile");
    assert.equal(layout.openworkConfig, "/private/tmp/agencyai-test-profile/config/openwork");
  });

  it("keeps a separate userData override inside an explicit development root", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.artreimus.agencyai.dev",
      platform: "darwin",
      storageRootOverride: "/private/tmp/agencyai-test",
      userDataOverride: "/private/tmp/agencyai-test/chromium",
    });

    assert.equal(layout.root, "/private/tmp/agencyai-test");
    assert.equal(layout.userData, "/private/tmp/agencyai-test/chromium");
  });

  it("rejects invalid roots, identifiers, and escaping userData paths", () => {
    assert.throws(
      () => resolveStorageLayout({
        appDataPath: "relative",
        appIdentifier: "com.artreimus.agencyai",
      }),
      /appDataPath must be an absolute path/,
    );
    assert.throws(
      () => resolveStorageLayout({
        appDataPath: "/tmp",
        appIdentifier: "../agencyai",
      }),
      /appIdentifier/,
    );
    assert.throws(
      () => resolveStorageLayout({
        appDataPath: "/tmp",
        appIdentifier: "com.artreimus.agencyai",
        storageRootOverride: "/tmp/agencyai",
        userDataOverride: "/tmp/upstream-openwork",
      }),
      /must be inside/,
    );
  });
});

describe("resolveElectronStorageLayout", () => {
  const hostileEnvironment = {
    OPENWORK_ELECTRON_STORAGE_ROOT: "/tmp/inherited-root",
    OPENWORK_ELECTRON_USERDATA: "/tmp/inherited-user-data",
    OPENWORK_STORAGE_ROOT: "/tmp/inherited-storage",
    OPENWORK_SERVER_CONFIG: "/tmp/inherited-server.json",
    OPENWORK_DATA_DIR: "/tmp/inherited-data",
    OPENWORK_CACHE_DIR: "/tmp/inherited-cache",
    OPENWORK_MCP_AUTH_PATH: "/tmp/inherited-mcp.json",
    OPENWORK_RUNTIME_DB: "/tmp/inherited-runtime.sqlite",
    OPENCODE_CONFIG_DIR: "/tmp/inherited-opencode-config",
    OPENCODE_DB: "/tmp/inherited-opencode.db",
    XDG_CONFIG_HOME: "/tmp/inherited-xdg-config",
    XDG_DATA_HOME: "/tmp/inherited-xdg-data",
    XDG_CACHE_HOME: "/tmp/inherited-xdg-cache",
    XDG_STATE_HOME: "/tmp/inherited-xdg-state",
  };

  it("ignores inherited application-owned overrides in packaged local-mvp", () => {
    const layout = resolveElectronStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.artreimus.agencyai",
      env: hostileEnvironment,
      isPackaged: true,
      productProfile: "local-mvp",
      platform: "darwin",
    });

    assert.equal(
      layout.root,
      "/Users/ada/Library/Application Support/com.artreimus.agencyai",
    );
    assert.equal(
      layout.userData,
      "/Users/ada/Library/Application Support/com.artreimus.agencyai/electron/user-data",
    );
  });

  it("accepts explicit path injection only in unpackaged local-mvp", () => {
    const layout = resolveElectronStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.artreimus.agencyai.dev",
      env: {
        OPENWORK_ELECTRON_STORAGE_ROOT: "/tmp/agencyai-dev",
        OPENWORK_ELECTRON_USERDATA: "/tmp/agencyai-dev/chromium",
      },
      isPackaged: false,
      productProfile: "local-mvp",
      platform: "darwin",
    });

    assert.equal(layout.root, "/tmp/agencyai-dev");
    assert.equal(layout.userData, "/tmp/agencyai-dev/chromium");
  });

  it("preserves packaged upstream override behavior for compatibility", () => {
    const layout = resolveElectronStorageLayout({
      appDataPath: "/Users/ada/Library/Application Support",
      appIdentifier: "com.differentai.openwork",
      env: { OPENWORK_ELECTRON_USERDATA: "/tmp/openwork-profile" },
      isPackaged: true,
      productProfile: "upstream",
      platform: "darwin",
    });

    assert.equal(layout.root, "/tmp/openwork-profile");
    assert.equal(layout.userData, "/tmp/openwork-profile");
  });
});

describe("storageLayoutEnvironment", () => {
  it("projects every application-owned child path and keeps OpenWork/OpenCode DBs separate", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/tmp",
      appIdentifier: "com.artreimus.agencyai",
      platform: "linux",
    });
    const environment = storageLayoutEnvironment(layout);

    assert.deepEqual(Object.keys(environment), STORAGE_LAYOUT_ENVIRONMENT_KEYS);
    assert.deepEqual(environment, {
      OPENWORK_CACHE_DIR: `${layout.root}/cache/openwork`,
      OPENWORK_DATA_DIR: `${layout.root}/data/openwork`,
      OPENWORK_DESKTOP_BOOTSTRAP_PATH: `${layout.root}/config/openwork/desktop-bootstrap.json`,
      OPENWORK_ENV_STORE: `${layout.root}/config/openwork/env.json`,
      OPENWORK_MCP_AUTH_PATH: `${layout.root}/data/opencode/mcp-auth.json`,
      OPENWORK_RUNTIME_DB: `${layout.root}/data/openwork/runtime.sqlite`,
      OPENWORK_SERVER_CONFIG: `${layout.root}/config/openwork/server.json`,
      OPENWORK_STORAGE_ROOT: layout.root,
      OPENCODE_CONFIG_DIR: `${layout.root}/config/opencode`,
      OPENCODE_DB: `${layout.root}/data/opencode/opencode.db`,
      XDG_CACHE_HOME: `${layout.root}/cache`,
      XDG_CONFIG_HOME: `${layout.root}/config`,
      XDG_DATA_HOME: `${layout.root}/data`,
      XDG_STATE_HOME: `${layout.root}/state`,
    });
    assert.notEqual(environment.OPENWORK_RUNTIME_DB, environment.OPENCODE_DB);
    assert.equal(Object.isFrozen(environment), true);
  });

  it("projects Windows paths with the layout's path semantics", () => {
    const layout = resolveStorageLayout({
      appDataPath: "C:\\Users\\Ada\\AppData\\Roaming",
      appIdentifier: "com.artreimus.agencyai",
      platform: "win32",
    });
    const environment = storageLayoutEnvironment(layout);

    assert.equal(environment.XDG_CONFIG_HOME, `${layout.root}\\config`);
    assert.equal(environment.OPENCODE_DB, `${layout.root}\\data\\opencode\\opencode.db`);
  });

  it("overwrites inherited owned paths without changing the user's home", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/tmp",
      appIdentifier: "com.artreimus.agencyai",
      platform: "linux",
    });
    const target = {
      HOME: "/home/ada",
      USERPROFILE: "/home/ada",
      OPENWORK_SERVER_CONFIG: "/tmp/upstream/server.json",
      OPENCODE_CONFIG_DIR: "/tmp/upstream/opencode",
    };

    assert.equal(applyStorageLayoutEnvironment(target, layout), target);
    assert.equal(target.HOME, "/home/ada");
    assert.equal(target.USERPROFILE, "/home/ada");
    assert.equal(target.OPENWORK_SERVER_CONFIG, `${layout.openworkConfig}/server.json`);
    assert.equal(target.OPENCODE_CONFIG_DIR, layout.opencodeConfig);
  });

  it("projects only allowlisted storage paths for runtime proof", () => {
    const layout = resolveStorageLayout({
      appDataPath: "/tmp",
      appIdentifier: "com.artreimus.agencyai",
      platform: "linux",
    });
    const storageEnvironment = storageLayoutEnvironment(layout);
    const projection = createStorageRuntimeProjection(layout, {
      ...storageEnvironment,
      HOME: "/home/ada",
      OPENWORK_TOKEN: "secret-token",
      PROVIDER_API_KEY: "secret-provider-key",
      UNRELATED_PATH: "/tmp/unrelated",
    });

    assert.equal(projection.root, layout.root);
    assert.deepEqual(
      Object.keys(projection),
      ["root", "environment"],
    );
    assert.deepEqual(
      Object.keys(projection.environment),
      STORAGE_LAYOUT_ENVIRONMENT_KEYS,
    );
    assert.equal(Object.hasOwn(projection.environment, "HOME"), false);
    assert.equal(Object.hasOwn(projection.environment, "OPENWORK_TOKEN"), false);
    assert.equal(Object.hasOwn(projection.environment, "PROVIDER_API_KEY"), false);
    assert.equal(Object.hasOwn(projection.environment, "UNRELATED_PATH"), false);
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.environment), true);
  });
});

describe("ensureStorageLayout", () => {
  it("creates every directory but does not create file-valued paths", async () => {
    const appDataPath = await mkdtemp(path.join(os.tmpdir(), "agencyai-storage-layout-"));
    try {
      const layout = resolveStorageLayout({
        appDataPath,
        appIdentifier: "com.artreimus.agencyai",
      });

      assert.equal(await ensureStorageLayout(layout), layout);
      for (const directory of [
        layout.root,
        layout.userData,
        layout.sessionData,
        layout.logs,
        layout.crashDumps,
        layout.openworkConfig,
        layout.openworkData,
        layout.openworkCache,
        layout.opencodeConfig,
        layout.opencodeData,
        layout.opencodeCache,
        layout.opencodeState,
      ]) {
        await access(directory);
      }
      for (const filePath of [layout.runtimeDb, layout.bootstrap, layout.mcpAuth]) {
        await assert.rejects(access(filePath));
      }
    } finally {
      await rm(appDataPath, { recursive: true, force: true });
    }
  });

  it("deduplicates directory creation and uses private creation permissions", async () => {
    const layout = resolveStorageLayout({
      appDataPath: "/tmp",
      appIdentifier: "com.artreimus.agencyai",
    });
    const calls = [];
    await ensureStorageLayout(layout, {
      mkdirFn: async (directory, options) => {
        calls.push({ directory, options });
      },
    });

    assert.equal(new Set(calls.map((call) => call.directory)).size, calls.length);
    assert.equal(calls.every((call) => call.options.recursive === true), true);
    assert.equal(calls.every((call) => call.options.mode === 0o700), true);
  });
});

it("keeps the TypeScript declaration exports aligned with the runtime module", async () => {
  const declarations = await readFile(
    new URL("./storage-layout.d.mts", import.meta.url),
    "utf8",
  );
  for (const exportName of [
    "resolveStorageLayout",
    "resolveElectronStorageLayout",
    "storageLayoutEnvironment",
    "applyStorageLayoutEnvironment",
    "createStorageRuntimeProjection",
    "ensureStorageLayout",
  ]) {
    assert.match(
      declarations,
      new RegExp(`export function ${exportName}\\s*\\(`),
      `missing declaration for ${exportName}`,
    );
  }
  assert.match(declarations, /export type StorageLayout\s*=/);
  assert.match(declarations, /export type StorageRuntimeProjection\s*=/);
  assert.match(declarations, /export type ResolveStorageLayoutOptions\s*=/);
});
