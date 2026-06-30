import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { open as openPath } from "@tauri-apps/plugin-shell";
import { HelpCircle, FolderOpen } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { Toggle } from "../../shared/ui/Toggle";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { Tooltip } from "../../shared/ui/Tooltip";
import { NumberInput } from "../../shared/ui/NumberInput";
import { DnsUpstreamsInput } from "../server/DnsUpstreamsInput";
import { useSettingsState } from "../settings/useSettingsState";
import { validateListenAddress } from "../../shared/utils/validators";
import type { VpnStatus, VpnConfig } from "../../shared/types";

/**
 * `ConfigEditView` (production, Phase 11 Plan 11-06) — the per-config settings modal.
 *
 * It is the real component behind the «Изменить» overflow action on a `ConfigCard`. It
 * reuses the existing `useSettingsState` hook SCOPED to the SELECTED config's `.toml`
 * path (the hook already reads/writes `read_client_config`/`save_client_config` by
 * `configPath`) and folds the four inline settings sections
 * (Connection/Tunnel/Security/Network) into ONE flat field list — no accordion, no
 * «Дополнительно» disclosure (the design retired the disclosure, connection.md
 * §ConfigEditView).
 *
 * Composition (top→bottom, mirrors the story-tier `ConfigEditView.stories.tsx` and
 * connection.md):
 *   - header: «Настройки конфигурации» h2 + config name + active/inactive flag + corner ×
 *   - read-only credentials (server address / login / MASKED password — never the secret, D-29)
 *   - Protocol segment (HTTP/2 | HTTP/3)
 *   - Mode segment (TUN → MTU · SOCKS5 → address/login/password)
 *   - Kill Switch / Anti-DPI / Post-Quantum / IPv6 toggles (flat, one benefit line + «?» each)
 *   - DnsUpstreamsInput
 *   - read-only config file path + «Открыть папку»
 *   - footer: Отмена / save
 *
 * Save label derives from `isActiveConfig` (F26), NOT the live save mode: active config →
 * «Сохранить и переподключить» (reuses the manual-reconnect path); inactive → «Сохранить».
 *
 * States: validation-error (bad MTU → inline, save disabled), load-error (ErrorBanner
 * instead of the form + a single «Закрыть», NO retry — re-reading a corrupt file is
 * pointless), first-connect-locked (save disabled while the first handshake runs), saving
 * (spinner on the button, close/save blocked).
 *
 * D-29 invariant: the password field is ALWAYS a masked placeholder, NEVER the real value;
 * the field is `disabled` (server data, not editable here). No log/sanitize sink is ever
 * called with the password — the hook never logs it and this component never reads it.
 */

// A fixed masked placeholder shown for the read-only config password. NEVER the real
// secret (D-29 / T-10). The eye reveal is intentionally NOT offered here because the field
// is read-only and showing the real value would be a needless secret-exposure surface; the
// dots communicate «a password is set» without ever putting the value in the DOM.
const MASKED_PASSWORD_PLACEHOLDER = "••••••••••";

const MTU_MIN = 576;
const MTU_MAX = 9000;

export interface ConfigEditViewProps {
  /** Open/close — keep the modal MOUNTED across close so its exit animation plays. */
  isOpen: boolean;
  onClose: () => void;
  /** The selected config's `.toml` path on disk — `useSettingsState` reads/writes it. */
  configPath: string;
  /** Display name of the config (header) + active/inactive pill. */
  configName: string;
  /** F26: drives the save LABEL («Сохранить и переподключить» vs «Сохранить») — derived
   *  from whether THIS is the active config, not from the live save mode. */
  isActiveConfig: boolean;
  /** The live VPN status (only meaningful when isActiveConfig). Used to gate the
   *  first-connect-lock and to decide whether a save reconnects. */
  status: VpnStatus;
  /** Reconnect the active tunnel after a save (the manual-reconnect path). No-op for an
   *  inactive config. */
  onReconnect: () => Promise<void>;
  /** Called after a successful save so the caller can re-summarise the card / refresh the
   *  manifest entry (name/host may have changed). */
  onConfigChange?: (config: VpnConfig) => void;
}

