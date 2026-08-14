import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsRoot, "..");
const repoRoot = resolve(desktopRoot, "../..");
const rendererPublic = resolve(repoRoot, "apps/app/public");
const iconRoot = resolve(desktopRoot, "resources/icons");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function pngDimensions(filePath) {
  const data = readFileSync(filePath);
  assert.deepEqual(
    data.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

test("AgencyAI generated mark and HTML metadata contain only the product identity", () => {
  const indexHtml = readFileSync(
    resolve(repoRoot, "apps/app/index.html"),
    "utf8",
  );
  const overlayHtml = readFileSync(
    resolve(repoRoot, "apps/app/overlay.html"),
    "utf8",
  );
  assert.match(indexHtml, /<title>AgencyAI<\/title>/);
  assert.match(indexHtml, /agencyai-mark\.png/);
  assert.match(overlayHtml, /<title>AgencyAI Overlay<\/title>/);
  assert.doesNotMatch(`${indexHtml}\n${overlayHtml}`, /OpenWork/);

  for (const removed of [
    "agencyai-mark.svg",
    "openwork-logo.svg",
    "openwork-logo-square.svg",
    "openwork-mark.svg",
  ]) {
    assert.equal(existsSync(resolve(rendererPublic, removed)), false);
  }
});

test("generated renderer and desktop raster assets have exact dimensions", () => {
  const expected = new Map([
    [resolve(iconRoot, "agencyai-icon-source.png"), 1024],
    [resolve(rendererPublic, "agencyai-mark.png"), 1024],
    [resolve(iconRoot, "icon.png"), 512],
    [resolve(iconRoot, "dev/icon.png"), 512],
    [resolve(iconRoot, "dev/32x32.png"), 32],
    [resolve(iconRoot, "dev/128x128.png"), 128],
    [resolve(iconRoot, "dev/128x128@2x.png"), 256],
    [resolve(rendererPublic, "favicon-16x16.png"), 16],
    [resolve(rendererPublic, "favicon-32x32.png"), 32],
    [resolve(rendererPublic, "apple-touch-icon.png"), 180],
  ]);

  for (const [filePath, size] of expected) {
    assert.deepEqual(pngDimensions(filePath), {
      width: size,
      height: size,
    });
  }
});

test("production and development assets are valid and visually distinct", () => {
  assert.notEqual(
    sha256(resolve(iconRoot, "icon.png")),
    sha256(resolve(iconRoot, "dev/icon.png")),
  );
  assert.notEqual(
    sha256(resolve(iconRoot, "icon.icns")),
    sha256(resolve(iconRoot, "dev/icon-dev.icns")),
  );
  assert.equal(
    readFileSync(resolve(iconRoot, "icon.icns")).subarray(0, 4).toString(),
    "icns",
  );
  assert.deepEqual(
    readFileSync(resolve(iconRoot, "icon.ico")).subarray(0, 4),
    Buffer.from([0, 0, 1, 0]),
  );
  for (const removed of [
    resolve(iconRoot, "agencyai-mark.svg"),
    resolve(iconRoot, "dev/agencyai-mark-dev.svg"),
  ]) {
    assert.equal(existsSync(removed), false);
  }
});
