/* eslint-disable react-refresh/only-export-components */
import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { SnackBarProvider } from "../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../shared/ui/ConfirmDialogProvider";

function AllProviders({ children }: { children: React.ReactNode }) {
  return (
    <SnackBarProvider>
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
    </SnackBarProvider>
  );
}

/** render() pre-wrapped with SnackBarProvider + ConfirmDialogProvider */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

/** wrapper for renderHook() */
export const hookWrapper = ({ children }: { children: React.ReactNode }) => (
  <SnackBarProvider>
    <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
  </SnackBarProvider>
);
