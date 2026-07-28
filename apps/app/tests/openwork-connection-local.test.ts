import { describe, expect, test } from "bun:test";

import { projectLocalDesktopRuntimeConnection } from "../src/react-app/shell/openwork-connection";

describe("local desktop runtime connection", () => {
  test("accepts only a running live loopback endpoint with a bearer token", () => {
    expect(projectLocalDesktopRuntimeConnection({
      running: true,
      baseUrl: "http://127.0.0.1:8787",
      ownerToken: "owner",
      hostToken: "host",
    })).toMatchObject({
      normalizedBaseUrl: "http://127.0.0.1:8787",
      resolvedToken: "owner",
      resolvedHostToken: "host",
      source: "desktop-runtime",
    });
  });

  test("fails closed for stale, stopped, tokenless, and non-loopback runtime info", () => {
    const rejected = [
      null,
      { running: false, baseUrl: "http://127.0.0.1:8787", ownerToken: "owner" },
      { running: true, baseUrl: "http://127.0.0.1:8787" },
      { running: true, baseUrl: "https://cloud.openworklabs.com", ownerToken: "owner" },
      { running: true, baseUrl: "http://127.0.0.1.evil.test", ownerToken: "owner" },
      { running: true, connectUrl: "http://127.0.0.1:8787", ownerToken: "owner" },
    ];
    for (const info of rejected) {
      expect(projectLocalDesktopRuntimeConnection(info)).toEqual({
        normalizedBaseUrl: "",
        resolvedToken: "",
        resolvedHostToken: "",
        hostInfo: null,
        source: "empty",
      });
    }
  });
});
