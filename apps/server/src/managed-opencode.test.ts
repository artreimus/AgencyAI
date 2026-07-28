import { describe, expect, test } from "bun:test";
import { waitForManagedOpencodeReady } from "./managed-opencode.js";

describe("managed OpenCode readiness", () => {
  test("polls the authenticated global health endpoint for the exact version", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    let attempts = 0;

    await waitForManagedOpencodeReady({
      url: "http://127.0.0.1:4096",
      username: "generated-user",
      password: "generated-password",
      expectedVersion: "1.17.11",
      timeoutMs: 1_000,
      async fetchImpl(input, init) {
        attempts += 1;
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("Authorization"),
          redirect: init?.redirect,
        });
        if (attempts === 1) {
          return new Response(null, { status: 503 });
        }
        return Response.json({
          healthy: true,
          version: "1.17.11",
        });
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4096/global/health");
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("generated-user:generated-password").toString("base64")}`,
    );
    expect(requests[0]?.redirect).toBe("error");
  });

  test("rejects a different version or an expanded health payload", async () => {
    await expect(waitForManagedOpencodeReady({
      url: "http://127.0.0.1:4096",
      username: "generated-user",
      password: "generated-password",
      expectedVersion: "1.17.11",
      timeoutMs: 1,
      async fetchImpl() {
        return Response.json({
          healthy: true,
          version: "1.17.12",
          source: "unreviewed",
        });
      },
    })).rejects.toThrow(/did not match the pinned runtime contract/);
  });

  test("fails immediately if the managed process exits before readiness", async () => {
    await expect(waitForManagedOpencodeReady({
      url: "http://127.0.0.1:4096",
      username: "generated-user",
      password: "generated-password",
      expectedVersion: "1.17.11",
      timeoutMs: 1_000,
      isAlive: () => false,
      startupOutput: () => "runtime download disabled",
      async fetchImpl() {
        throw new Error("fetch must not run");
      },
    })).rejects.toThrow(
      "OpenCode server exited before readiness\nruntime download disabled",
    );
  });

  test("rejects redirects without requesting the second-hop health endpoint", async () => {
    let secondHopRequests = 0;
    const secondHop = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        secondHopRequests += 1;
        return Response.json({ healthy: true, version: "1.17.11" });
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: {
            Location: `http://127.0.0.1:${secondHop.port}/global/health`,
          },
        });
      },
    });

    try {
      await expect(waitForManagedOpencodeReady({
        url: `http://127.0.0.1:${redirector.port}`,
        username: "generated-user",
        password: "generated-password",
        expectedVersion: "1.17.11",
        timeoutMs: 50,
      })).rejects.toThrow();
      expect(secondHopRequests).toBe(0);
    } finally {
      await redirector.stop(true);
      await secondHop.stop(true);
    }
  });
});
