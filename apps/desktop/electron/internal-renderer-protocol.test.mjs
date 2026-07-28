import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PRODUCTION_RENDERER_CSP,
  createInternalRendererProtocolHandler,
  internalRendererOrigin,
  registerInternalRendererScheme,
} from "./internal-renderer-protocol.mjs";

describe("AgencyAI internal renderer protocol", () => {
  it("registers one secure standard scheme without public-protocol privileges", () => {
    const calls = [];
    const origin = registerInternalRendererScheme({
      registerSchemesAsPrivileged(value) {
        calls.push(value);
      },
    }, "agencyai-internal");

    assert.equal(origin, "agencyai-internal://renderer");
    assert.deepEqual(calls, [[{
      scheme: "agencyai-internal",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    }]]);
    assert.equal(internalRendererOrigin("agencyai-internal:"), origin);
  });

  it("serves only canonical assets under the renderer root with a strict CSP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agencyai-renderer-"));
    const outside = await mkdtemp(path.join(tmpdir(), "agencyai-outside-"));
    try {
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "index.html"), "<!doctype html><title>AgencyAI</title>");
      await writeFile(path.join(root, "assets", "app.js"), "export const ready = true;");
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

      const handler = createInternalRendererProtocolHandler({
        rendererRoot: root,
        scheme: "agencyai-internal",
        netFetch: async (url) => {
          const filePath = new URL(url);
          const content = await import("node:fs/promises")
            .then(({ readFile }) => readFile(filePath));
          return new Response(content, {
            headers: { "Content-Type": url.endsWith(".js") ? "text/javascript" : "text/html" },
          });
        },
      });

      const index = await handler(new Request("agencyai-internal://renderer/"));
      assert.equal(index.status, 200);
      assert.match(await index.text(), /AgencyAI/);
      assert.equal(index.headers.get("content-security-policy"), PRODUCTION_RENDERER_CSP);
      assert.equal(PRODUCTION_RENDERER_CSP.includes("'unsafe-eval'"), false);
      assert.equal(index.headers.get("x-content-type-options"), "nosniff");

      const asset = await handler(new Request("agencyai-internal://renderer/assets/app.js"));
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /ready/);

      assert.equal(
        (await handler(new Request("agencyai-internal://other/index.html"))).status,
        403,
      );
      assert.equal(
        (await handler(new Request("agencyai-internal://renderer/escape.txt"))).status,
        404,
      );
      assert.equal(
        (await handler(new Request("agencyai-internal://renderer/missing.js"))).status,
        404,
      );
      assert.equal(
        (await handler(new Request("agencyai-internal://renderer/", { method: "POST" }))).status,
        405,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
