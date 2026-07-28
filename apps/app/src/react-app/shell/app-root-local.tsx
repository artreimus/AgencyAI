/** @jsxImportSource react */
import { useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { evalRelaunchDesktopApp } from "@/app/lib/desktop";
import { getCompiledRendererProductProfile } from "@/app/lib/product-profile";
import { DevProfiler, DevProfilerOverlay } from "./dev-profiler";
import { useDesktopFontZoomBehavior } from "./font-zoom";
import { LoadingOverlay } from "./loading-overlay";
import { LocalAppMenuProvider } from "./local-app-menu";
import {
  LOCAL_CONTROL_ACTION_ID_SET,
} from "./local-renderer-policy";
import { LocalRouteControlActions } from "./local-route-control-actions";
import { OpenworkContextPublisher } from "./openwork-context-publisher";
import {
  OpenworkControlProvider,
  useControlAction,
  type OpenworkControlAction,
} from "./control/control-provider";
import { ReactRenderWatchdogOverlay } from "./react-render-watchdog-overlay";
import { SessionRoute } from "./session-route";
import { LocalSettingsRoute } from "./settings-route-local";
import { ShellConfigProvider, type ShellConfig } from "./shell-config";
import { LocalWelcomeRoute } from "./welcome-route-local";

const PRODUCT = getCompiledRendererProductProfile();
const LOCAL_SHELL_POLICY = Object.freeze({
  appName: PRODUCT.brand.name,
  statusBar: true,
  sidebar: true,
  docsButton: false,
  feedbackButton: false,
  cloudSignin: false,
  welcomePage: true,
  starterCards: true,
  modelPicker: true,
  browser: PRODUCT.features.browserAutomation,
  addWorkspace: true,
  notifications: true,
} satisfies ShellConfig);

function LocalEvalControlActions() {
  const relaunchAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.app.relaunch",
      label: "Relaunch app for eval",
      description: "Relaunch the local desktop app.",
      sideEffect: "mutation",
      execute: () => evalRelaunchDesktopApp(),
    };
  }, []);
  useControlAction(relaunchAction);
  return null;
}

function LocalRoutes() {
  return (
    <Routes>
      <Route path="/signin/*" element={<Navigate to="/session" replace />} />
      <Route path="/onboarding/*" element={<Navigate to="/session" replace />} />
      <Route
        path="/welcome"
        element={
          <DevProfiler id="LocalWelcomeRoute">
            <LocalWelcomeRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/session"
        element={
          <DevProfiler id="LocalSessionRoute">
            <SessionRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/session/:sessionId"
        element={
          <DevProfiler id="LocalSessionRoute">
            <SessionRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/workspace/:workspaceId/session"
        element={
          <DevProfiler id="LocalSessionRoute">
            <SessionRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/workspace/:workspaceId/session/:sessionId"
        element={
          <DevProfiler id="LocalSessionRoute">
            <SessionRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/workspace/:workspaceId/settings/*"
        element={
          <DevProfiler id="LocalSettingsRoute">
            <LocalSettingsRoute />
          </DevProfiler>
        }
      />
      <Route
        path="/settings/*"
        element={
          <DevProfiler id="LocalSettingsRoute">
            <LocalSettingsRoute />
          </DevProfiler>
        }
      />
      <Route path="/" element={<Navigate to="/session" replace />} />
      <Route path="*" element={<Navigate to="/session" replace />} />
    </Routes>
  );
}

export function LocalAppRoot() {
  useDesktopFontZoomBehavior();

  return (
    <>
      <DevProfiler id="LocalAppRoot">
        <ShellConfigProvider policy={LOCAL_SHELL_POLICY}>
          <LocalAppMenuProvider>
            <OpenworkControlProvider
              allowedActionIds={LOCAL_CONTROL_ACTION_ID_SET}
            >
              <LocalRouteControlActions />
              <OpenworkContextPublisher />
              <LocalEvalControlActions />
              <LocalRoutes />
            </OpenworkControlProvider>
          </LocalAppMenuProvider>
        </ShellConfigProvider>
        <LoadingOverlay />
      </DevProfiler>
      <DevProfilerOverlay />
      <ReactRenderWatchdogOverlay />
    </>
  );
}
