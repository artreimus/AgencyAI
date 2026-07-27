import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import type { SessionCloudMcpMaintenanceState } from "../../connections/use-session-mcp-maintenance";

export type AccountStatusMenuProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  showConnectionStatus: boolean;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  loading?: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
  openWorkConnectState?: SessionCloudMcpMaintenanceState;
  showSettingsButton?: boolean;
  onOpenAccountSettings?: () => void;
  onSendFeedback?: () => void;
};
