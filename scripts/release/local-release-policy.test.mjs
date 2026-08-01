import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateLocalVersion } from "./bump-local-version.mjs";
import { reviewLocalRelease } from "./review-local-release.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");

describe("AgencyAI local release helpers", () => {
  it("accepts MVP prerelease versions without changing OpenCode", () => {
    assert.equal(validateLocalVersion("v0.1.0-beta.1"), "0.1.0-beta.1");
    assert.throws(() => validateLocalVersion("1.0.0"), /0\.x/);
  });

  it("reviews the current local profile without executing release work", () => {
    const review = reviewLocalRelease({ requireClean: false });
    assert.equal(review.ok, true);
    assert.equal(review.profile, "local-mvp");
    assert.match(review.openCodeCommit, /^[0-9a-f]{40}$/);
  });

  it("keeps the beta publisher signed, notarized, draft-only, and local", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/release-desktop-local.yml"),
      "utf8",
    );
    for (const required of [
      "agencyai-desktop-v*",
      "MACOS_NOTARIZE: \"true\"",
      "Developer ID Application",
      "APPLE_CODESIGN_CERT_P12_BASE64",
      "APPLE_NOTARY_API_KEY_P8_BASE64",
      "xcrun notarytool submit",
      "xcrun stapler staple",
      "spctl --assess",
      "--draft",
      "--prerelease",
      "SHA256SUMS.txt",
    ]) {
      assert.match(workflow, new RegExp(required.replaceAll("*", "\\*")));
    }
    assert.doesNotMatch(workflow, /publish:\s+always/);
    assert.doesNotMatch(workflow, /npm publish|daytona|aur/i);
  });

  it("uses available GitHub-hosted runners and disables Daytona publishing", () => {
    const workflowRoot = resolve(repoRoot, ".github/workflows");
    const workflows = readdirSync(workflowRoot)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => readFileSync(resolve(workflowRoot, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(workflows, /blacksmith-/);

    const daytona = readFileSync(
      resolve(workflowRoot, "daytona-eval-image.yml"),
      "utf8",
    );
    assert.doesNotMatch(daytona, /^\s{2}push:/m);
    assert.match(
      daytona,
      /enable_legacy_daytona_publish:[\s\S]*?default: false/,
    );
    assert.match(
      daytona,
      /github\.repository == 'different-ai\/openwork'[\s\S]*?inputs\.enable_legacy_daytona_publish == true/,
    );
  });
});
