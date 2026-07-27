import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getBuildProductProfile } from "@openwork/product-config";

import {
  applyDesktopProductEnvironmentPolicy,
  forwardedProductDeepLinks,
  productFeatureDisabledResult,
  resolveDesktopProductPolicy,
} from "./desktop-product-policy.mjs";

const LOCAL_PROFILE = getBuildProductProfile();
const electronDirectory = dirname(fileURLToPath(import.meta.url));

describe("applyDesktopProductEnvironmentPolicy", () => {
  it("removes inherited development mode from packaged local-mvp", () => {
    const env = { OPENWORK_DEV_MODE: "1", HOME: "/Users/ada" };
    const result = applyDesktopProductEnvironmentPolicy({
      productProfile: LOCAL_PROFILE,
      isPackaged: true,
      env,
    });

    assert.equal(Object.hasOwn(result, "OPENWORK_DEV_MODE"), false);
    assert.equal(result.HOME, "/Users/ada");
  });

  it("preserves development mode for upstream and unpackaged profiles", () => {
    const unpackaged = { OPENWORK_DEV_MODE: "1" };
    applyDesktopProductEnvironmentPolicy({
      productProfile: LOCAL_PROFILE,
      isPackaged: false,
      env: unpackaged,
    });
    assert.equal(unpackaged.OPENWORK_DEV_MODE, "1");

    const upstream = { OPENWORK_DEV_MODE: "1" };
    applyDesktopProductEnvironmentPolicy({
      productProfile: {
        ...LOCAL_PROFILE,
        profile: "upstream",
      },
      isPackaged: true,
      env: upstream,
    });
    assert.equal(upstream.OPENWORK_DEV_MODE, "1");
  });
});

describe("resolveDesktopProductPolicy", () => {
  it("derives immutable packaged identity from the local product profile", () => {
    const policy = resolveDesktopProductPolicy({
      productProfile: LOCAL_PROFILE,
      appRootPath: "/repo/AgencyAI",
      env: {
        OPENWORK_ELECTRON_APP_NAME: "Spoofed Name",
        OPENWORK_ELECTRON_APP_IDENTIFIER: "com.differentai.openwork",
      },
      isDevMode: false,
      isPackaged: true,
    });

    assert.deepEqual(policy, {
      appName: "AgencyAI",
      productionAppIdentifier: "com.artreimus.agencyai",
      devAppIdentifier: "com.artreimus.agencyai.dev",
      appIdentifier: "com.artreimus.agencyai",
      appUserModelId: "com.artreimus.agencyai",
      protocol: null,
      publicDeepLinksEnabled: false,
      allowIdentityOverrides: false,
    });
    assert.equal(Object.isFrozen(policy), true);
  });

  it("keeps explicit identity injection limited to unpackaged development", () => {
    const policy = resolveDesktopProductPolicy({
      productProfile: LOCAL_PROFILE,
      appRootPath: "/repo/AgencyAI",
      env: {
        OPENWORK_ELECTRON_APP_NAME: "AgencyAI Fixture",
        OPENWORK_ELECTRON_APP_IDENTIFIER: "com.artreimus.agencyai.fixture",
      },
      isDevMode: true,
      isPackaged: false,
    });

    assert.equal(policy.appName, "AgencyAI Fixture");
    assert.equal(policy.appIdentifier, "com.artreimus.agencyai.fixture");
    assert.equal(policy.appUserModelId, "com.artreimus.agencyai.fixture");
    assert.equal(policy.allowIdentityOverrides, true);
  });

  it("ignores inherited development mode for packaged local-mvp identity", () => {
    const policy = resolveDesktopProductPolicy({
      productProfile: LOCAL_PROFILE,
      appRootPath: "/repo/AgencyAI",
      env: {
        OPENWORK_DEV_PROFILE: "hostile",
        OPENWORK_ELECTRON_APP_NAME: "Spoofed Name",
        OPENWORK_ELECTRON_APP_IDENTIFIER: "com.differentai.openwork.dev",
      },
      isDevMode: true,
      isPackaged: true,
    });

    assert.equal(policy.appName, "AgencyAI");
    assert.equal(policy.appIdentifier, "com.artreimus.agencyai");
    assert.equal(policy.appUserModelId, "com.artreimus.agencyai");
    assert.equal(policy.allowIdentityOverrides, false);
  });

  it("retains upstream protocol behavior only in the upstream profile", () => {
    /** @type {import("@openwork/product-config").ProductProfile} */
    const upstreamProfile = {
      schemaVersion: LOCAL_PROFILE.schemaVersion,
      profile: "upstream",
      brand: {
        ...LOCAL_PROFILE.brand,
        name: "OpenWork",
        appId: "com.differentai.openwork",
        devAppId: "com.differentai.openwork.dev",
        protocol: "openwork",
      },
      features: {
        ...LOCAL_PROFILE.features,
        connectLinks: true,
      },
      networkPolicy: LOCAL_PROFILE.networkPolicy,
    };
    const policy = resolveDesktopProductPolicy({
      productProfile: upstreamProfile,
      appRootPath: "/repo/OpenWork",
      isPackaged: true,
    });

    assert.equal(policy.appIdentifier, "com.differentai.openwork");
    assert.equal(policy.protocol, "openwork");
    assert.equal(policy.publicDeepLinksEnabled, true);
  });
});

describe("forwardedProductDeepLinks", () => {
  const argv = [
    "/Applications/AgencyAI",
    "openwork://connect?token=legacy",
    "openwork-dev://connect?token=legacy-dev",
    "https://example.test/connect",
    "http://127.0.0.1/connect",
    "--flag",
  ];

  it("returns no links when the product has no public protocol", () => {
    assert.deepEqual(forwardedProductDeepLinks(argv, null), []);
  });

  it("preserves the upstream custom and web link inputs when enabled", () => {
    assert.deepEqual(forwardedProductDeepLinks(argv, "openwork"), argv.slice(1, 5));
  });
});

it("returns a stable immutable disabled-feature result", () => {
  const result = productFeatureDisabledResult();
  assert.deepEqual(result, { ok: false, code: "feature_disabled" });
  assert.equal(Object.isFrozen(result), true);
});

it("guards every cached brand sidecar read behind the compiled feature policy", async () => {
  const mainSource = await readFile(
    resolve(electronDirectory, "main.mjs"),
    "utf8",
  );
  assert.match(
    mainSource,
    /const DYNAMIC_BRANDING_ENABLED = Boolean\([\s\S]*?dynamicOrgBranding[\s\S]*?remoteAssetFetches/,
  );
  assert.match(
    mainSource,
    /function resolveBrandIconImage\(\) \{\s*if \(!DYNAMIC_BRANDING_ENABLED\) return null;/,
  );
  assert.match(
    mainSource,
    /async function readBrandIconSidecar\(\) \{\s*if \(!DYNAMIC_BRANDING_ENABLED\) return null;/,
  );
});
