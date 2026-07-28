import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  inventoryTree,
  selectPackageLicense,
  sha256FileSync,
} from "./generate-release-metadata.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const policy = {
  allowedLicenses: ["Apache-2.0", "MIT"],
  internalPackagePrefixes: ["@openwork/", "openwork-"],
  licenseSelections: {
    dual: {
      declared: "(MPL-2.0 OR Apache-2.0)",
      selected: "Apache-2.0",
    },
  },
};

describe("release metadata closure", () => {
  it("accepts only reviewed package license decisions", () => {
    assert.equal(selectPackageLicense("react", "MIT", policy), "MIT");
    assert.equal(
      selectPackageLicense("dual", "(MPL-2.0 OR Apache-2.0)", policy),
      "Apache-2.0",
    );
    assert.equal(
      selectPackageLicense("@openwork/product-config", null, policy),
      "NOASSERTION",
    );
    assert.throws(
      () => selectPackageLicense("copyleft", "GPL-3.0-only", policy),
      /unreviewed license/,
    );
    assert.throws(
      () => selectPackageLicense("dual", "MPL-2.0", policy),
      /declaration changed/,
    );
  });

  it("produces a stable sorted file-and-hash inventory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agencyai-release-tree-"));
    roots.push(root);
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "z.txt"), "z");
    writeFileSync(path.join(root, "nested", "a.txt"), "a");
    const inventory = inventoryTree(root);
    assert.deepEqual(
      inventory.map(({ path: filePath, type }) => ({ path: filePath, type })),
      [
        { path: "nested/a.txt", type: "file" },
        { path: "z.txt", type: "file" },
      ],
    );
    assert.equal(
      inventory[0].sha256,
      sha256FileSync(path.join(root, "nested", "a.txt")),
    );
  });
});
