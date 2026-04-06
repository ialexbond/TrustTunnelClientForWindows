import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { SnackBarProvider } from "../shared/ui/SnackBarContext";

function AllProviders({ children }: { children: React.ReactNode }) {
  return <SnackBarProvider>{children}</SnackBarProvider>;
}

/** render() pre-wrapped with SnackBarProvider */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

/** wrapper for renderHook() */
export const hookWrapper = ({ children }: { children: React.ReactNode }) => (
  <SnackBarProvider>{children}</SnackBarProvider>
);
