import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const files = {
  main: new URL("./main.mjs", import.meta.url),
  browser: new URL("./browser-panel.mjs", import.meta.url),
  computerUse: new URL("./computer-use.mjs", import.meta.url),
  appMenu: new URL("./app-menu.mjs", import.meta.url),
  preload: new URL("./preload.cjs", import.meta.url),
  overlayPreload: new URL("./menu-overlay-preload.cjs", import.meta.url),
  appHtml: new URL("../../app/index.html", import.meta.url),
  overlayHtml: new URL("../../app/overlay.html", import.meta.url),
  package: new URL("../package.json", import.meta.url),
};
const source = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([name, url]) => [
    name,
    await readFile(url, "utf8"),
  ])),
);

describe("AgencyAI desktop security source closure", () => {
  it("loads only the sandboxed internal renderer through CommonJS preloads", async () => {
    assert.match(source.main, /registerInternalRendererScheme/);
    assert.match(source.main, /installInternalRendererProtocol/);
    assert.match(
      source.main,
      /loadURL\(`\$\{REGISTERED_INTERNAL_RENDERER_ORIGIN\}\/`\)/,
    );
    assert.match(source.main, /preloadPath = path\.join\(__dirname, "preload\.cjs"\)/);
    assert.match(source.main, /contextIsolation: true/);
    assert.match(source.main, /nodeIntegration: false/);
    assert.match(source.main, /sandbox: true/);
    assert.doesNotMatch(source.main, /\.loadFile\(/);
    assert.match(source.browser, /menu-overlay-preload\.cjs/);
    assert.match(
      source.browser,
      /let browserSession = null;[\s\S]+?browserSession \?\?= session\.fromPartition/,
    );
    assert.doesNotMatch(
      source.browser,
      /const browserSession = session\.fromPartition/,
    );
    assert.doesNotMatch(source.browser, /\.loadFile\(/);
    assert.match(source.preload, /^const \{ contextBridge, ipcRenderer \} = require\("electron"\);/);
    assert.match(source.overlayPreload, /^const \{ contextBridge, ipcRenderer \} = require\("electron"\);/);
    await assert.rejects(
      access(new URL("./preload.mjs", import.meta.url)),
    );
    await assert.rejects(
      access(new URL("./menu-overlay-preload.mjs", import.meta.url)),
    );
  });

  it("uses external theme code and a production CSP without unsafe eval", () => {
    assert.match(source.appHtml, /src="\/theme-bootstrap\.js"/);
    assert.match(source.overlayHtml, /src="\/theme-bootstrap\.js"/);
    assert.doesNotMatch(source.appHtml, /<script>\s*\(function/);
    assert.doesNotMatch(source.overlayHtml, /<script>\s*\(function/);
    assert.doesNotMatch(
      source.main,
      /webSecurity:\s*false|allowRunningInsecureContent:\s*true/,
    );
  });

  it("authorizes privileged main-window IPC and omits disabled service IPC", () => {
    assert.match(source.main, /authorizeMainIpcSender\(event\)/);
    assert.match(source.main, /registerTrustedMainHandle/);
    assert.match(source.browser, /authorizeMainSender\(event\)/);
    assert.match(
      source.main,
      /if \(PRODUCT_PROFILE\.features\.legacyOpenWorkImport\) \{\s*registerMigrationIpc/,
    );
    assert.match(
      source.main,
      /if \(PRODUCT_PROFILE\.features\.automaticUpdates\) \{\s*\(\{ ensureAutoUpdater \} = registerUpdaterIpc/,
    );
    assert.match(
      source.main,
      /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]+?\.catch\(\(error\) => \{\s*console\.error\("\[agencyai:fatal\] Desktop startup failed"/,
    );
  });

  it("keeps external navigation strict and browser CDP unpredictable in packages", () => {
    assert.match(source.main, /randomInt\(49_152, 65_536\)/);
    assert.doesNotMatch(source.main, /net\.createServer\(\)/);
    assert.doesNotMatch(source.main, /\[9223,\s*9224/);
    assert.match(
      source.main,
      /!app\.isPackaged &&\s*Number\.isFinite\(explicitCdpPort\)/,
    );
    assert.doesNotMatch(source.browser, /\bshell\./);
    assert.match(source.browser, /isAllowedExternalHttpsUrl/);
    assert.match(source.browser, /authorizeMainSender/);
    assert.match(
      source.computerUse,
      /if \(app\.isPackaged \|\| process\.env\.OPENWORK_DEV_MODE !== "1"\) return null/,
    );
    assert.match(
      source.computerUse,
      /app\.isPackaged \|\| productProfile\.profile === "local-mvp"/,
    );
    assert.match(
      source.main,
      /!app\.isPackaged &&\s*process\.env\.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN === "1"/,
    );
  });

  it("pins the supported Electron runtime and native rebuild tooling", () => {
    const packageMetadata = JSON.parse(source.package);
    assert.equal(packageMetadata.devDependencies.electron, "43.2.0");
    assert.equal(packageMetadata.devDependencies["@electron/rebuild"], "4.2.0");
    assert.equal(packageMetadata.devDependencies["@electron/fuses"], "2.1.3");
    assert.match(
      packageMetadata.scripts["rebuild:native"],
      /better-sqlite3,@lydell\/node-pty/,
    );
    assert.equal(
      packageMetadata.scripts["smoke:native"],
      "node ./scripts/run-native-module-smoke.mjs",
    );
  });
});
