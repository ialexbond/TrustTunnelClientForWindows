import type { AppTab } from "../../shared/types";

/**
 * Stable id helpers for cross-referencing tabs ↔ panels
 * (aria-controls / aria-labelledby). App.tsx renders panels with
 * id=`tabpanel-${tab.id}`; TabNavigation buttons use id=`tab-${tab.id}`.
 * Kept in a separate file from TabNavigation.tsx so fast-refresh works
 * (Vite/react-refresh requires component-only modules).
 */
export const getTabPanelId = (tabId: AppTab) => `tabpanel-${tabId}`;
export const getTabButtonId = (tabId: AppTab) => `tab-${tabId}`;
