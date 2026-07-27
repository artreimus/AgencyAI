/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ServerProvider } from "@/react-app/kernel/server-provider";
import { ArchitectureMismatchGate } from "./architecture-mismatch-gate";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { resolveOpenworkConnection } from "./openwork-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";

export function LocalAppProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    startDebugLogger({
      serverUrl: async () =>
        (await resolveOpenworkConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  return (
    <BootStateProvider>
      <ServerProvider
        defaultUrl="http://127.0.0.1:4096"
        allowStoredServers={false}
        persistServers={false}
      >
        <ArchitectureMismatchGate>
          <DesktopRuntimeBoot />
          <LocalProvider>
            <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
            <Toaster />
          </LocalProvider>
        </ArchitectureMismatchGate>
      </ServerProvider>
    </BootStateProvider>
  );
}
