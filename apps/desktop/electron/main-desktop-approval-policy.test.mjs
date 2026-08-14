import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const mainSource = await readFile(
  new URL("./main.mjs", import.meta.url),
  "utf8",
);
const helperMatch = mainSource.match(
  /\/\* DESKTOP_APPROVAL_POLICY_HELPERS_START \*\/([\s\S]*?)\/\* DESKTOP_APPROVAL_POLICY_HELPERS_END \*\//,
);
assert.ok(helperMatch, "desktop approval policy helper block must remain extractable");
const helpers = await import(
  `data:text/javascript;base64,${Buffer.from(helperMatch[1]).toString("base64")}`,
);

const INTERNAL_ORIGIN = "agencyai-internal://renderer";
const RAW_GRANT = `aai_da_${"a".repeat(43)}`;

function runtimeInfo(overrides = {}) {
  return {
    running: true,
    remoteAccessEnabled: false,
    host: "127.0.0.1",
    port: 48_123,
    baseUrl: "http://127.0.0.1:48123",
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: "client-token",
    ownerToken: "owner-token",
    hostToken: "host-token",
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    pid: null,
    lastStdout: null,
    lastStderr: null,
    ...overrides,
  };
}

function localWorkspaceState(overrides = {}) {
  return {
    selectedId: "ws_local",
    activeId: "ws_local",
    workspaces: [{
      id: "ws_local",
      workspaceType: "local",
      path: "/tmp/agencyai-workspace",
    }],
    ...overrides,
  };
}

function rendererHarness(url = `${INTERNAL_ORIGIN}/workspace/ws_local`) {
  const mainFrame = { url };
  const webContents = {
    id: 17,
    mainFrame,
    isDestroyed: () => false,
    getURL: () => url,
  };
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    mainWindow: {
      webContents,
      isDestroyed: () => false,
    },
    webContents,
    mainFrame,
  };
}

function validProtectedFetch(overrides = {}) {
  const renderer = rendererHarness();
  return {
    url: "http://127.0.0.1:48123/workspace/ws_local/inbox",
    init: {
      method: "POST",
      headers: {
        Authorization: "Bearer owner-token",
      },
      desktopApprovalCredential: RAW_GRANT,
      bodyEnvelope: {
        kind: "binary",
        contentType: "application/octet-stream",
        bytes: new Uint8Array([0, 1, 2, 127, 128, 255]),
      },
    },
    event: renderer.event,
    mainWindow: renderer.mainWindow,
    trustedRendererOrigin: INTERNAL_ORIGIN,
    runtimeInfo: runtimeInfo(),
    ...overrides,
  };
}

describe("desktop approval trusted renderer origin", () => {
  const profile = { brand: { rendererScheme: "agencyai-internal" } };

  it("always uses the compiled internal origin when packaged", () => {
    assert.equal(
      helpers.resolveDesktopApprovalTrustedRendererOrigin({
        productProfile: profile,
        isPackaged: true,
        env: { OPENWORK_ELECTRON_START_URL: "http://127.0.0.1:5173/app" },
      }),
      INTERNAL_ORIGIN,
    );
  });

  it("accepts only exact unpackaged loopback HTTP(S) origins", () => {
    for (const [startUrl, expected] of [
      ["http://127.0.0.1:5173/app?q=1", "http://127.0.0.1:5173"],
      ["https://localhost:4443/app", "https://localhost:4443"],
      ["http://[::1]:4173/app", "http://[::1]:4173"],
    ]) {
      assert.equal(
        helpers.resolveDesktopApprovalTrustedRendererOrigin({
          productProfile: profile,
          isPackaged: false,
          env: { OPENWORK_ELECTRON_START_URL: startUrl },
        }),
        expected,
      );
    }
  });

  it("falls back to the internal origin for remote, opaque, and lookalike URLs", () => {
    for (const startUrl of [
      "https://example.com/app",
      "file:///tmp/index.html",
      "data:text/html,hello",
      "http://localhost.evil.example:5173",
      "http://127.0.0.1.evil.example:5173",
      "http://127.1:5173",
      "http://2130706433:5173",
      "http://user@localhost:5173",
    ]) {
      assert.equal(
        helpers.resolveDesktopApprovalTrustedRendererOrigin({
          productProfile: profile,
          isPackaged: false,
          env: { OPENWORK_ELECTRON_START_URL: startUrl },
        }),
        INTERNAL_ORIGIN,
      );
    }
  });
});

