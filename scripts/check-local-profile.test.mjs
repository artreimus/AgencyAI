import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  validateBuilderConfig,
  validateLocalProfile,
} from "./check-local-profile.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const profile = JSON.parse(
  readFileSync(
    resolve(repoRoot, "packages/product-config/profiles/local-mvp.json"),
    "utf8",
  ),
);

describe("local profile release policy", () => {
  it("accepts the immutable AgencyAI local profile", () => {
    assert.equal(validateLocalProfile(profile), true);
  });

  it("rejects a broadened cloud feature", () => {
    assert.throws(
      () =>
        validateLocalProfile({
          ...profile,
          features: { ...profile.features, openworkCloud: true },
        }),
      /openworkCloud must remain false/,
    );
  });

  it("rejects updater, protocol, or notarization drift in Builder", () => {
    const valid = {
      appId: profile.brand.appId,
      productName: profile.brand.name,
      executableName: profile.brand.executableName,
      publish: null,
      mac: { target: ["dmg", "zip"], notarize: false },
    };
    assert.equal(validateBuilderConfig(valid, profile), true);
    assert.throws(
      () => validateBuilderConfig({ ...valid, publish: [{ provider: "github" }] }, profile),
      /publish provider/,
    );
    assert.throws(
      () => validateBuilderConfig({ ...valid, protocols: [] }, profile),
      /public protocols/,
    );
    assert.throws(
      () => validateBuilderConfig({ ...valid, mac: { ...valid.mac, notarize: true } }, profile),
      /must not notarize/,
    );
  });
});
