import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  installMediaPermissionHandlers,
  shouldAllowMainWindowPermission,
} from "./media-permissions.mjs";

function webContents(url = "agencyai-internal://renderer/") {
  return {
    id: 17,
    isDestroyed: () => false,
    getURL: () => url,
  };
}

function windowFor(contents) {
  return {
    isDestroyed: () => false,
    webContents: contents,
  };
}

describe("desktop permission policy", () => {
  it("denies every capability unless microphone is profile-enabled on the exact renderer", () => {
    const contents = webContents();
    const base = {
      webContents: contents,
      mainWindow: windowFor(contents),
      origin: "agencyai-internal://renderer/voice",
      trustedRendererOrigin: "agencyai-internal://renderer",
      details: { mediaTypes: ["audio"] },
    };

    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      permission: "media",
      allowMicrophone: false,
    }), false);
    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      permission: "media",
      allowMicrophone: true,
    }), true);
    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      permission: "media",
      allowMicrophone: true,
      details: { mediaTypes: ["audio", "video"] },
    }), false);
    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      permission: "clipboard-read",
      allowMicrophone: true,
    }), false);
    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      permission: "audioCapture",
      origin: "https://renderer.evil.example",
      allowMicrophone: true,
    }), false);
    assert.equal(shouldAllowMainWindowPermission({
      ...base,
      webContents: webContents(),
      permission: "audioCapture",
      allowMicrophone: true,
    }), false);
  });

  it("installs exact-origin handlers and default-deny browser-session handlers", () => {
    const registered = {};
    const makeSession = (name) => ({
      setPermissionRequestHandler(handler) {
        registered[`${name}:request`] = handler;
      },
      setPermissionCheckHandler(handler) {
        registered[`${name}:check`] = handler;
      },
    });
    const defaultSession = makeSession("default");
    const browserSession = makeSession("browser");
    const contents = webContents();
    const mainWindow = windowFor(contents);

    installMediaPermissionHandlers({
      defaultSession,
      fromPartition(partition) {
        assert.equal(partition, "persist:openwork-browser");
        return browserSession;
      },
    }, () => mainWindow, {
      trustedRendererOrigin: "agencyai-internal://renderer",
      allowMicrophone: false,
    });

    let defaultDecision = null;
    registered["default:request"](
      contents,
      "media",
      (allowed) => {
        defaultDecision = allowed;
      },
      {
        requestingUrl: "agencyai-internal://renderer/",
        mediaTypes: ["audio"],
      },
    );
    assert.equal(defaultDecision, false);

    let browserDecision = null;
    registered["browser:request"](
      contents,
      "notifications",
      (allowed) => {
        browserDecision = allowed;
      },
      {},
    );
    assert.equal(browserDecision, false);
    assert.equal(registered["browser:check"](), false);
  });
});
