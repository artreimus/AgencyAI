/** @jsxImportSource react */
import { useMemo, useRef } from "react";
import { MoreHorizontal, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getCompiledRendererProductProfile } from "@/app/lib/product-profile";
import {
  useControlAction,
  type OpenworkControlAction,
} from "@/react-app/shell/control/control-provider";
import type { AccountStatusMenuProps } from "./account-status-types";

const PRODUCT = getCompiledRendererProductProfile();

function localRuntimeStatus(props: AccountStatusMenuProps) {
  if (props.reloadBusy) {
    return { state: "loading", label: "Reloading local runtime" };
  }
  if (props.reloadError) {
    return { state: "disconnected", label: "Local runtime needs attention" };
  }
  if (props.loading) {
    return { state: "loading", label: "Preparing local workspace" };
  }
  if (props.clientConnected) {
    return { state: "connected", label: "Ready for local tasks" };
  }
  return { state: "disconnected", label: "Local runtime disconnected" };
}

export function LocalAccountStatusMenu(props: AccountStatusMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const runtime = localRuntimeStatus(props);
  const openSettings = props.onOpenAccountSettings;
  const settingsAction = useMemo<OpenworkControlAction>(() => ({
    id: "status.settings.open",
    label: "Open local settings",
    description: "Open AgencyAI settings from the local runtime menu.",
    sideEffect: "navigation",
    disabled: props.showSettingsButton === false || !openSettings,
    targetRef: triggerRef,
    execute: () => openSettings?.(),
  }), [openSettings, props.showSettingsButton]);
  useControlAction(settingsAction);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-testid="account-status-menu"
            data-runtime-state={runtime.state}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
            aria-label={`${PRODUCT.brand.name} local runtime and settings`}
            title={runtime.label}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              AI
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-sidebar-foreground">
                {PRODUCT.brand.name}
              </span>
              <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">
                {runtime.label}
              </span>
            </span>
            <MoreHorizontal size={14} className="shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent side="top" align="start" className="w-72">
        {props.showConnectionStatus ? (
          <div className="mx-1 mb-1 rounded-lg bg-muted/50 p-2">
            <div className="text-[11.5px] font-medium text-foreground">
              {runtime.label}
            </div>
            <div className="text-[10.5px] leading-tight text-muted-foreground">
              {props.providerConnectedIds.length} providers · {props.mcpConnectedCount} MCP servers
            </div>
            {props.reloadError ? (
              <div className="mt-1 text-[10.5px] text-destructive">
                {props.reloadError}
              </div>
            ) : null}
          </div>
        ) : null}
        {props.showSettingsButton !== false ? (
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            Settings
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