describe("desktop approval IPC sender policy", () => {
  it("accepts only the live main-frame sender at the exact current origin", () => {
    const renderer = rendererHarness();
    assert.equal(
      helpers.assertDesktopApprovalIpcSender({
        event: renderer.event,
        mainWindow: renderer.mainWindow,
        trustedRendererOrigin: INTERNAL_ORIGIN,
      }),
      17,
    );
  });

  it("rejects wrong windows, subframes, null frames, and stale WebContents", () => {
    const renderer = rendererHarness();
    const cases = [
      {
        event: {
          sender: { ...renderer.webContents, id: 18 },
          senderFrame: renderer.mainFrame,
        },
        mainWindow: renderer.mainWindow,
      },
      {
        event: {
          sender: renderer.webContents,
          senderFrame: { url: `${INTERNAL_ORIGIN}/iframe` },
        },
        mainWindow: renderer.mainWindow,
      },
      {
        event: { sender: renderer.webContents, senderFrame: null },
        mainWindow: renderer.mainWindow,
      },
      {
        event: {
          sender: {
            ...renderer.webContents,
            isDestroyed: () => true,
          },
          senderFrame: renderer.mainFrame,
        },
        mainWindow: {
          ...renderer.mainWindow,
          webContents: {
            ...renderer.webContents,
            isDestroyed: () => true,
          },
        },
      },
    ];
    for (const testCase of cases) {
      assert.throws(
        () => helpers.assertDesktopApprovalIpcSender({
          ...testCase,
          trustedRendererOrigin: INTERNAL_ORIGIN,
        }),
        /Desktop approval denied/,
      );
    }
  });

  it("rejects file, data, remote, lookalike, and stale current origins", () => {
    for (const frameUrl of [
      "file:///tmp/index.html",
      "data:text/html,hello",
      "https://example.com/",
      "agencyai-internal://renderer.evil.example/",
    ]) {
      const renderer = rendererHarness(frameUrl);
      assert.throws(
        () => helpers.assertDesktopApprovalIpcSender({
          event: renderer.event,
          mainWindow: renderer.mainWindow,
          trustedRendererOrigin: INTERNAL_ORIGIN,
        }),
        /renderer origin is not trusted/,
      );
    }

    const stale = rendererHarness();
    stale.webContents.getURL = () => "https://example.com/";
    assert.throws(
      () => helpers.assertDesktopApprovalIpcSender({
        event: stale.event,
        mainWindow: stale.mainWindow,
        trustedRendererOrigin: INTERNAL_ORIGIN,
      }),
      /renderer origin is not trusted/,
    );
  });

  it("keeps the legacy packaged file renderer fail-closed", () => {
    const packagedFileRenderer = rendererHarness(
      "file:///Applications/AgencyAI.app/Contents/Resources/app-dist/index.html",
    );
    assert.throws(
      () => helpers.assertDesktopApprovalIpcSender({
        event: packagedFileRenderer.event,
        mainWindow: packagedFileRenderer.mainWindow,
        trustedRendererOrigin: INTERNAL_ORIGIN,
      }),
      /renderer origin is not trusted/,
    );
  });
});

