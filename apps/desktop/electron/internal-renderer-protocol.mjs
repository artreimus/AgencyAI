import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const INTERNAL_RENDERER_HOST = "renderer";

export const PRODUCTION_RENDERER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob:",
  "object-src blob:",
].join("; ");

function responseHeaders(headers = undefined) {
  const result = new Headers(headers);
  result.set("Content-Security-Policy", PRODUCTION_RENDERER_CSP);
  result.set("Cross-Origin-Opener-Policy", "same-origin");
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Content-Type-Options", "nosniff");
  return result;
}

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: responseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
}

export function normalizeInternalRendererScheme(value) {
  const scheme = typeof value === "string"
    ? value.trim().replace(/:$/, "").toLowerCase()
    : "";
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    throw new Error("Internal renderer scheme is invalid");
  }
  return scheme;
}

export function internalRendererOrigin(scheme) {
  return `${normalizeInternalRendererScheme(scheme)}://${INTERNAL_RENDERER_HOST}`;
}

export function registerInternalRendererScheme(protocolModule, scheme) {
  const normalizedScheme = normalizeInternalRendererScheme(scheme);
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: normalizedScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  return internalRendererOrigin(normalizedScheme);
}

export function createInternalRendererProtocolHandler({
  rendererRoot,
  netFetch,
  scheme,
}) {
  const normalizedScheme = normalizeInternalRendererScheme(scheme);
  const configuredRoot = path.resolve(rendererRoot);
  if (typeof netFetch !== "function") {
    throw new Error("Internal renderer protocol requires Electron net.fetch");
  }

  return async function handleInternalRendererRequest(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "Method not allowed");
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return errorResponse(400, "Invalid renderer URL");
    }
    if (
      requestUrl.protocol !== `${normalizedScheme}:` ||
      requestUrl.hostname !== INTERNAL_RENDERER_HOST ||
      requestUrl.port ||
      requestUrl.username ||
      requestUrl.password
    ) {
      return errorResponse(403, "Renderer origin denied");
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return errorResponse(400, "Invalid renderer path");
    }
    if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
      return errorResponse(400, "Invalid renderer path");
    }

    const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
    let candidate = path.resolve(configuredRoot, relativePath);
    if (!isPathInside(configuredRoot, candidate)) {
      return errorResponse(403, "Renderer path denied");
    }

    try {
      const initialStats = await lstat(candidate);
      if (initialStats.isDirectory()) {
        candidate = path.join(candidate, "index.html");
      }
      const candidateStats = await lstat(candidate);
      if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
        return errorResponse(404, "Renderer asset not found");
      }
      const [canonicalRoot, canonicalCandidate] = await Promise.all([
        realpath(configuredRoot),
        realpath(candidate),
      ]);
      const expectedCanonicalCandidate = path.resolve(
        canonicalRoot,
        path.relative(configuredRoot, candidate),
      );
      if (
        canonicalCandidate !== expectedCanonicalCandidate ||
        !isPathInside(canonicalRoot, canonicalCandidate)
      ) {
        return errorResponse(403, "Renderer path denied");
      }
    } catch {
      return errorResponse(404, "Renderer asset not found");
    }

    const source = await netFetch(pathToFileURL(candidate).toString());
    if (!source.ok) {
      return errorResponse(source.status || 404, "Renderer asset not found");
    }
    const headers = responseHeaders(source.headers);
    headers.set("Cache-Control", "no-store");
    const response = new Response(request.method === "HEAD" ? null : source.body, {
      status: source.status,
      statusText: source.statusText,
      headers,
    });
    return response;
  };
}

export function installInternalRendererProtocol({
  protocolModule,
  rendererRoot,
  netFetch,
  scheme,
}) {
  const normalizedScheme = normalizeInternalRendererScheme(scheme);
  const handler = createInternalRendererProtocolHandler({
    rendererRoot,
    netFetch,
    scheme: normalizedScheme,
  });
  protocolModule.handle(normalizedScheme, handler);
  return {
    origin: internalRendererOrigin(normalizedScheme),
    handler,
  };
}
