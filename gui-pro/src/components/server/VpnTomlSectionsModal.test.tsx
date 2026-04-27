import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import {
  VpnTomlSectionsModal,
  sliceTomlForSection,
} from "./VpnTomlSectionsModal";

const SAMPLE_TOML = `# vpn.toml
listen_address = "0.0.0.0:443"
ipv6_available = true
log_level = "info"
auth_failure_status_code = 407

[listen_protocols.tls]
sni_required = true

[forward_protocol]
buffer_size_kb = 64

[metrics]
enable = true
listen = "127.0.0.1:9090"

[icmp]
enable = true

# Top-level timeout
tls_handshake_timeout_secs = 10
client_listener_timeout_secs = 600
`;

beforeEach(() => {
  i18n.changeLanguage("ru");
  vi.clearAllMocks();
});

describe("sliceTomlForSection (pure helper)", () => {
  it("slices main = top-level keys before any [header]", () => {
    const slice = sliceTomlForSection(SAMPLE_TOML, "main");
    expect(slice).toContain("listen_address");
    expect(slice).toContain("ipv6_available");
    expect(slice).toContain("log_level");
    expect(slice).not.toContain("[listen_protocols");
    expect(slice).not.toContain("sni_required");
    expect(slice).not.toContain("[metrics]");
  });

  it("slices protocols = listen_protocols + forward_protocol + reverse_proxy headers", () => {
    const slice = sliceTomlForSection(SAMPLE_TOML, "protocols");
    expect(slice).toContain("[listen_protocols.tls]");
    expect(slice).toContain("sni_required");
    expect(slice).toContain("[forward_protocol]");
    expect(slice).toContain("buffer_size_kb");
    expect(slice).not.toContain("[metrics]");
  });

  it("slices timeouts = all *_timeout_secs lines", () => {
    const slice = sliceTomlForSection(SAMPLE_TOML, "timeouts");
    expect(slice).toContain("tls_handshake_timeout_secs");
    expect(slice).toContain("client_listener_timeout_secs");
    expect(slice).not.toContain("listen_address");
  });

  it("slices metrics", () => {
    const slice = sliceTomlForSection(SAMPLE_TOML, "metrics");
    expect(slice).toContain("[metrics]");
    expect(slice).toContain("enable = true");
    expect(slice).toContain('listen = "127.0.0.1:9090"');
    expect(slice).not.toContain("[icmp]");
  });

  it("slices icmp", () => {
    const slice = sliceTomlForSection(SAMPLE_TOML, "icmp");
    expect(slice).toContain("[icmp]");
  });

  it("returns empty string for no content", () => {
    expect(sliceTomlForSection("", "main")).toBe("");
  });
});

describe("VpnTomlSectionsModal", () => {
  it("renders title per section — main", () => {
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="main"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByText("Основные настройки")).toBeInTheDocument();
  });

  it("renders title per section — protocols", () => {
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="protocols"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByText("Протоколы")).toBeInTheDocument();
  });

  it("renders title per section — timeouts / metrics / icmp", () => {
    const { rerender } = render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="timeouts"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByText("Таймауты")).toBeInTheDocument();
    rerender(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="metrics"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByText("Метрики")).toBeInTheDocument();
    rerender(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="icmp"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByText("ICMP")).toBeInTheDocument();
  });

  it("renders sliced TOML content for selected section", () => {
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="metrics"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    const pre = screen.getByTestId("section-toml-slice");
    expect(pre.textContent).toContain("[metrics]");
    expect(pre.textContent).not.toContain("listen_address");
  });

  it("renders Phase 15 stub notice", () => {
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="main"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("Close button fires onClose", () => {
    const onClose = vi.fn();
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={onClose}
        section="main"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    fireEvent.click(screen.getByText("Закрыть"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders empty fallback when section has no content", () => {
    render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="metrics"
        vpnTomlContent=""
      />,
    );
    expect(screen.getByText(/нет настроек/i)).toBeInTheDocument();
  });

  it("supports null section without throwing (state cleanup phase)", () => {
    const { rerender } = render(
      <VpnTomlSectionsModal
        isOpen
        onClose={vi.fn()}
        section="main"
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
    // Закрывается с section=null — компонент не должен падать
    rerender(
      <VpnTomlSectionsModal
        isOpen={false}
        onClose={vi.fn()}
        section={null}
        vpnTomlContent={SAMPLE_TOML}
      />,
    );
  });
});