describe("desktop approval workspace and runtime policy", () => {
  it("keeps broad or global mutations out of the trusted operation inventory", () => {
    assert.equal(
      helpers.isSupportedDesktopApprovalOperation("config.write"),
      true,
    );
    for (const operation of [
      "config.global.write",
      "config.authorized_folders.write",
      "mcp.auth.remove",
      "plugins.add",
      "plugins.remove",
      "workspace.files.session.write",
    ]) {
      assert.equal(
        helpers.isSupportedDesktopApprovalOperation(operation),
        false,
        operation,
      );
    }
  });

  it("returns the exact supported local request context", () => {
    assert.deepEqual(
      helpers.resolveDesktopApprovalRequestContext({
        request: {
          workspaceId: "ws_local",
          operation: "workspace.inbox.upload",
        },
        workspaceState: localWorkspaceState(),
        runtimeInfo: runtimeInfo(),
        webContentsId: 17,
      }),
      {
        workspaceId: "ws_local",
        operation: "workspace.inbox.upload",
        webContentsId: 17,
      },
    );
  });

  it("accepts a selected server-owned workspace when the legacy Electron registry is empty", () => {
    assert.deepEqual(
      helpers.resolveDesktopApprovalRequestContext({
        request: {
          workspaceId: "ws_local",
          operation: "workspace.inbox.upload",
        },
        workspaceState: localWorkspaceState({ workspaces: [] }),
        runtimeInfo: runtimeInfo(),
        webContentsId: 17,
      }),
      {
        workspaceId: "ws_local",
        operation: "workspace.inbox.upload",
        webContentsId: 17,
      },
    );
  });

  it("rejects unsupported operations, stale selections, and inactive runtimes", () => {
    const base = {
      request: {
        workspaceId: "ws_local",
        operation: "workspace.inbox.upload",
      },
      workspaceState: localWorkspaceState(),
      runtimeInfo: runtimeInfo(),
      webContentsId: 17,
    };
    const cases = [
      {
        ...base,
        request: { ...base.request, operation: "arbitrary.write" },
      },
      {
        ...base,
        request: { ...base.request, workspaceId: "ws_other" },
      },
      {
        ...base,
        workspaceState: localWorkspaceState({ activeId: "ws_previous" }),
      },
      {
        ...base,
        workspaceState: localWorkspaceState({
          selectedId: "",
          activeId: null,
          workspaces: [],
        }),
      },
      {
        ...base,
        runtimeInfo: runtimeInfo({ running: false }),
      },
      {
        ...base,
        runtimeInfo: runtimeInfo({
          host: "0.0.0.0",
          remoteAccessEnabled: true,
        }),
      },
    ];
    for (const testCase of cases) {
      assert.throws(
        () => helpers.resolveDesktopApprovalRequestContext(testCase),
        /Desktop approval denied/,
      );
    }
  });
});

describe("desktop fetch structured body envelope", () => {
  it("reconstructs binary bytes losslessly", () => {
    const prepared = helpers.prepareDesktopFetchRequest(
      validProtectedFetch(),
    );
    assert.deepEqual(
      Array.from(prepared.requestInit.body),
      [0, 1, 2, 127, 128, 255],
    );
    assert.equal(
      prepared.requestInit.headers.get("Content-Type"),
      "application/octet-stream",
    );
  });

  it("reconstructs multipart fields and file bytes losslessly", async () => {
    const renderer = rendererHarness();
    const prepared = helpers.prepareDesktopFetchRequest({
      url: "http://127.0.0.1:48123/workspace/ws_local/inbox",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer owner-token",
          "Content-Type": "multipart/form-data; boundary=renderer-owned",
        },
        desktopApprovalCredential: RAW_GRANT,
        bodyEnvelope: {
          kind: "multipart",
          parts: [
            { kind: "field", name: "path", value: "nested/report.bin" },
            {
              kind: "file",
              name: "file",
              fileName: "report.bin",
              contentType: "application/octet-stream",
              bytes: new Uint8Array([0, 10, 13, 127, 128, 255]),
            },
          ],
        },
      },
      event: renderer.event,
      mainWindow: renderer.mainWindow,
      trustedRendererOrigin: INTERNAL_ORIGIN,
      runtimeInfo: runtimeInfo(),
    });
    assert.equal(prepared.requestInit.headers.has("Content-Type"), false);

    const request = new Request(prepared.url, prepared.requestInit);
    assert.match(
      request.headers.get("Content-Type") ?? "",
      /^multipart\/form-data; boundary=/,
    );
    const form = await request.formData();
    assert.equal(form.get("path"), "nested/report.bin");
    const file = form.get("file");
    assert.notEqual(file, null);
    assert.notEqual(typeof file, "string");
    if (file === null || typeof file === "string") {
      throw new Error("Expected multipart file");
    }
    assert.equal(file.name, "report.bin");
    assert.equal(file.type, "application/octet-stream");
    assert.deepEqual(
      Array.from(new Uint8Array(await file.arrayBuffer())),
      [0, 10, 13, 127, 128, 255],
    );
  });

  it("rejects ambiguous and malformed envelopes", () => {
    const valid = validProtectedFetch();
    assert.throws(
      () => helpers.prepareDesktopFetchRequest({
        ...valid,
        init: {
          ...valid.init,
          body: "also-present",
        },
      }),
      /request body is ambiguous/,
    );
    assert.throws(
      () => helpers.prepareDesktopFetchRequest({
        ...valid,
        init: {
          ...valid.init,
          bodyEnvelope: {
            kind: "binary",
            bytes: [1, 2, 3],
          },
        },
      }),
      /must be Uint8Array/,
    );
  });
});

