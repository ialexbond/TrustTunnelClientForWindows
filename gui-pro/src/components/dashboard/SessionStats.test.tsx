import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SessionStats } from "./SessionStats";

describe("SessionStats", () => {
  const defaultProps = {
    connectedSince: null,
    recoveryCount: 0,
    errorCount: 0,
    isConnected: false,
  };

  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders session card title", () => {
    render(<SessionStats {...defaultProps} />);
    expect(screen.getByText("Сессия")).toBeInTheDocument();
  });

  it("shows dash values when disconnected", () => {
    render(<SessionStats {...defaultProps} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(3);
  });

  it("shows uptime label", () => {
    render(<SessionStats {...defaultProps} />);
    expect(screen.getByText("Время работы")).toBeInTheDocument();
  });

  it("shows errors label", () => {
    render(<SessionStats {...defaultProps} />);
    expect(screen.getByText("Ошибки")).toBeInTheDocument();
  });

  it("shows recovery and error counts when connected", () => {
    render(
      <SessionStats
        connectedSince={new Date()}
        recoveryCount={3}
        errorCount={2}
        isConnected={true}
      />
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows uptime when connected with connectedSince", () => {
    const tenSecsAgo = new Date(Date.now() - 10_000);
    render(
      <SessionStats
        connectedSince={tenSecsAgo}
        recoveryCount={0}
        errorCount={0}
        isConnected={true}
      />
    );
    // Uptime should be something like 00:00:10
    expect(screen.getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
  });

  it("shows zero counts when connected with no errors", () => {
    render(
      <SessionStats
        connectedSince={new Date()}
        recoveryCount={0}
        errorCount={0}
        isConnected={true}
      />
    );
    const zeros = screen.getAllByText("0");
    expect(zeros.length).toBe(2);
  });
});
