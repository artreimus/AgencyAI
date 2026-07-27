/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getCompiledRendererProductProfile } from "./app/lib/product-profile";
import { bootstrapTheme } from "./app/theme";
import { isDesktopRuntime } from "./app/utils";
import { initLocale } from "./i18n";
import { getReactQueryClient } from "./react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { setWebNotificationHandler } from "./react-app/shell/desktop-notifications";
import "./app/index.css";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const product = getCompiledRendererProductProfile();
root.dataset.productProfile = product.profile;

let Providers: React.ComponentType<{ children: React.ReactNode }>;
let Root: React.ComponentType;

if (product.features.openworkCloud) {
  const [
    { AppProviders },
    { AppRoot },
    { initializeDenBootstrapConfig },
    { getOpenWorkDeployment },
    { startDeepLinkBridge },
  ] = await Promise.all([
    import("./react-app/shell/providers"),
    import("./react-app/shell/app-root"),
    import("./app/lib/den"),
    import("./app/lib/openwork-deployment"),
    import("./react-app/shell/startup-deep-links"),
  ]);
  startDeepLinkBridge();
  await initializeDenBootstrapConfig();
  root.dataset.openworkDeployment = getOpenWorkDeployment();
  Providers = AppProviders;
  Root = AppRoot;
} else {
  const [{ LocalAppProviders }, { LocalAppRoot }] = await Promise.all([
    import("./react-app/shell/providers-local"),
    import("./react-app/shell/app-root-local"),
  ]);
  Providers = LocalAppProviders;
  Root = LocalAppRoot;
}

const platform = createDefaultPlatform();
setWebNotificationHandler(platform.notify);
const queryClient = getReactQueryClient();
const Router = isDesktopRuntime() ? HashRouter : BrowserRouter;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlatformProvider value={platform}>
          <Providers>
            <Router>
              <Root />
            </Router>
          </Providers>
        </PlatformProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
