import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateLocalVersion } from "./bump-local-version.mjs";
import { reviewLocalRelease } from "./review-local-release.mjs";

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
});
