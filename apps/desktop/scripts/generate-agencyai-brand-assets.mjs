import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const rendererPublic = resolve(repoRoot, "apps/app/public");
const iconRoot = resolve(desktopRoot, "resources/icons");
const productionMark = resolve(rendererPublic, "agencyai-mark.svg");
const developmentMark = resolve(iconRoot, "dev/agencyai-mark-dev.svg");

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? 1}`);
  }
}

function rasterize(source, size, output) {
  run("magick", [
    "-background",
    "none",
    source,
    "-resize",
    `${size}x${size}`,
    output,
  ]);
}

function createIcns(source, output, temporaryRoot) {
  const iconset = join(temporaryRoot, `${Date.now()}-${Math.random()}.iconset`);
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    rasterize(source, size, join(iconset, `icon_${size}x${size}.png`));
    rasterize(
      source,
      size * 2,
      join(iconset, `icon_${size}x${size}@2x.png`),
    );
  }
  run("iconutil", ["-c", "icns", iconset, "-o", output]);
}

function createIco(source, output) {
  run("magick", [
    "-background",
    "none",
    source,
    "-define",
    "icon:auto-resize=256,128,64,48,32,24,16",
    output,
  ]);
}

export function generateAgencyAiBrandAssets() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agencyai-brand-assets-"));
  try {
    mkdirSync(iconRoot, { recursive: true });
    mkdirSync(resolve(iconRoot, "dev"), { recursive: true });

    rasterize(productionMark, 512, resolve(iconRoot, "icon.png"));
    createIco(productionMark, resolve(iconRoot, "icon.ico"));
    createIcns(productionMark, resolve(iconRoot, "icon.icns"), temporaryRoot);

    const devRoot = resolve(iconRoot, "dev");
    rasterize(developmentMark, 512, resolve(devRoot, "icon.png"));
    rasterize(developmentMark, 32, resolve(devRoot, "32x32.png"));
    rasterize(developmentMark, 128, resolve(devRoot, "128x128.png"));
    rasterize(developmentMark, 256, resolve(devRoot, "128x128@2x.png"));
    createIcns(
      developmentMark,
      resolve(devRoot, "icon-dev.icns"),
      temporaryRoot,
    );

    rasterize(productionMark, 16, resolve(rendererPublic, "favicon-16x16.png"));
    rasterize(productionMark, 32, resolve(rendererPublic, "favicon-32x32.png"));
    rasterize(productionMark, 180, resolve(rendererPublic, "apple-touch-icon.png"));

    cpSync(productionMark, resolve(iconRoot, "agencyai-mark.svg"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    generateAgencyAiBrandAssets();
  } catch (error) {
    process.stderr.write(
      `[agencyai-brand-assets] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
