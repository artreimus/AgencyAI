import { describe, expect, test } from "bun:test";

import {
  projectLocalDesktopRuntimeConnection,
  waitForOpenworkConnection,
} from "../src/react-app/shell/openwork-connection";
import { publishDesktopRuntimeConnection } from "../src/react-app/shell/desktop-runtime-boot";

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

  test("waits through a cold-start miss and returns the live runtime connection", async () => {
    let attempts = 0;
    let now = 0;
    const ready = projectLocalDesktopRuntimeConnection({
      running: true,
      baseUrl: "http://127.0.0.1:8787",
      ownerToken: "owner",
    });

    const connection = await waitForOpenworkConnection({
      timeoutMs: 1_000,
      initialDelayMs: 50,
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      resolveConnection: async () => {
        attempts += 1;
        return attempts === 1
          ? projectLocalDesktopRuntimeConnection(null)
          : ready;
      },
    });

    expect(attempts).toBe(2);
    expect(connection).toEqual(ready);
  });

  test("notifies local routes when desktop startup becomes ready without persisting cloud settings", () => {
    let notifications = 0;
    let persistedSettings = 0;

    expect(publishDesktopRuntimeConnection({
      running: true,
      baseUrl: "http://127.0.0.1:8787",
      ownerToken: "owner",
    }, {
      openworkCloud: false,
      persistSettings: () => {
        persistedSettings += 1;
      },
      notify: () => {
        notifications += 1;
      },
    })).toBe(true);

    expect(notifications).toBe(1);
    expect(persistedSettings).toBe(0);
  });
});
