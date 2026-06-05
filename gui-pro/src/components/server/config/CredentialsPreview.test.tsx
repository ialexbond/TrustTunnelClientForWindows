import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { CredentialsPreview } from "./CredentialsPreview";

/**
 * Phase 3 safety-net (Stream 3) — first-ever characterization of CredentialsPreview.
 *
 * CredentialsPreview had ZERO tests before this net and is the credential
 * surface flagged by D-29 (memory/security-posture.md): it receives the parsed
 * credentials.toml object — which contains REAL passwords in memory — and must
 * render every password as a fixed mask (••••••••) and NEVER let the real value
 * reach the DOM.
 *
 * The probe secret `"TOPSECRET123"` matches the shared `makeBundle()`
 * credentialsToml literal (gui-pro/src/test/fixtures/config.ts). Per D-08 the
 * secret VALUE is never asserted-on positively — only its ABSENCE is checked.
 *
 * NOTE: this component does NOT call useActivityLog — it has no logging path,
 * so the D-29 surface here is purely the rendered DOM. (The activity-log half of
 * the D-29 invariant is covered by the spies in ConfigurationTab.test.tsx:147
 * and useTomlConfigState.test.ts:66.)
 *
 * Behavior/aria only (D-04): role + `i18n.t(...)` queries, no class selectors /
 * snapshots. Pins CURRENT behavior against UNCHANGED production code (D-06).
 */
const PROBE_SECRET = "TOPSECRET123";

describe("CredentialsPreview (Phase 3 characterization + D-29)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("renders the read-only region with the readonly notice", () => {
    render(<CredentialsPreview parsed={null} onNavigateToUsers={vi.fn()} />);
    const region = screen.getByRole("region", {
      name: i18n.t("server.config.credentials_readonly_notice"),
    });
    expect(region).toBeInTheDocument();
  });

  it("shows the empty-credentials body when there are no clients", () => {
    render(<CredentialsPreview parsed={null} onNavigateToUsers={vi.fn()} />);
    expect(
      screen.getByText(i18n.t("server.config.empty_credentials_body")),
    ).toBeInTheDocument();
  });

  it("renders one masked entry per client (username shown, password masked)", () => {
    render(
      <CredentialsPreview
        parsed={{
          client: [
            { username: "alice", password: PROBE_SECRET },
            { username: "bob", password: PROBE_SECRET },
          ],
        }}
        onNavigateToUsers={vi.fn()}
      />,
    );
    // Usernames ARE shown (not secret).
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    // Two masked password placeholders — one per entry.
    const masks = screen.getAllByText("••••••••");
    expect(masks).toHaveLength(2);
  });

  it("D-29: the real password never reaches the DOM (only the mask renders)", () => {
    const { container } = render(
      <CredentialsPreview
        parsed={{
          client: [{ username: "alice", password: PROBE_SECRET }],
        }}
        onNavigateToUsers={vi.fn()}
      />,
    );
    // ABSENCE assertion only — the secret value is never printed (D-08).
    expect(screen.queryByText(PROBE_SECRET)).not.toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain(PROBE_SECRET);
    // The mask is what the user sees instead.
    expect(screen.getByText("••••••••")).toBeInTheDocument();
  });

  it("edit-in-Users button fires onNavigateToUsers", () => {
    const onNavigateToUsers = vi.fn();
    render(
      <CredentialsPreview
        parsed={{ client: [{ username: "alice", password: PROBE_SECRET }] }}
        onNavigateToUsers={onNavigateToUsers}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(i18n.t("server.config.edit_in_users")),
      }),
    );
    expect(onNavigateToUsers).toHaveBeenCalledTimes(1);
  });
});
