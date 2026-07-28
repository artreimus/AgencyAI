export function configureFakeMediaForTests(app, enabled) {
  if (!enabled) return;
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}

function exactOrigin(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!url.protocol || !url.host || url.username || url.password) return null;
    return url.origin === "null"
      ? `${url.protocol}//${url.host}`
      : url.origin;
  } catch {
    return null;
  }
}

function requestsAudioOnly(permission, details) {
  if (permission === "audioCapture") return true;
  if (permission !== "media") return false;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  if (mediaType) return mediaType === "audio";
  return mediaTypes.includes("audio") && !mediaTypes.includes("video");
}

export function shouldAllowMainWindowPermission(input) {
  const {
    webContents,
    permission,
    origin,
    details = {},
    mainWindow,
    trustedRendererOrigin,
    allowMicrophone = false,
  } = input;
  if (
    !mainWindow ||
    typeof mainWindow.isDestroyed !== "function" ||
    mainWindow.isDestroyed() ||
    !webContents ||
    webContents !== mainWindow.webContents ||
    typeof webContents.isDestroyed !== "function" ||
    webContents.isDestroyed()
  ) {
    return false;
  }
  const trustedOrigin = exactOrigin(trustedRendererOrigin);
  const requestOrigin = exactOrigin(origin);
  const currentOrigin = exactOrigin(webContents.getURL?.());
  if (
    !trustedOrigin ||
    requestOrigin !== trustedOrigin ||
    currentOrigin !== trustedOrigin
  ) {
    return false;
  }
  return allowMicrophone && requestsAudioOnly(permission, details);
}

function denyEveryPermission(targetSession) {
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  targetSession.setPermissionCheckHandler(() => false);
}

export function installMediaPermissionHandlers(
  sessionModule,
  getMainWindow,
  {
    trustedRendererOrigin = null,
    allowMicrophone = false,
    browserPartition = "persist:openwork-browser",
  } = {},
) {
  sessionModule.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: details?.requestingUrl,
      details: details ?? {},
      mainWindow: getMainWindow(),
      trustedRendererOrigin,
      allowMicrophone,
    }));
  });
  sessionModule.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: requestingOrigin,
      details: details ?? {},
      mainWindow: getMainWindow(),
      trustedRendererOrigin,
      allowMicrophone,
    })
  ));

  if (browserPartition) {
    denyEveryPermission(sessionModule.fromPartition(browserPartition));
  }
}