describe("desktop fetch protected relay", () => {
  it("injects the private header and exact Origin only after all bindings match", () => {
    const prepared = helpers.prepareDesktopFetchRequest(
      validProtectedFetch(),
    );
    assert.equal(
      prepared.requestInit.headers.get("X-AgencyAI-Desktop-Approval"),
      RAW_GRANT,
    );
    assert.equal(
      prepared.requestInit.headers.get("Origin"),
      INTERNAL_ORIGIN,
    );
    assert.equal(prepared.requestInit.redirect, "error");
    assert.equal(prepared.requestInit.credentials, "omit");
  });

  it("rejects renderer-supplied approval headers case-insensitively", () => {
    for (const name of [
      "x-agencyai-desktop-approval",
      "X-AgEnCyAi-DeSkToP-ApPrOvAl",
    ]) {
      const valid = validProtectedFetch();
      assert.throws(
        () => helpers.prepareDesktopFetchRequest({
          ...valid,
          init: {
            ...valid.init,
            headers: {
              ...valid.init.headers,
              [name]: RAW_GRANT,
            },
          },
        }),
        /approval header must be injected by Electron/,
      );
    }
  });

  it("requires the relay bearer to match owner-first grant issuance exactly", () => {
    const ownerBound = validProtectedFetch();
    assert.throws(
      () => helpers.prepareDesktopFetchRequest({
        ...ownerBound,
        init: {
          ...ownerBound.init,
          headers: { Authorization: "Bearer client-token" },
        },
      }),
      /bearer token does not match the approval grant/,
    );

    const clientFallback = validProtectedFetch({
      runtimeInfo: runtimeInfo({ ownerToken: null }),
    });
    clientFallback.init = {
      ...clientFallback.init,
      headers: { Authorization: "Bearer client-token" },
    };
    assert.doesNotThrow(
      () => helpers.prepareDesktopFetchRequest(clientFallback),
    );
  });

  it("rejects wrong targets, untrusted Origin headers, and inactive runtimes", () => {
    const valid = validProtectedFetch();
    for (const testCase of [
      { ...valid, url: "https://example.com/upload" },
      {
        ...valid,
        init: {
          ...valid.init,
          headers: {
            ...valid.init.headers,
            Origin: "https://example.com",
          },
        },
      },
      {
        ...valid,
        runtimeInfo: runtimeInfo({ running: false }),
      },
    ]) {
      assert.throws(
        () => helpers.prepareDesktopFetchRequest(testCase),
        /Desktop fetch denied|Desktop approval denied/,
      );
    }
  });
});

it("wires policy, revocation, and protected relay into Electron main", () => {
  assert.match(mainSource, /productPolicy:\s*PRODUCT_PROFILE/);
  assert.match(mainSource, /trustedRendererOrigin:\s*TRUSTED_RENDERER_ORIGIN/);
  assert.match(
    mainSource,
    /"desktopApprovalGrant":\s*async[\s\S]*?assertDesktopApprovalIpcSender[\s\S]*?workspaceStore\.readWorkspaceState\(\)[\s\S]*?runtimeManager\.desktopApprovalGrant\(context\)/,
  );
  assert.match(mainSource, /"render-process-gone"/);
  assert.match(mainSource, /\.once\("destroyed"/);
  assert.match(
    mainSource,
    /"did-start-navigation"[\s\S]*?if \(isMainFrame\)[\s\S]*?revokeDesktopApprovalGrantsForWebContents/,
  );
  for (const command of [
    "engineStop",
    "engineRestart",
    "openworkServerRestart",
  ]) {
    assert.match(
      mainSource,
      new RegExp(
        `"${command}":\\s*async[\\s\\S]*?revokeDesktopApprovalGrantsBeforeRuntimeChange\\(\\)[\\s\\S]*?runtimeManager\\.${command}\\(`,
      ),
    );
  }
  assert.match(mainSource, /prepareDesktopFetchRequest/);
});
