function requiredIdentifier(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function serializedOrigin(url) {
  return url.origin === "null"
    ? `${url.protocol}//${url.host}`
    : url.origin;
}

export function isTrustedMainWindowNavigation({
  targetUrl,
  currentUrl,
  trustedRendererOrigin,
}) {
  try {
    const target = new URL(targetUrl);
    const trusted = new URL(`${trustedRendererOrigin}/`);
    if (serializedOrigin(target) !== serializedOrigin(trusted)) return false;

    const current = typeof currentUrl === "string" ? currentUrl.trim() : "";
    if (current === "" || current === "about:blank") {
      // A newly constructed BrowserWindow has not committed a document yet.
      // Permit only its bootstrap transition into the trusted app origin.
      return true;
    }
    return serializedOrigin(new URL(current)) === serializedOrigin(trusted);
  } catch {
    return false;
  }
}

/**
 * Track the CDP targets created through AgencyAI's authenticated
 * browser.open_url affordance. Electron's debug endpoint also exposes the main
 * app renderer, so browser tools must never infer authorization from the
 * endpoint alone.
 */
export function createBrowserTargetPolicy({ getBrowserUrl }) {
  if (typeof getBrowserUrl !== "function") {
    throw new TypeError("getBrowserUrl must be a function");
  }
  const targetByTab = new Map();

  function authorize(tabId, targetId) {
    targetByTab.set(
      requiredIdentifier(tabId, "tabId"),
      requiredIdentifier(targetId, "targetId"),
    );
  }

  function revoke(tabId) {
    const normalized = typeof tabId === "string" ? tabId.trim() : "";
    if (normalized) targetByTab.delete(normalized);
  }

  function clear() {
    targetByTab.clear();
  }

  function snapshot() {
    let browserUrl = null;
    try {
      browserUrl = getBrowserUrl();
    } catch {
      // The feature can be compiled in while no debug port is available.
    }
    return Object.freeze({
      browser_url:
        typeof browserUrl === "string" && browserUrl.trim()
          ? browserUrl.trim()
          : null,
      target_ids: Object.freeze([...new Set(targetByTab.values())]),
    });
  }

  return Object.freeze({
    authorize,
    clear,
    revoke,
    snapshot,
  });
}
