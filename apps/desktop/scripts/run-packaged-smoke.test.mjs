import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  captureBoundedText,
  packagedMacAppCandidates,
  packagedSmokeLaunchArguments,
  packagedUiControlDiscoveryPath,
  resolvePackagedMacApp,
  stopChild,
} from "./run-packaged-smoke.mjs";

test("packaged smoke continuously drains child output into a bounded tail", () => {
  const stream = new PassThrough();
  const readOutput = captureBoundedText(stream, 8);
  stream.write("ignored-");
  stream.write("retained");
  assert.equal(readOutput(), "retained");
});

test("packaged smoke uses the Chromium test keychain only on macOS", () => {
  assert.deepEqual(packagedSmokeLaunchArguments("darwin"), [
    "--use-mock-keychain",
    "--disable-features=DialMediaRouteProvider",
    "-ApplePersistenceIgnoreState",
    "YES",
  ]);
  assert.deepEqual(packagedSmokeLaunchArguments("linux"), []);
  assert.deepEqual(packagedSmokeLaunchArguments("win32"), []);
});

test("packaged smoke does not wait again for a child that exited by signal", async () => {
  await stopChild({
    exitCode: null,
    signalCode: "SIGTRAP",
    once() {
      throw new Error("already-exited child must not install listeners");
    },
    kill() {
      throw new Error("already-exited child must not be killed");
    },
  });
});

test("packaged smoke resolves only deterministic AgencyAI app candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agencyai-packaged-path-"));
  try {
    const candidates = packagedMacAppCandidates(root);
    assert.deepEqual(candidates, [
      path.join(root, "dist-electron", "mac-arm64", "AgencyAI.app"),
      path.join(root, "dist-electron", "mac", "AgencyAI.app"),
    ]);
    await mkdir(candidates[0], { recursive: true });
    assert.equal(
      await resolvePackagedMacApp(null, root),
      await realpath(candidates[0]),
    );
    await assert.rejects(
      resolvePackagedMacApp(path.join(root, "OpenWork.app"), root),
      /AgencyAI\.app not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged discovery remains inside the AgencyAI application-data root", () => {
  assert.equal(
    packagedUiControlDiscoveryPath(
      { brand: { appId: "com.artreimus.agencyai" } },
      "/Users/tester",
    ),
    path.join(
      "/Users/tester",
      "Library",
      "Application Support",
      "com.artreimus.agencyai",
      "electron",
      "user-data",
      "openwork-ui-control.json",
    ),
  );
});
