import assert from "node:assert/strict";
import test from "node:test";

import { createAppBuildInfo } from "./app-build-info.mjs";

test("returns immutable build metadata with the compiled product profile", () => {
  const env = {
    OPENWORK_GIT_SHA: " abc123 ",
    OPENWORK_BUILD_EPOCH: " 2026-07-27T00:00:00Z ",
    OPENWORK_DEV_MODE: "1",
    OPENWORK_PRODUCT_PROFILE: "upstream",
    VITE_OPENWORK_PRODUCT_PROFILE: "upstream",
  };

  const info = createAppBuildInfo({
    appVersion: " 0.18.3 ",
    env,
    platform: "darwin",
    arch: "arm64",
  });

  assert.deepEqual(
    {
      version: info.version,
      gitSha: info.gitSha,
      buildEpoch: info.buildEpoch,
      openworkDevMode: info.openworkDevMode,
      os: info.os,
      arch: info.arch,
      profile: info.productProfile.profile,
    },
    {
      version: "0.18.3",
      gitSha: "abc123",
      buildEpoch: "2026-07-27T00:00:00Z",
      openworkDevMode: true,
      os: "darwin",
      arch: "arm64",
      profile: "local-mvp",
    },
  );

  assert.equal(Object.isFrozen(info), true);
  assert.equal(Object.isFrozen(info.productProfile), true);
  assert.equal(Object.isFrozen(info.productProfile.brand), true);
  assert.equal(Object.isFrozen(info.productProfile.features), true);

  env.OPENWORK_PRODUCT_PROFILE = "upstream";
  assert.equal(info.productProfile.profile, "local-mvp");
  assert.equal(Reflect.set(info.productProfile.features, "openworkCloud", true), false);
  assert.equal(info.productProfile.features.openworkCloud, false);
});

test("normalizes missing optional metadata without consulting selectors", () => {
  const info = createAppBuildInfo({
    appVersion: "",
    env: {
      OPENWORK_PRODUCT_PROFILE: "invalid",
      VITE_OPENWORK_PRODUCT_PROFILE: "invalid",
    },
  });

  assert.equal(info.version, "0.0.0");
  assert.equal(info.gitSha, null);
  assert.equal(info.buildEpoch, null);
  assert.equal(info.openworkDevMode, false);
  assert.equal(info.os, null);
  assert.equal(info.arch, null);
  assert.equal(info.productProfile.profile, "local-mvp");
});
