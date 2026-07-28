import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveProductArchitectureInfo } from "./architecture-policy.mjs";

describe("resolveProductArchitectureInfo", () => {
  it("uses local build metadata without evaluating release resolvers when disabled", async () => {
    let resolverCalls = 0;
    const info = await resolveProductArchitectureInfo({
      appArch: "x64",
      systemArch: "arm64",
      platform: "darwin",
      version: "0.1.0",
      automaticUpdates: false,
      remoteAssetFetches: false,
      resolveDownloadUrl: async () => {
        resolverCalls += 1;
        throw new Error("disabled resolver must not run");
      },
      fallbackDownloadUrl: () => {
        resolverCalls += 1;
        throw new Error("disabled fallback must not run");
      },
      releaseUrl: "https://upstream.invalid/releases",
    });

    assert.equal(resolverCalls, 0);
    assert.equal(info.mismatch, true);
    assert.equal(info.downloadUrl, null);
    assert.equal(info.releaseUrl, null);
    assert.equal(info.appArchLabel, "Intel");
    assert.equal(info.systemArchLabel, "ARM");
  });

  it("preserves enabled upstream release resolution", async () => {
    const info = await resolveProductArchitectureInfo({
      appArch: "x64",
      systemArch: "arm64",
      platform: "win32",
      version: "1.2.3",
      automaticUpdates: true,
      remoteAssetFetches: true,
      resolveDownloadUrl: async (arch) =>
        `https://downloads.example/${arch}.exe`,
      fallbackDownloadUrl: (arch) =>
        `https://fallback.example/${arch}.exe`,
      releaseUrl: "https://downloads.example/releases",
    });

    assert.equal(info.mismatch, true);
    assert.equal(
      info.downloadUrl,
      "https://downloads.example/arm64.exe",
    );
    assert.equal(info.releaseUrl, "https://downloads.example/releases");
    assert.equal(info.platform, "windows");
  });
});
