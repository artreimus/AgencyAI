import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_UPSTREAM_LEGAL_LITERALS,
  ALLOWED_UPSTREAM_LITERALS,
  EXPECTED_DOC_FILES,
  forbiddenVendorFindings,
  isAllowedUpstreamStringLiteral,
  upstreamStringLiterals,
} from "./check-agencyai-product-surface.mjs";

test("detects every forbidden vendor destination case-insensitively", () => {
  const source = "HTTPS://APP.OPENWORKLABS.COM and https://us.i.posthog.com";
  assert.deepEqual(
    forbiddenVendorFindings(source),
    [
      "text: openworklabs.com",
      "text: us.i.posthog.com",
    ],
  );
});

test("extracts upstream string literals without matching identifiers or comments", () => {
  const source = `
    const legacyOpenWorkIdentifier = true;
    // OpenWork comment
    const legal = "OpenWork";
    const visible = \`OpenWork Cloud\`;
  `;
  assert.deepEqual(
    upstreamStringLiterals(source),
    ["OpenWork", "OpenWork Cloud"],
  );
  assert(ALLOWED_UPSTREAM_LITERALS.includes("OpenWork"));
  assert(!ALLOWED_UPSTREAM_LITERALS.includes("OpenWork Cloud"));
});

test("allows only the reviewed upstream legal attribution", () => {
  const legalAttribution =
    "Includes software derived from the OpenWork project under the MIT License. Includes OpenCode under the MIT License. AgencyAI is not endorsed by either upstream project.";

  assert.deepEqual(ALLOWED_UPSTREAM_LEGAL_LITERALS, [legalAttribution]);
  assert(isAllowedUpstreamStringLiteral(legalAttribution));
  assert(!isAllowedUpstreamStringLiteral(`${legalAttribution} OpenWork Cloud.`));
});

test("freezes the exact curated local documentation closure", () => {
  assert.deepEqual(EXPECTED_DOC_FILES, [
    "browser-and-computer-use.mdx",
    "docs.json",
    "getting-started.mdx",
    "mcp-and-skills.mdx",
    "privacy-and-security.mdx",
    "providers.mdx",
    "troubleshooting.mdx",
  ]);
  assert(Object.isFrozen(EXPECTED_DOC_FILES));
});
