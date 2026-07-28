import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserTargetPolicy,
  isTrustedMainWindowNavigation,
} from "./browser-target-policy.mjs";

describe("browser target policy", () => {
  it("allows only the trusted renderer origin, including the initial blank-window transition", () => {
    const trustedRendererOrigin = "agencyai-internal://renderer";

    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: `${trustedRendererOrigin}/`,
      currentUrl: "",
      trustedRendererOrigin,
    }), true);
    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: `${trustedRendererOrigin}/assets/index.js`,
      currentUrl: "about:blank",
      trustedRendererOrigin,
    }), true);
    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: `${trustedRendererOrigin}/next`,
      currentUrl: `${trustedRendererOrigin}/`,
      trustedRendererOrigin,
    }), true);
    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: `${trustedRendererOrigin}/`,
      currentUrl: "https://example.com/",
      trustedRendererOrigin,
    }), false);
    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: "https://example.com/",
      currentUrl: `${trustedRendererOrigin}/`,
      trustedRendererOrigin,
    }), false);
    assert.equal(isTrustedMainWindowNavigation({
      targetUrl: "not a url",
      currentUrl: "",
      trustedRendererOrigin,
    }), false);
  });

  it("publishes only explicitly authorized built-in browser targets", () => {
    const policy = createBrowserTargetPolicy({
      getBrowserUrl: () => "http://127.0.0.1:53123",
    });

    policy.authorize("tab-a", "target-a");
    policy.authorize("tab-b", "target-b");
    assert.deepEqual(policy.snapshot(), {
      browser_url: "http://127.0.0.1:53123",
      target_ids: ["target-a", "target-b"],
    });

    policy.revoke("tab-a");
    assert.deepEqual(policy.snapshot().target_ids, ["target-b"]);
    policy.clear();
    assert.deepEqual(policy.snapshot().target_ids, []);
  });

  it("fails closed when the browser endpoint is unavailable", () => {
    const policy = createBrowserTargetPolicy({
      getBrowserUrl() {
        throw new Error("disabled");
      },
    });
    policy.authorize("tab-a", "target-a");

    assert.deepEqual(policy.snapshot(), {
      browser_url: null,
      target_ids: ["target-a"],
    });
    assert.throws(() => policy.authorize("", "target-b"), /tabId/);
    assert.throws(() => policy.authorize("tab-b", ""), /targetId/);
  });
});