/** «?» help on a label — extra detail on hover (HelpCircle in a Tooltip), the canonical
 *  pattern reused from the settings sections / the story. */
function HelpHint({ text }: { text: string }) {
  return (
    <Tooltip text={text} maxWidth={320}>
      <HelpCircle
        className="w-3 h-3 cursor-help"
        style={{ color: "var(--color-text-muted)" }}
        aria-hidden="true"
      />
    </Tooltip>
  );
}

/** A labelled field: label + «?» on one line, the control below. No muted helper line under
 *  the field — the «?» carries the explanation (connection.md flat-list rule). */
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-sm font-medium text-[var(--color-text-secondary)]">{label}</span>
        {help && <HelpHint text={help} />}
      </div>
      {children}
    </div>
  );
}

/** A two-option segmented control (the protocol / listener-mode picker). */
function Segmented({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <Button
          key={o.id}
          variant={value === o.id ? "primary" : "secondary"}
          size="sm"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export function ConfigEditView({
  isOpen,
  onClose,
  configPath,
  configName,
  isActiveConfig,
  status,
  onReconnect,
  onConfigChange,
}: ConfigEditViewProps) {
  const { t } = useTranslation();

  // Scope the existing settings hook to the SELECTED config. The hook already takes
  // configPath and reads/writes the per-config .toml via read/save_client_config — no new
  // backend plumbing needed. onConfigChange routes back to the caller so the card
  // re-summarises after a save. onReconnect is the active-config reconnect path. The other
  // app-level callbacks (onSwitchToSetup/onClearConfig) are no-ops in this surface — the
  // config is deleted via the card's delete flow, not here.
  const state = useSettingsState({
    configPath,
    status,
    onReconnect,
    onConfigChange: onConfigChange ?? (() => {}),
    onSwitchToSetup: () => {},
    onClearConfig: () => {},
  });

  const { config, saving, dirty, handleSave, loadError } = state;

  const [dnsError, setDnsError] = useState(false);
  const [mtuError, setMtuError] = useState(false);

  // Derived per-config field values (read straight off the hook's `config`, the parsed
  // .toml). The updateField path mutates the same nested shape the settings sections use.
  const protocol = config?.endpoint?.upstream_protocol || "http2";
  const listenerMode = config?.listener?.socks ? "socks" : "tun";
  const mtu = String(config?.listener?.tun?.mtu_size ?? 1280);
  // WR-07: read the RAW stored SOCKS address (may be "") so the user can clear the field to
  // re-type it — the old `|| "127.0.0.1:1080"` snapped an emptied field back to the default
  // mid-edit, which made it impossible to clear. The default is only used as a placeholder now.
  const socksAddrRaw =
    typeof config?.listener?.socks?.address === "string"
      ? (config.listener.socks.address as string)
      : "";
  const socksAddr = socksAddrRaw;
  const socksUser = config?.listener?.socks?.username || "";
  const socksPass = config?.listener?.socks?.password || "";
  const killSwitch = Boolean(config?.killswitch_enabled);
  const antiDpi = Boolean(config?.endpoint?.anti_dpi);
  const postQuantum = Boolean(config?.post_quantum_group_enabled);
  const ipv6 = Boolean(config?.endpoint?.has_ipv6);
  const dns = config?.endpoint?.dns_upstreams || [];

  const host = config?.endpoint?.hostname || "";
  const user = config?.endpoint?.username || "";

  // «Имя конфига» — the config's TITLE on the «Подключение» card (the same field set when
  // adding/editing a user). Stored as `endpoint.name` in the .toml (where real server configs
  // carry it); empty → the card falls back to the username. This is the ONLY place the ACTIVE
  // config's title is edited (the lead card is read-only). Persists via the normal save:
  // save_client_config re-serializes the whole config, so endpoint.name round-trips. Empty
  // input removes the key (→ username fallback).
  const displayName =
    typeof config?.endpoint?.name === "string" ? (config.endpoint.name as string) : "";
  const nameTooLong = [...displayName].length > 64; // count CHARACTERS (multi-byte fairness)
  const nameHasControl = Array.from(displayName).some((c) => { const code = c.codePointAt(0) ?? 0; return code <= 0x1f || code === 0x7f; });
  const nameInvalid = nameTooLong || nameHasControl;
  const nameErrorMsg = nameTooLong
    ? t("connection.editView.name_too_long")
    : nameHasControl
      ? t("connection.editView.name_bad_chars")
      : null;

  // WR-07: validate the SOCKS address (host + port range) so an invalid value participates in
  // saveDisabled instead of being saved verbatim and failing opaquely at the sidecar. Only the
  // SOCKS listener mode has this field — in TUN mode there is no SOCKS address to validate.
  // validateListenAddress returns an i18n KEY ("" = valid); we surface the localized message
  // inline (same pattern as MTU/DNS/name errors).
  const socksErrorKey = listenerMode === "socks" ? validateListenAddress(socksAddrRaw) : "";
  const socksError = socksErrorKey !== "";
  const socksErrorMsg = socksError ? t(socksErrorKey) : null;

  // F26: the save LABEL comes from isActiveConfig, NOT the live save mode.
  const saveLabel = isActiveConfig
    ? t("connection.editView.save_and_reconnect")
    : t("connection.editView.save");

  // first-connect-locked: while the FIRST handshake of the active config runs the save is
  // blocked (you cannot change settings mid-handshake). «connecting» on the active config.
  const firstConnectLocked = isActiveConfig && status === "connecting";

  // Save is disabled when: nothing changed, a field is invalid (MTU/DNS/name/SOCKS address —
  // WR-07), the first-connect lock is on, or a save is already in flight.
  const saveDisabled =
    !dirty || mtuError || dnsError || nameInvalid || socksError || firstConnectLocked || saving;

  const handleSaveClick = async () => {
    // Save the file WITHOUT awaiting a reconnect inside, so on success we can close the modal
    // IMMEDIATELY (+ the SnackBar confirms the save). For the active config the reconnect then
    // runs in the BACKGROUND — the modal no longer hangs open through the whole
    // disconnect→connect. A failed save returns false: the SnackBar shows the error and the
    // modal stays open to retry.
    const ok = await handleSave(false);
    if (!ok) return;
    onClose();
    if (isActiveConfig && (status === "connected" || status === "connecting")) {
      void onReconnect();
    }
  };

  // Open the folder containing the config .toml in the OS file explorer (quick access — the
  // app may be installed anywhere). Derive the parent dir from the path and hand it to the
  // shell opener.
  const openFolder = () => {
    // IN-06: drop the last path segment by splitting on EITHER separator. The old code
    // picked one separator by which the path "includes" first, then sliced at its last
    // occurrence — on a mixed-separator Windows path (both `/` and `\` present) it could
    // pick the wrong one and open the wrong folder. Splitting on `[\\/]` and dropping the
    // final segment is separator-agnostic.
    const parts = configPath.split(/[\\/]/);
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : configPath;
    // IN-17: do NOT swallow the failure. This button used to be a silent no-op because the
    // Tauri shell open-scope rejected local folder paths (the default scope only allows
    // mailto:/tel:/https:) and the error was discarded. tauri.conf.json now widens
    // plugins.shell.open to also allow drive paths (`C:\…` / `C:/…`), so this opens Explorer;
    // logging keeps a future scope/permission regression visible instead of silent.
    void openPath(folder).catch((e) => {
      console.error("openFolder: failed to open", folder, e);
    });
  };

  const closeUnlessSaving = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeUnlessSaving}
      size="lg"
      showCloseButton
      closeButtonDisabled={saving}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      role="dialog"
      ariaLabelledby="config-edit-title"
      ariaModal
    >
      <h2
        id="config-edit-title"
        className="text-lg font-semibold text-[var(--color-text-primary)]"
      >
        {t("connection.editView.title")}
      </h2>
      <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
        {configName} ·{" "}
        {isActiveConfig ? (
          <span className="font-medium text-[var(--color-status-connected)]">
            {t("connection.editView.active")}
          </span>
        ) : (
          t("connection.editView.inactive")
        )}
      </p>

      {loadError ? (
        // The config file is corrupt / unparseable — there is nothing to «retry» (re-reading
        // the same broken file changes nothing), so NO retry button: just the error + a
        // single «Закрыть». The user closes and re-imports the config.
        <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-4)]">
          <ErrorBanner variant="error" message={t("connection.editView.load_error")} />
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("connection.editView.close")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-5)]">
          {/* «Имя конфига» — the config's TITLE on the «Подключение» card. Editable here
              (incl. for the ACTIVE config — the lead card itself is read-only); applied on save.
              Empty → the card falls back to the username. Stored as endpoint.name. The N/64
              character counter lives INSIDE the field (Input counterMax), not above it. */}
          <Field label={t("connection.editView.display_name")} help={t("connection.editView.help_display_name")}>
            <Input
              value={displayName}
              onChange={(e) =>
                // IN-58: send the RAW value (empty string included) so clearing the field PERSISTS
                // as a clear. Sending `undefined` dropped the key from the payload and the
                // non-destructive merge then KEPT the old on-disk name (the «снэкбар сохранено, а
                // имя не менялось» bug). Empty → backend strips endpoint.name → card shows the username.
                state.updateField("endpoint.name", e.target.value)
              }
              // IN-56: no per-keystroke input cap (owner request — the old 80 limit was an
              // arbitrary buffer). The user can type/paste any length; the N/64 counter turns red
              // over the limit and «Сохранить» is disabled (saveDisabled ← nameInvalid) + the
              // backend rejects > 64, so the ONLY real limit is at SAVE, not while typing.
              counterMax={64}
              error={nameErrorMsg ?? undefined}
              placeholder={t("connection.editView.display_name_placeholder")}
              aria-label={t("connection.editView.display_name")}
            />
          </Field>

          {/* Read-only credentials. The password is a MASKED placeholder, NEVER the real
              value (D-29): the field is disabled and shows fixed dots. Server credentials
              belong to the server and editing them here would only break the config. */}
          <Field label={t("connection.editView.server_address")}>
            <Input
              value={host}
              disabled
              readOnly
              aria-label={t("connection.editView.credentials_address_aria")}
            />
          </Field>
          <Field label={t("connection.editView.login")}>
            <Input
              value={user}
              disabled
              readOnly
              aria-label={t("connection.editView.credentials_login_aria")}
            />
          </Field>
          <Field label={t("connection.editView.password")}>
            <PasswordInput
              value={MASKED_PASSWORD_PLACEHOLDER}
              disabled
              readOnly
              showIcon
              aria-label={t("connection.editView.credentials_password_aria")}
            />
          </Field>

          {/* Protocol */}
          <Field label={t("connection.editView.protocol")} help={t("connection.editView.help_protocol")}>
            <Segmented
              ariaLabel={t("connection.editView.protocol")}
              options={[
                { id: "http2", label: "HTTP/2" },
                { id: "http3", label: "HTTP/3" },
              ]}
              value={protocol}
              onChange={(id) => state.updateField("endpoint.upstream_protocol", id)}
            />
          </Field>

          {/* Listener mode + its dependent field(s) */}
          <Field label={t("connection.editView.mode")} help={t("connection.editView.help_mode")}>
            <Segmented
              ariaLabel={t("connection.editView.mode")}
              options={[
                { id: "tun", label: "TUN" },
                { id: "socks", label: "SOCKS5" },
              ]}
              value={listenerMode}
              onChange={(id) => {
                // IN-54: one atomic switch. Preserves the other mode's data for a round-trip
                // (TUN routes are no longer destroyed) and flips on the FIRST click. A fresh TUN
                // defaults to a full tunnel (0.0.0.0/0) so it always routes traffic.
                if (id !== listenerMode) state.setListenerMode(id as "tun" | "socks");
              }}
            />
          </Field>
          {listenerMode === "tun" ? (
            <Field label={t("connection.editView.mtu")} help={t("tooltips.mtu")}>
              <NumberInput
                value={mtu}
                onChange={(v) => state.updateField("listener.tun.mtu_size", Number(v) || 0)}
                min={MTU_MIN}
                max={MTU_MAX}
                maxLength={4}
                onErrorChange={setMtuError}
                aria-label={t("connection.editView.mtu")}
              />
            </Field>
          ) : (
            <>
              <Field label={t("connection.editView.socks_address")} help={t("connection.editView.help_socks_address")}>
                <Input
                  value={socksAddr}
                  onChange={(e) =>
                    // WR-07: keep the keystroke-level whitelist (digits / dots / colons /
                    // brackets for IPv6) but do NOT snap an emptied field back to the default —
                    // store the raw value so the user can clear and re-type. Shape validation
                    // (host + port range) is surfaced via `error` and gates `saveDisabled`.
                    state.updateField(
                      "listener.socks.address",
                      e.target.value.replace(/[^0-9.:[\]]/g, ""),
                    )
                  }
                  error={socksErrorMsg ?? undefined}
                  placeholder="127.0.0.1:1080"
                  aria-label={t("connection.editView.socks_address")}
                />
              </Field>
              <Field label={t("connection.editView.socks_login")} help={t("connection.editView.help_socks_login")}>
                <Input
                  value={socksUser}
                  onChange={(e) =>
                    state.updateField("listener.socks.username", e.target.value || undefined)
                  }
                  placeholder={t("connection.editView.socks_login_placeholder")}
                  aria-label={t("connection.editView.socks_login")}
                />
              </Field>
              <Field label={t("connection.editView.socks_password")} help={t("connection.editView.help_socks_password")}>
                <PasswordInput
                  value={socksPass}
                  onChange={(e) =>
                    state.updateField("listener.socks.password", e.target.value || undefined)
                  }
                  showIcon
                  placeholder={t("connection.editView.socks_password_placeholder")}
                  aria-label={t("connection.editView.socks_password")}
                />
              </Field>
            </>
          )}

          {/* Security + network toggles — flat list, no section headings, no per-row icons.
              Kill Switch is per-config here (part of the .toml), not the global switch. */}
          <Toggle
            checked={killSwitch}
            onChange={(v) => state.updateField("killswitch_enabled", v)}
            label={t("connection.editView.kill_switch")}
            description={t("connection.editView.kill_switch_desc")}
            labelExtra={<HelpHint text={t("tooltips.kill_switch_detailed")} />}
          />
          <Toggle
            checked={antiDpi}
            onChange={(v) => state.updateField("endpoint.anti_dpi", v)}
            label={t("connection.editView.anti_dpi")}
            description={t("connection.editView.anti_dpi_desc")}
            labelExtra={<HelpHint text={t("tooltips.anti_dpi_detailed")} />}
          />
          <Toggle
            checked={postQuantum}
            onChange={(v) => state.updateField("post_quantum_group_enabled", v)}
            label={t("connection.editView.post_quantum")}
            description={t("connection.editView.post_quantum_desc")}
            labelExtra={<HelpHint text={t("tooltips.post_quantum_detailed")} />}
          />
          <Toggle
            checked={ipv6}
            onChange={(v) => state.updateField("endpoint.has_ipv6", v)}
            label={t("connection.editView.ipv6")}
            description={t("connection.editView.ipv6_desc")}
            labelExtra={<HelpHint text={t("tooltips.ipv6_detailed")} />}
          />

          {/* DNS upstreams — add/remove, with the format hint in «?». */}
          <Field label={t("connection.editView.dns")} help={t("connection.editView.help_dns")}>
            <DnsUpstreamsInput
              value={dns}
              onChange={(arr) => state.updateField("endpoint.dns_upstreams", arr)}
              onError={setDnsError}
            />
          </Field>

          {/* Read-only path to the config .toml on disk + a button to open its folder. */}
          <Field label={t("connection.editView.config_file")}>
            <div className="flex items-center gap-[var(--space-2)]">
              <div className="min-w-0 flex-1">
                <Input value={configPath} readOnly aria-label={t("connection.editView.config_file")} />
              </div>
              <IconButton
                icon={<FolderOpen className="w-4 h-4" />}
                aria-label={t("connection.editView.open_folder")}
                tooltip={t("connection.editView.open_folder")}
                onClick={openFolder}
                className="shrink-0"
              />
            </div>
          </Field>

          {/* Footer — no captions; the button label states the effect (F26). */}
          <div className="flex justify-end gap-[var(--space-3)]">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              {t("connection.editView.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={saveDisabled}
              onClick={handleSaveClick}
              className="min-w-[9rem] justify-center"
            >
              {saveLabel}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
