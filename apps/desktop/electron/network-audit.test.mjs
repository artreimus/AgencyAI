import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  NetworkAuditDeniedError,
  createNetworkAudit,
  isLoopbackHostname,
} from "./network-audit.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agencyai-network-audit-"));
  roots.push(root);
  const logs = path.join(root, "logs");
  mkdirSync(logs);
  const auditPath = path.join(logs, "network.jsonl");
  return { root, auditPath };
}

describe("network audit", () => {
  it("recognizes exact loopback hosts without prefix confusion", () => {
    assert.equal(isLoopbackHostname("127.0.0.1"), true);
    assert.equal(isLoopbackHostname("localhost"), true);
    assert.equal(isLoopbackHostname("[::1]"), true);
    assert.equal(isLoopbackHostname("127.0.0.1.example.com"), false);
    assert.equal(isLoopbackHostname("localhost.example.com"), false);
  });

  it("records and rejects non-loopback global fetch before transport", async () => {
    const { root, auditPath } = fixture();
    let transports = 0;
    const target = {
      fetch: async (_input, _init) => {
        transports += 1;
        return new Response("ok");
      },
    };
    const audit = createNetworkAudit({
      mode: "deny-non-loopback",
      auditPath,
      storageRoot: root,
      now: () => "2026-07-28T00:00:00.000Z",
    });
    audit.installGlobalFetch(target);
    await assert.rejects(
      target.fetch("https://example.net/secret?token=nope", undefined),
      NetworkAuditDeniedError,
    );
    assert.equal(transports, 0);
    await target.fetch("http://127.0.0.1:4096/health", undefined);
    assert.equal(transports, 1);
    const records = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map(({ origin, decision }) => ({ origin, decision })),
      [
        { origin: "https://example.net", decision: "deny" },
        { origin: "http://127.0.0.1:4096", decision: "allow" },
      ],
    );
    assert.equal(readFileSync(auditPath, "utf8").includes("token"), false);
  });

  it("fails closed when an Electron session observes non-loopback traffic", () => {
    const { root, auditPath } = fixture();
    /** @type {Function | null} */
    let listener = null;
    const audit = createNetworkAudit({
      mode: "deny-non-loopback",
      auditPath,
      storageRoot: root,
    });
    audit.installElectronSession({
      webRequest: {
        onBeforeRequest(_filter, next) {
          listener = next;
        },
      },
    }, "test");
    let response;
    if (!listener) throw new Error("network listener was not registered");
    listener(
      { url: "https://example.net/path", method: "GET" },
      (value) => { response = value; },
    );
    assert.deepEqual(response, { cancel: true });
  });

  it("rejects audit outputs outside product storage", () => {
    const { root } = fixture();
    assert.throws(
      () =>
        createNetworkAudit({
          mode: "audit",
          auditPath: path.join(path.dirname(root), "escape.jsonl"),
          storageRoot: root,
        }),
      /descendant/,
    );
  });
});
