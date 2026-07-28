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
import { loadProductApp } from "virtual:product-app-entry";
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

const { Providers, Root } = await loadProductApp(root);

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
