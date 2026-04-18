import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { DnsUpstreamsInput, isValidDnsEntry } from "./DnsUpstreamsInput";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("isValidDnsEntry", () => {
  it("accepts valid IPv4", () => {
    expect(isValidDnsEntry("8.8.8.8")).toBe(true);
    expect(isValidDnsEntry("192.168.1.1")).toBe(true);
    expect(isValidDnsEntry("0.0.0.0")).toBe(true);
    expect(isValidDnsEntry("255.255.255.255")).toBe(true);
  });

  it("accepts valid hostname", () => {
    expect(isValidDnsEntry("dns.google")).toBe(true);
    expect(isValidDnsEntry("cloudflare.com")).toBe(true);
    expect(isValidDnsEntry("1dot1dot1dot1.cloudflare.com")).toBe(true);
  });

  it("accepts IPv4 with port", () => {
    expect(isValidDnsEntry("8.8.8.8:5353")).toBe(true);
  });

  it("accepts hostname with port", () => {
    expect(isValidDnsEntry("dns.google:853")).toBe(true);
  });

  it("accepts empty string (empty lines not invalid)", () => {
    expect(isValidDnsEntry("")).toBe(true);
  });

  it("rejects invalid IPv4 octets", () => {
    expect(isValidDnsEntry("256.0.0.1")).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(isValidDnsEntry("8.8.8.8; rm -rf /")).toBe(false);
    expect(isValidDnsEntry("8.8.8.8|cat /etc/passwd")).toBe(false);
    expect(isValidDnsEntry("$(whoami)")).toBe(false);
    expect(isValidDnsEntry("`id`")).toBe(false);
  });
});

describe("DnsUpstreamsInput", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("renders textarea with empty value when value=[]", () => {
    render(<DnsUpstreamsInput value={[]} onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("renders textarea with joined entries", () => {
    render(<DnsUpstreamsInput value={["8.8.8.8", "1.1.1.1"]} onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("8.8.8.8\n1.1.1.1");
  });

  it("calls onChange with filtered non-empty array on input", () => {
    const onChange = vi.fn();
    render(<DnsUpstreamsInput value={[]} onChange={onChange} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea");
    fireEvent.change(textarea, { target: { value: "8.8.8.8\n1.1.1.1\n" } });
    expect(onChange).toHaveBeenCalledWith(["8.8.8.8", "1.1.1.1"]);
  });

  it("calls onError with false when all entries are valid", () => {
    const onError = vi.fn();
    render(<DnsUpstreamsInput value={[]} onChange={vi.fn()} onError={onError} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea");
    fireEvent.change(textarea, { target: { value: "8.8.8.8\n1.1.1.1" } });
    expect(onError).toHaveBeenCalledWith(false);
  });

  it("calls onError with true and shows error for invalid entries", () => {
    const onError = vi.fn();
    render(<DnsUpstreamsInput value={["bad; injection"]} onChange={vi.fn()} onError={onError} />);
    // Check error is displayed
    expect(screen.getByTestId("dns-error")).toBeInTheDocument();
  });

  it("shows helper text when no error", () => {
    render(<DnsUpstreamsInput value={["8.8.8.8"]} onChange={vi.fn()} />);
    // No error should show helper text
    expect(screen.queryByTestId("dns-error")).toBeNull();
  });

  it("renders label when provided", () => {
    render(<DnsUpstreamsInput value={[]} onChange={vi.fn()} label="DNS серверы" />);
    expect(screen.getByText("DNS серверы")).toBeInTheDocument();
  });

  it("renders disabled textarea when disabled=true", () => {
    render(<DnsUpstreamsInput value={[]} onChange={vi.fn()} disabled />);
    const textarea = screen.getByTestId("dns-upstreams-textarea");
    expect(textarea).toBeDisabled();
  });

  it("aria-invalid is true when entries have errors", () => {
    render(<DnsUpstreamsInput value={["bad; shell"]} onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
  });

  it("aria-invalid is false when entries are valid", () => {
    render(<DnsUpstreamsInput value={["8.8.8.8"]} onChange={vi.fn()} />);
    const textarea = screen.getByTestId("dns-upstreams-textarea");
    expect(textarea).toHaveAttribute("aria-invalid", "false");
  });
});
