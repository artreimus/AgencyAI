import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { registerMigrationIpc } from "./migration.mjs";

function createIpcHarness() {
  const handlers = new Map();
  return {
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    invoke(channel) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, "function", `missing handler ${channel}`);
      return handler();
    },
  };
}

test("disabled migration IPC never resolves or touches legacy snapshot paths", async () => {
  const harness = createIpcHarness();
  let pathReads = 0;
  const registration = registerMigrationIpc({
    app: {
      getPath() {
        pathReads += 1;
        throw new Error("disabled migration must not resolve userData");
      },
    },
    ipcMain: harness.ipcMain,
    enabled: false,
  });

  assert.deepEqual(registration, { enabled: false });
  assert.equal(await harness.invoke("openwork:migration:read"), null);
  assert.deepEqual(await harness.invoke("openwork:migration:ack"), {
    ok: false,
    moved: false,
    code: "feature_disabled",
  });
  assert.equal(pathReads, 0);
});

test("enabled migration IPC reads and acknowledges a valid Tauri snapshot", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "agencyai-migration-"));
  try {
    const snapshotPath = path.join(userData, "migration-snapshot.v1.json");
    const donePath = path.join(userData, "migration-snapshot.v1.done.json");
    const snapshot = { version: 1, workspaces: [{ path: "/workspace" }] };
    await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
    const harness = createIpcHarness();
    const registration = registerMigrationIpc({
      app: { getPath: (name) => name === "userData" ? userData : "" },
      ipcMain: harness.ipcMain,
      enabled: true,
    });

    assert.deepEqual(registration, { enabled: true });
    assert.deepEqual(await harness.invoke("openwork:migration:read"), snapshot);
    assert.deepEqual(await harness.invoke("openwork:migration:ack"), {
      ok: true,
      moved: true,
    });
    await assert.rejects(access(snapshotPath));
    assert.deepEqual(JSON.parse(await readFile(donePath, "utf8")), snapshot);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("enabled migration IPC ignores malformed or unsupported snapshots", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "agencyai-migration-"));
  try {
    const snapshotPath = path.join(userData, "migration-snapshot.v1.json");
    const harness = createIpcHarness();
    registerMigrationIpc({
      app: { getPath: () => userData },
      ipcMain: harness.ipcMain,
      enabled: true,
    });

    await writeFile(snapshotPath, "{not-json", "utf8");
    assert.equal(await harness.invoke("openwork:migration:read"), null);
    await writeFile(snapshotPath, JSON.stringify({ version: 2 }), "utf8");
    assert.equal(await harness.invoke("openwork:migration:read"), null);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
