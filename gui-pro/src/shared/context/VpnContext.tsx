import { createContext, useContext } from "react";
import type { VpnStatus } from "../types";

export interface VpnContextValue {
  status: VpnStatus;
  connectedSince: Date | null;
  configPath: string;
  vpnMode: string;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onReconnect: () => Promise<void>;
}

const VpnContext = createContext<VpnContextValue | null>(null);

export const VpnProvider = VpnContext.Provider;

export function useVpn(): VpnContextValue {
  const ctx = useContext(VpnContext);
  if (!ctx) throw new Error("useVpn must be used within VpnProvider");
  return ctx;
}
