import { describe, it, expect } from "vitest";
// The real configuration file, as text. `?raw` rather than an import of the JSON object: the point
// of these tests is what SHIPS, and a parsed import would let a build-time transform stand between
// the assertion and the file.
import tauriConfSource from "../../src-tauri/tauri.conf.json?raw";

/**
 * WHAT THIS FILE IS FOR, AND THE FINDING THAT PROMPTED IT.
 *
 * The phase-30 security audit recorded that `shell:allow-open` is granted «with no URL scope»,
 * reading `src-tauri/capabilities/default.json` and finding a bare permission string. That reading
 * is wrong about where Tauri 2 keeps this scope. `tauri-plugin-shell` 2.3.5 takes the open-scope
 * from `tauri.conf.json > plugins > shell > open` (`config.rs` `ShellAllowlistOpen`), compiles it
 * into a regex, wraps it in `^…$` and refuses any argument that does not match
 * (`scope.rs::Scope::open`). The capability entry decides WHETHER the command exists; this string
 * decides WHAT it will accept. The app has carried a custom value here since the phase that made
 * «открыть папку» work, so the scope was never absent.
 *
 * It was, however, wider than the app needs, and these tests are what keeps it narrow. They are
 * written as BEHAVIOUR — the same regex the plugin builds, asked about concrete strings — rather
 * than as a comparison against a quoted pattern, because a test that quotes the pattern back at
 * itself passes for any pattern at all.
 */

/** The plugin surrounds the configured string with `^…$` before matching. Mirror that exactly. */
function shellOpenScope(): RegExp {
  const conf = JSON.parse(tauriConfSource) as {
    plugins?: { shell?: { open?: unknown } };
  };
  const open = conf.plugins?.shell?.open;
  expect(
    typeof open,
    "plugins.shell.open must be a validation REGEX string. `true` means the plugin's own default " +
      "scope (mailto/tel/https), and removing the key altogether means the same — either way the " +
      "drive-path arm the folder button needs disappears and the two schemes below come back.",
  ).toBe("string");
  return new RegExp(`^${open as string}$`);
}

describe("shell open scope (tauri.conf.json > plugins > shell > open)", () => {
  const scope = shellOpenScope();

  // ─── Every call site the app actually has ───
  //
  // Enumerated from a sweep of `@tauri-apps/plugin-shell` imports across `src/`. A scope is only
  // safe to narrow if the narrowing is measured against the whole set, so the set is written down
  // here and any future call site that does not match one of these shapes fails loudly at runtime —
  // which is why these tests exist beside the forbidden ones rather than instead of them.

  it("пропускает адрес страницы релиза (App.tsx — кнопка «Скачать»)", () => {
    expect(
      scope.test(
        "https://github.com/ialexbond/TrustTunnelClientForWindows/releases/download/v3.0.1/TrustTunnel%20Client%20Pro_3.0.1_x64-setup.exe",
      ),
    ).toBe(true);
  });

  it("пропускает адрес репозитория (FooterLinks.tsx, ConfigurationTab.tsx)", () => {
    expect(scope.test("https://github.com/ialexbond/TrustTunnelClientForWindows")).toBe(true);
    expect(
      scope.test("https://github.com/TrustTunnel/TrustTunnel/blob/master/CONFIGURATION.md"),
    ).toBe(true);
  });

  it("пропускает ссылку из заметок выпуска (ChangelogModal.tsx)", () => {
    expect(scope.test("https://example.com/release-notes")).toBe(true);
  });

  it("пропускает отчёт замера — он бывает и по http (BenchmarkModal.tsx)", () => {
    // NOT tightened to https. `parser.ts`'s REPORT_LINK_RE is `/Report Link:\s+(https?:\/\/\S+\.svg)/i`
    // — the measurement script emits whichever the report host used, and refusing http here would
    // silently break a working button to защитить от нечего. Handing an http URL to the system
    // browser is not the OS-handler risk this scope is about.
    expect(scope.test("http://www.speedtest.net/result/12345678.svg")).toBe(true);
    expect(scope.test("https://www.speedtest.net/result/12345678.svg")).toBe(true);
  });

  it("пропускает путь к папке конфигурации (ConfigEditView.tsx — «Открыть папку»)", () => {
    expect(scope.test("C:\\Users\\tester\\AppData\\Roaming\\TrustTunnel")).toBe(true);
    expect(scope.test("C:/Users/tester/AppData/Roaming/TrustTunnel")).toBe(true);
  });

  // ─── What the narrowing removed, and what was never allowed ───

  it("НЕ пропускает mailto: и tel: — ими не пользуется ни одна кнопка", () => {
    // These were inherited from the plugin's default pattern, not chosen. No call site produces
    // either, and `mailto:` was the one scheme a hostile release body could still push through to
    // an OS handler: react-markdown's `defaultUrlTransform` permits http(s), irc(s), mailto and
    // xmpp, this scope blocked irc/xmpp, and mailto went through. Removing two arms nothing uses
    // costs the app nothing and closes that.
    expect(scope.test("mailto:attacker@example.com?subject=hi")).toBe(false);
    expect(scope.test("tel:+15550100")).toBe(false);
  });

  it("НЕ пропускает прочие схемы, которые может содержать чужой текст выпуска", () => {
    expect(scope.test("irc://evil.example/channel")).toBe(false);
    expect(scope.test("xmpp:attacker@example.com")).toBe(false);
    expect(scope.test("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(scope.test("javascript:alert(1)")).toBe(false);
  });

  it("НЕ пропускает голый путь и голое имя файла", () => {
    // A relative URL carries no colon, so react-markdown passes it through untouched; this scope is
    // what stops it there.
    expect(scope.test("/etc/passwd")).toBe(false);
    expect(scope.test("calc.exe")).toBe(false);
    expect(scope.test("\\\\evil-share\\payload.exe")).toBe(false);
  });

  it("НЕ пропускает схему, приклеенную к разрешённой (полное совпадение, не поиск)", () => {
    // The plugin anchors with `^…$`. Without the anchors these would match on a substring, which is
    // the classic way a scope regex turns out to allow everything.
    expect(scope.test("javascript:https://example.com")).toBe(false);
    expect(scope.test("https://example.com\nmailto:x@y")).toBe(false);
  });
});
