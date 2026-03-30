import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { NetworkInfo } from "./NetworkInfo";
import type { ClientConfig } from "../settings/useSettingsState";

describe("NetworkInfo", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders no config message when clientConfig is null", () => {
    render(<NetworkInfo clientConfig={null} />);
    expect(screen.getByText("Конфигурация не загружена")).toBeInTheDocument();
  });

  it("renders network card title", () => {
    render(<NetworkInfo clientConfig={null} />);
    expect(screen.getByText("Сеть")).toBeInTheDocument();
  });

  it("displays MTU value from config", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: true, has_ipv6: false },
      listener: { tun: { mtu_size: 1400 } },
      killswitch_enabled: true,
      post_quantum_group_enabled: false,
      dns_upstreams: [],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.getByText("1400")).toBeInTheDocument();
  });

  it("displays kill switch status ON", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: false, has_ipv6: false },
      listener: { tun: { mtu_size: 1280 } },
      killswitch_enabled: true,
      post_quantum_group_enabled: false,
      dns_upstreams: [],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.getByText("Kill Switch:")).toBeInTheDocument();
    // At least one ON badge
    expect(screen.getAllByText("ON").length).toBeGreaterThanOrEqual(1);
  });

  it("displays anti-DPI status OFF", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: false, has_ipv6: false },
      listener: { tun: { mtu_size: 1280 } },
      killswitch_enabled: false,
      post_quantum_group_enabled: false,
      dns_upstreams: [],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.getByText("Anti-DPI:")).toBeInTheDocument();
    expect(screen.getAllByText("OFF").length).toBeGreaterThanOrEqual(1);
  });

  it("displays DNS server count when dns_upstreams present", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: false, has_ipv6: false },
      listener: { tun: { mtu_size: 1280 } },
      killswitch_enabled: false,
      post_quantum_group_enabled: false,
      dns_upstreams: ["1.1.1.1", "8.8.8.8"],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.getByText("2 servers")).toBeInTheDocument();
  });

  it("displays 1 server for single DNS", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: false, has_ipv6: false },
      listener: { tun: { mtu_size: 1280 } },
      killswitch_enabled: false,
      post_quantum_group_enabled: false,
      dns_upstreams: ["1.1.1.1"],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.getByText("1 server")).toBeInTheDocument();
  });

  it("does not display DNS row when no dns_upstreams", () => {
    const config = {
      endpoint: { upstream_protocol: "quic", anti_dpi: false, has_ipv6: false },
      listener: { tun: { mtu_size: 1280 } },
      killswitch_enabled: false,
      post_quantum_group_enabled: false,
      dns_upstreams: [],
    } as unknown as ClientConfig;

    render(<NetworkInfo clientConfig={config} />);
    expect(screen.queryByText("DNS:")).not.toBeInTheDocument();
  });
});
