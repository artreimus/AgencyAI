// Local UI-control HTTP bridge: a loopback server exposing the legacy
// /snapshot, /actions and /execute routes plus the semantic /context, /query
// and /command surface. Dispatched to the renderer's window.__openworkControl.
// Extracted from main.mjs; state and lifecycle live in this factory
// (createRuntimeManager pattern).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

export function createUiControlServer({
  appName,
  appIdentifier,
  getWindow,
  getBrowserAutomationPolicy,
}) {
  let uiControlServer = null;
  let uiControlDiscoveryPath = null;
  const uiControlToken = randomBytes(32).toString("hex");

  function sendJsonResponse(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  }

  function readJsonRequestBody(request) {
    return new Promise((resolve, reject) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 128_000) {
          reject(new Error("Request body too large"));
          request.destroy();
        }
      });
      request.on("end", () => {
        if (!raw.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Request body must be JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  function authorizedUiControlRequest(request) {
    const auth = request.headers.authorization ?? "";
    return auth === `Bearer ${uiControlToken}`;
  }

  function jsonForJavaScript(value) {
    return JSON.stringify(JSON.stringify(value ?? {}));
  }

  async function evaluateOpenworkControl(expression) {
    const win = await getWindow();
    // Commands mutate renderer state directly and do not require the desktop
    // window to become active. Foreground activation must be an explicit
    // affordance, never an implicit side effect of remote control.
    return win.webContents.executeJavaScript(expression, true);
  }

  async function runOpenworkControlCommand(command, args = {}) {
    const argsJsonLiteral = jsonForJavaScript(args);
    if (command === "snapshot") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        control.setEnabled?.(true);
        return { ok: true, ...control.snapshot() };
      })()`);
    }
    if (command === "actions") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        control.setEnabled?.(true);
        return { ok: true, actions: control.listActions() };
      })()`);
    }
    if (command === "context") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        return { ok: true, context: control.context() };
      })()`);
    }
    if (command === "query" || command === "command") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        const input = JSON.parse(${argsJsonLiteral});
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        if (!input || typeof input.id !== "string" || !input.id.trim()) {
          return { ok: false, error: "Missing OpenWork affordance id." };
        }
        return control[${JSON.stringify(command)}](input);
      })()`);
    }
    if (command === "execute") {
      return evaluateOpenworkControl(`(async () => {
        const control = window.__openworkControl;
        const input = JSON.parse(${argsJsonLiteral});
        if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
        if (!input || typeof input.actionId !== "string" || !input.actionId.trim()) {
          return { ok: false, error: "Missing OpenWork actionId." };
        }
        control.setEnabled?.(true);
        return control.execute(input.actionId, input.args ?? {});
      })()`);
    }
    return { ok: false, error: `Unknown OpenWork control command: ${command}` };
  }

  async function start() {
    if (uiControlServer) return;
    uiControlServer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/health") {
          sendJsonResponse(response, 200, { ok: true, app: appName, version: 2 });
          return;
        }
        if (!authorizedUiControlRequest(request)) {
          sendJsonResponse(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/snapshot") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("snapshot"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/actions") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("actions"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/context") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("context"));
          return;
        }
        if (request.method === "GET" && url.pathname === "/browser/targets") {
          const policy = typeof getBrowserAutomationPolicy === "function"
            ? getBrowserAutomationPolicy()
            : null;
          sendJsonResponse(response, 200, {
            ok: true,
            browser_url:
              typeof policy?.browser_url === "string"
                ? policy.browser_url
                : null,
            target_ids: Array.isArray(policy?.target_ids)
              ? policy.target_ids.filter((value) => typeof value === "string")
              : [],
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/query") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("query", await readJsonRequestBody(request)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/command") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("command", await readJsonRequestBody(request)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/execute") {
          sendJsonResponse(response, 200, await runOpenworkControlCommand("execute", await readJsonRequestBody(request)));
          return;
        }
        sendJsonResponse(response, 404, { ok: false, error: "Not found" });
      } catch (error) {
        sendJsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    await new Promise((resolve, reject) => {
      uiControlServer.once("error", reject);
      uiControlServer.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    const address = uiControlServer.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Could not start OpenWork UI control bridge.");
    uiControlDiscoveryPath = path.join(app.getPath("userData"), "openwork-ui-control.json");
    const temporaryDiscoveryPath =
      `${uiControlDiscoveryPath}.${process.pid}.tmp`;
    await writeFile(
      temporaryDiscoveryPath,
      `${JSON.stringify({ version: 2, app: appName, identifier: appIdentifier, platform: process.platform, baseUrl: `http://127.0.0.1:${port}`, token: uiControlToken }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporaryDiscoveryPath, 0o600);
    await rename(temporaryDiscoveryPath, uiControlDiscoveryPath);
    await chmod(uiControlDiscoveryPath, 0o600);
    // Make the discovery path available to child processes (server → managed OpenCode → plugin).
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = uiControlDiscoveryPath;
  }

  async function stop() {
    if (uiControlDiscoveryPath) {
      await rm(uiControlDiscoveryPath, { force: true }).catch(() => undefined);
      uiControlDiscoveryPath = null;
    }
    if (!uiControlServer) return;
    await new Promise((resolve) => uiControlServer.close(() => resolve(undefined)));
    uiControlServer = null;
  }

  return { start, stop };
}
