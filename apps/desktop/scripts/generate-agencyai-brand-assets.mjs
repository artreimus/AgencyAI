import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const rendererPublic = resolve(repoRoot, "apps/app/public");
const iconRoot = resolve(desktopRoot, "resources/icons");
const productionMark = resolve(iconRoot, "agencyai-icon-source.png");
const rendererMark = resolve(rendererPublic, "agencyai-mark.png");

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
  const chunkSpecs = Object.freeze([
    ["ic04", 16],
    ["ic05", 32],
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic13", 256],
    ["ic09", 512],
    ["ic14", 512],
    ["ic10", 1024],
  ]);
  const images = new Map();
  for (const size of new Set(chunkSpecs.map(([, value]) => value))) {
    const filePath = join(temporaryRoot, `agencyai-${size}.png`);
    rasterize(source, size, filePath);
    images.set(size, readFileSync(filePath));
  }
  const chunks = chunkSpecs.map(([type, size]) => {
    const image = images.get(size);
    const chunk = Buffer.allocUnsafe(8 + image.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    image.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.allocUnsafe(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  writeFileSync(output, Buffer.concat([header, ...chunks]));
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

function createDevelopmentIcon(source, output) {
  run("magick", [
    source,
    "-resize",
    "512x512",
    "-fill",
    "#f59e0b",
    "-stroke",
    "#07112f",
    "-strokewidth",
    "12",
    "-draw",
    "circle 420,92 420,30",
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
    const developmentIcon = resolve(devRoot, "icon.png");
    createDevelopmentIcon(productionMark, developmentIcon);
    rasterize(developmentIcon, 32, resolve(devRoot, "32x32.png"));
    rasterize(developmentIcon, 128, resolve(devRoot, "128x128.png"));
    rasterize(developmentIcon, 256, resolve(devRoot, "128x128@2x.png"));
    createIcns(
      developmentIcon,
      resolve(devRoot, "icon-dev.icns"),
      temporaryRoot,
    );

    cpSync(productionMark, rendererMark);
    rasterize(productionMark, 16, resolve(rendererPublic, "favicon-16x16.png"));
    rasterize(productionMark, 32, resolve(rendererPublic, "favicon-32x32.png"));
    rasterize(productionMark, 180, resolve(rendererPublic, "apple-touch-icon.png"));
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
