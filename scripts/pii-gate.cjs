/*
 * pii-gate.cjs — personal data must not reach the public repository.
 *
 * WHAT IT REFUSES
 *   Account names inside absolute user paths, hostnames outside the documentation + vendor
 *   allowlist, routable IPv4/IPv6, and e-mail outside the reserved documentation domains.
 *
 *   The check is mechanical because review is not reliable for this class, and it runs where
 *   publication happens — in `prerelease`, in CI, and as a named step of CLAUDE.md's publication
 *   ritual that must pass before a push to a release branch.
 *
 * THE REAL DESIGN PROBLEM IS THE FALSE-POSITIVE RATE, NOT THE DETECTION
 *   The scan that motivated this gate produced 195 findings, about a dozen of which were real.
 *   `rect.top` and `dropdown.style.top` parse as domains (`.top` is a real gTLD). `README.md` is
 *   Moldova, `lifecycle.rs` is Serbia, `install.sh` is Saint Helena, `report.zip` is a gTLD.
 *   `128x128@2x.png` parses as an e-mail. `10:01:05` parses as IPv6. `"1.2.3.4-beta"` parses as
 *   an address. A gate that reports those is a gate that gets commented out of `prerelease`
 *   inside a week, and then the next real hostname ships. Every rejection rule below is therefore
 *   named, and every one of them is pinned by an assertion in pii-gate.test.cjs, so a later
 *   tightening that reintroduces the noise turns that suite red first.
 *
 *   The rules buy their low noise floor with DELIBERATE BLIND SPOTS, listed at each rule. The
 *   trade is stated openly rather than hidden: a gate that is trusted and has known gaps beats a
 *   precise gate that has been disabled.
 *
 * NO RULE MAY PASS VACUOUSLY
 *   Every invocation first runs each detector against a built-in fixture pair — a leak it must
 *   catch and a lookalike it must ignore. A detector edited into always-false would otherwise
 *   report a clean tree, which is the one failure mode this file cannot afford. Self-check
 *   failure exits 2 (gate broken), never 0.
 *
 * THE RULE APPLIES TO NEW AND CHANGED CODE; WHAT WAS ALREADY HERE IS BASELINED
 *   Applied backwards to the whole tree, the rule means rewriting hundreds of harmless invented
 *   literals (`1.2.3.4`, `evil.com`, `foo@bar.com`)  pii-gate-allow: invented literals, as examples
 *   and every assertion around them, in files nobody asked to change. That was tried once and
 *   abandoned 580 edits deep. The findings that were already here therefore live in
 *   `scripts/pii-baseline.txt`: an explicit, greppable register of accepted debt, pinned by
 *   (class, file, value) AND by count, so the same pattern in a NEW place still fails. See the
 *   BASELINE section below for the four properties that stop it becoming a mute button.
 *
 * Invoked as: node scripts/pii-gate.cjs [--json] [--verbose] [--no-git] [repo-root]
 *             node scripts/pii-gate.cjs --write-baseline   (regenerate the register, on purpose)
 * Exit: 0 no findings beyond the baseline, 1 something to fix, 2 the gate itself could not run.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ═══════════════════════════════════════════════════════════════════════════════
// SCOPE — what actually travels to the public release branch
//
// Mirrors CLAUDE.md § «Что ИДЁТ на release». Two deliberate differences, both widening:
//   * Storybook stories and the `_story/` tier are scanned even though they are filtered out at
//     publication time. "Excluded from release today" is a policy, not a property; a real
//     hostname that never enters the tree cannot leak when the policy changes.
//   * `gui-light/` is scanned in full even though its redesign is parked.
// ═══════════════════════════════════════════════════════════════════════════════

/** Directory prefixes whose contents are published (or may become published). */
const SCAN_PREFIXES = ["gui-pro/", "gui-light/", "scripts/", ".github/"];

/** Individually published files at the repository root. */
const SCAN_ROOT_FILES = ["CHANGELOG.md", "README.md", "rust-toolchain.toml"];

/*
 * Vendored upstream and local-only trees.
 *
 * `core/`, `net/`, `common/`, `platform/`, `tcpip/`, `installer/`, `integration-tests/` are the
 * forked C++ VPN core; `third-party/` and `trusttunnel/` are vendored outright. They are public,
 * but they are not where personal values land — nobody pastes server names into
 * upstream C++ — and scanning them would mean owning a noise budget in code we do not author and
 * cannot freely edit. Verified empty of `C:\Users\<name>` paths when this gate was written.
 *
 * `.planning/`, `memory/`, `.claude/` and CLAUDE.md are force-added LOCALLY and never pushed to a
 * release branch (CLAUDE.md § «Что НЕ идёт на release»). They are full of real hostnames on
 * purpose — that is the debugging record. Scanning them would produce hundreds of findings for
 * values that are already exactly where they belong.
 */
const SKIP_PREFIXES = [
  ".planning/", "memory/", ".claude/", ".git/",
  "third-party/", "trusttunnel/", "core/", "net/", "common/", "platform/", "tcpip/",
  "installer/", "integration-tests/", "cmake/", ".specs/", ".devcontainer/",
];

/** Path segments that are build output or dependencies — never authored, never reviewed. */
const SKIP_SEGMENTS = new Set(["node_modules", "target", "dist", "build", "storybook-static", ".git"]);

/*
 * Generated or vendored files whose content nobody writes by hand — plus this gate's own test
 * suite, which necessarily contains leak-SHAPED fixtures and one arm that asserts a
 * marker-without-a-reason still reports, so its findings can never be suppressed inline.
 *
 * That skip is a blind spot on a file that travels to the public branch, so it comes with a control
 * that lives inside the skipped file: test 34 there scans its own source and fails on any value not
 * declared in its `SYNTHETIC_FIXTURES` map, with a written reason per value. Delete that test and
 * the blind spot is unguarded again.
 */
const SKIP_BASENAMES = new Set([
  "package-lock.json", "Cargo.lock", "CLAUDE.md", "AGENTS.md", "pii-gate.test.cjs",
  // The baseline is a register OF findings; scanning it would report every value it exists to
  // record. It is reviewed as a whole, in its own diff, which is the point of its format.
  "pii-baseline.txt",
]);

/**
 * Binary and asset extensions. `.svg` is here with the rest: the SVGs in this tree are flag and
 * brand glyphs whose path data is a wall of decimal numbers, which is noise bait for the IPv4
 * matcher, and no personal value has ever been authored into one.
 */
const SKIP_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".svg", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".zip", ".gz", ".7z", ".msi", ".pdb", ".lib", ".obj",
  ".mp4", ".webm", ".mp3", ".wav",
]);

/** Source extensions where a hostname must sit inside a string or a comment to count (rule H4). */
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".rs", ".css", ".scss"]);

/** Extensions whose whole body is prose or data — the string/comment rule cannot apply. */
const HASH_COMMENT_EXTS = new Set([".py", ".sh", ".yml", ".yaml", ".toml", ".nsh", ".nsi", ".ps1"]);

// ═══════════════════════════════════════════════════════════════════════════════
// ALLOWLISTS
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * Account names that carry no identity. Everything else under an absolute user path is a person.
 * Placeholders belong here too — the scrub replaces real names with `<user>`, and the gate must
 * accept the replacement it asks for.
 */
const ALLOWED_ACCOUNT_NAMES = new Set([
  // Windows' own built-in profiles.
  "public", "default", "default user", "defaultuser", "all users", "alluser",
  // Placeholders. The scrub rewrites real names to these, so the gate must accept what it asks
  // for; `<...>` in any form is handled structurally below.
  "user", "username", "youruser", "your-user",
  // CI service accounts — a runner's home directory identifies a machine, not a person.
  "runner", "containeradministrator", "vsts", "root",
  /*
   * Convention placeholders already used throughout this tree's tests: alice/bob are the
   * cryptography-literature pair, `me`/`tester`/`somebody` are self-evidently stand-ins. They are
   * allowlisted rather than rewritten because an allowlist entry is one visible, greppable line,
   * whereas rewriting ~60 test literals is 60 chances to break an assertion for no gain in
   * safety. The name that actually leaked is not here, and never can be: this list is closed and
   * reviewed, not pattern-based.
   */
  "me", "you", "alice", "bob", "carol", "dave", "eve", "mallory",
  "tester", "somebody", "someone", "admin", "test", "demo", "example", "user1", "user2",
]);

/*
 * RFC 2606 / RFC 6761 reserved names, plus `.local` (RFC 6762 mDNS) which this codebase uses
 * heavily as a stand-in SNI (`trusttunnel.local`). A name under any of these cannot belong to
 * anybody, so it is always safe to publish.
 */
const RESERVED_TLDS = new Set(["test", "invalid", "localhost", "example", "local"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

/*
 * The project's genuine external dependencies. Matched on the registrable domain, so any
 * subdomain of an entry is covered. Anything NOT here fails — an allowlist, never a blocklist,
 * because the leak we are guarding against is by definition a name nobody thought to list.
 */
const ALLOWED_DOMAINS = new Set([
  // source hosting / CI
  "github.com", "githubusercontent.com", "github.io", "githubassets.com",
  "nodejs.org", "npmjs.com", "npmjs.org", "crates.io", "rust-lang.org", "docs.rs",
  // toolchain and vendors named in code, config or docs
  "tauri.app", "vitejs.dev", "vitest.dev", "storybook.js.org", "typescriptlang.org",
  "eslint.org", "tailwindcss.com", "w3.org", "mozilla.org", "microsoft.com",
  "digicert.com", "sectigo.com", "globalsign.com", "ssl.com", "wireguard.com",
  "vercel.com", "shadcn.com", "radix-ui.com", "material.io", "lucide.dev",
  // connectivity probes and network services the product genuinely talks to
  "cloudflare.com", "msftconnecttest.com", "google.com", "gstatic.com", "googleapis.com",
  "speedtest.net", "opencck.org", "quad9.net", "letsencrypt.org",
  "maxmind.com",                       // GeoIP database vendor — named in routing code and docs
  "adguard-dns.com", "adguard.com",    // DNS upstreams offered in Settings
  "yandex.net", "yandex.ru",           // DoT/DoH upstreams offered in Settings
  // domains that appear as ROUTING-RULE EXAMPLES — the product's whole subject is deciding which
  // hosts bypass the tunnel, so its docs and tests necessarily name real destinations
  "googlevideo.com", "youtube.com", "yandexwebcache.org", "netflix.com", "whatsapp.net",
  // referenced in documentation, release notes and comments
  "x.com", "telegram.org", "t.me", "llvm.org", "keepachangelog.com", "semver.org", "hetzner.com",
  "wintun.net",                        // WireGuard's WinTUN driver — bundled, and linked in docs
  "react.dev", "apple.com", "jsdelivr.net", "serverfault.com", "openpgp.org", "ytimg.com",
]);

/*
 * Public anycast resolvers the product ships as DNS configuration. These are global
 * infrastructure — an address that cannot identify a person no matter who typed it.
 */
const ALLOWED_IPV4 = new Set([
  "8.8.8.8", "8.8.4.4",             // Google
  "1.1.1.1", "1.0.0.1",             // Cloudflare
  "9.9.9.9", "149.112.112.112",     // Quad9
  "77.88.8.8", "77.88.8.1",         // Yandex
  "208.67.222.222", "208.67.220.220", // OpenDNS
  "94.140.14.14", "94.140.15.15",   // AdGuard
]);

const ALLOWED_IPV6_PREFIXES = [
  "::", "::1", "fe80:", "fc", "fd",  // unspecified, loopback, link-local, unique-local
  "ff",                              // multicast
  "fec0:",                           // deprecated site-local — non-routable, appears in tests
  "2001:db8:", "2001:db8::",         // RFC 3849 documentation
  "2606:4700:", "2001:4860:", "2620:fe:", "2a02:6b8:", // the resolvers above
  "2a00:1450:",                      // Google — routing-rule examples, same reason as googlevideo.com
];

/*
 * TLDs the matcher will consider at all — a curated list, and the single biggest reason this
 * gate's noise floor is zero on a clean tree.
 *
 * DELIBERATELY ABSENT, each for a collision this tree really contains:
 *   .top   `rect.top`, `dropdown.style.top`        .style  `primer.style`, `el.style`
 *   .rs    every Rust module (`lifecycle.rs`)      .md     `README.md`, `CHANGELOG.md`
 *   .sh    `install.sh`, `i18n-dead-keys.sh`       .so     `libfoo.so`
 *   .zip   `report.zip`                            .id     `payload.data.id`, `row.id`
 *   .is    `Object.is(a, b)`                       .at     `arr.at(0)`
 *   .be    `expect(x).to.be`                       .it     `describe.it`
 *   .in .to .no .es .as .do .name .email .link .click .page .info? (kept) — same class.
 * The cost is a blind spot: a leaked host under one of those TLDs is invisible here. That is
 * accepted, and the account-name, IP and e-mail classes are unaffected by it.
 */
const KNOWN_TLDS = new Set([
  // global. Also absent on purpose, each measured against this tree on the first run:
  //   .app   `settings.app` — 39 findings      .host  `sshParams.host` — 29 findings
  //   .cc    C++ sources (`x.cc`)              .store `redux.store`
  "com", "net", "org", "io", "dev", "me", "co", "biz", "xyz", "online", "site",
  "cloud", "tech", "shop", "pw", "pro", "info",
  // the region those hosts lived in. `.md` (Moldova) is absent on purpose: every
  // Markdown file in the tree would otherwise read as a hostname.
  "ru", "su", "ua", "by", "kz", "ge", "am", "uz", "az", "kg", "tj",
  // the gTLD both leaked server names used
  "win",
  // hosting-provider ccTLDs
  "de", "nl", "fr", "uk", "pl", "fi", "se", "dk", "cz", "sk", "hu", "ro", "bg", "gr", "pt",
  "ee", "lv", "lt", "tr", "us", "ca", "br", "au", "sg", "hk", "jp", "kr", "cn", "za", "ch",
  "ie", "nz", "mx", "il", "ae",
]);
KNOWN_TLDS.delete("");
KNOWN_TLDS.delete("мкд");

/*
 * Labels that mark a dotted chain as source code or an i18n key rather than a host.
 * `notificationcopy.connected.title.ru` is a translation key whose last segment is a locale that
 * happens to be Russia's ccTLD, and nothing about its SHAPE tells it apart from a host such as
 * `cdn.somebox.ru` — pii-gate-allow: invented illustration, a name nobody owns
 * so the discriminator has to be vocabulary. Blind spot: a real host with a label from this list
 * (`status.somewhere.ru`) is missed.
 */
const CODE_WORD_LABELS = new Set([
  "title", "name", "value", "label", "text", "data", "key", "id", "type", "kind", "state",
  "status", "style", "top", "left", "right", "bottom", "width", "height", "size", "color",
  "index", "length", "count", "total", "current", "target", "message", "error", "code",
  "config", "options", "props", "ref", "node", "item", "list", "row", "cell", "entry", "field",
  "path", "file", "dir", "url", "uri", "href", "src", "alt", "body", "head", "meta", "root",
  "base", "self", "result", "output", "input", "args", "params", "opts", "ctx", "env", "mode",
  "flag", "level", "step", "phase", "plan", "task", "spec", "mock", "stub", "demo", "sample",
  "fixture", "connected", "disconnected", "connecting", "enabled", "disabled", "active",
  "visible", "hidden", "loading", "success", "failure", "warning", "debug", "trace",
  "start", "stop", "open", "close", "next", "prev", "first", "last", "default", "custom",
  "auto", "manual", "module", "component", "styles", "class", "props2",
]);

/** The inline exception marker. A reason is mandatory — see `EXCEPTION_RE`. */
const EXCEPTION_RE = /pii-gate-allow\s*:\s*(\S.*?)\s*$/;

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTORS
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * A1 — absolute user paths.
 *
 * Deliberately NOT a search for the one name that leaked. A gate that knows one name proves
 * nothing about the next machine, the next contributor, or a path pasted from a tester's box —
 * and writing the name into the gate would republish it here. It matches the SHAPE of a per-user
 * home directory instead, and reads whatever account name it finds out of it.
 */
const USER_PATH_RE = new RegExp(
  [
    // Drive-rooted: C:\Users\…, C:/Users/…, C:\\Users\\… (the escaped form found in Rust and JS
    // string literals). A drive letter is proof enough that this is a path.
    String.raw`[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}`,
    // Rootless: /Users/… and /home/…. The leading separator must NOT be preceded by an
    // identifier character, or Storybook titles like "Control Panel/Users/UserModal" read as
    // an account named UserModal — 8 of the first run's 89 account findings were exactly that.
    String.raw`|(?<![A-Za-z0-9_.\-])[\\/]{1,2}(?:Users|home)[\\/]{1,2}`,
  ].join(""),
  "g"
);
/*
 * The account name itself. Must OPEN with an alphanumeric, `<` or `%`: a name starting with a dot
 * is a dotfile that followed a user-less path (`/home/.ssh/id_rsa` produced 12 findings for an
 * "account" called `.ssh`), and a name of bare dots is an elision (`C:\Users\...\AppData`).
 */
const ACCOUNT_NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._%+-]*(?: [A-Za-z]+)?|<[^>]*>|%[A-Za-z]+%)/;

function findAccountNames(line) {
  const out = [];
  USER_PATH_RE.lastIndex = 0;
  let m;
  while ((m = USER_PATH_RE.exec(line)) !== null) {
    const rest = line.slice(m.index + m[0].length);
    const nm = ACCOUNT_NAME_RE.exec(rest);
    if (!nm) continue;
    let name = nm[1];
    // Structural placeholders: `<user>`, `<name>`, `<длинное имя>`, `%USERNAME%`. Anything inside
    // angle brackets or percent signs is a slot, not a person, whatever word fills it. Checked
    // BEFORE the space-split below, or a two-word placeholder loses its closing bracket.
    if (/^<[^>]*>?$/.test(name) || /^%[A-Za-z]+%$/.test(name)) continue;
    // «All Users» and «Default User» are two-word account names; anything else that grabbed a
    // trailing word took it from prose, so trim back to the first token.
    if (name.includes(" ") && !ALLOWED_ACCOUNT_NAMES.has(name.toLowerCase())) name = name.split(" ")[0];
    if (!name) continue;
    // One or two characters cannot identify anybody; `C:\Users\u\…` and `C:/Users/x/…` are the
    // shortest stand-ins this tree's tests use.
    if (name.length <= 2) continue;
    if (ALLOWED_ACCOUNT_NAMES.has(name.toLowerCase())) continue;
    out.push({ cls: "account-name", value: name, column: m.index + 1, rule: "A1:absolute-user-path" });
  }
  return out;
}

/*
 * H1..H4 — hostnames. The candidate shape is permissive; the four rejection rules do the work.
 */
const HOST_RE = /(?<![A-Za-z0-9_@.\-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+)([A-Za-z]{2,24})(?![A-Za-z0-9_\-])/g;

function registrable(host) {
  const parts = host.split(".");
  return parts.slice(-2).join(".").toLowerCase();
}

function findHostnames(line, ext) {
  const out = [];
  HOST_RE.lastIndex = 0;
  let m;
  while ((m = HOST_RE.exec(line)) !== null) {
    const value = m[0];
    const labels = value.toLowerCase().split(".");
    const tld = labels[labels.length - 1];

    // H1 — an unlisted TLD is not considered at all. Kills the file-extension and
    // JS-property collisions wholesale; see KNOWN_TLDS for the named casualties.
    if (RESERVED_TLDS.has(tld)) continue;
    if (!KNOWN_TLDS.has(tld)) continue;

    // H2 — reserved documentation names and the project's real vendors. Matched on the
    // registrable domain AND on the full host, because a vendor can live under a public suffix
    // that hands out free subdomains (`storybook.js.org`): listing only the last two labels
    // there would wave through every one of the thousands of names beneath that suffix.
    const reg = registrable(value);
    const whole = value.toLowerCase();
    if (RESERVED_DOMAINS.has(reg)) continue;
    if (ALLOWED_DOMAINS.has(reg) || ALLOWED_DOMAINS.has(whole)) continue;

    // H3 — a dotted chain carrying a source-code or i18n vocabulary label is not a host.
    if (labels.slice(0, -1).some((l) => CODE_WORD_LABELS.has(l))) continue;

    // H5 — reverse-DNS identifiers read backwards: `com.trusttunnel.gui.dev` is the Tauri bundle
    // id, not a host in the `.dev` zone. A real host never opens with a TLD label.
    if (labels.length >= 3 && ["com", "org", "net", "io"].includes(labels[0])) continue;

    // H4 — in source files a host must sit inside a string literal or a comment. A bare
    // `x.somebox.ru` in expression position is a property access. pii-gate-allow: invented name
    if (CODE_EXTS.has(ext) && !inStringOrComment(line, m.index, ext)) continue;

    out.push({ cls: "hostname", value, column: m.index + 1, rule: "H:unallowlisted-domain" });
  }
  return out;
}

/*
 * P1 — IPv4. Octet-validated, then filtered against every range that cannot identify anyone.
 */
const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g;

function isNonIdentifyingV4(o) {
  const [a, b] = o;
  if (a === 0 || a === 127) return true;                    // this-network, loopback
  if (a === 10) return true;                                // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;         // RFC 1918
  if (a === 192 && b === 168) return true;                  // RFC 1918
  if (a === 169 && b === 254) return true;                  // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT
  if (a >= 224) return true;                                // multicast + reserved + broadcast
  if (a === 192 && b === 0 && o[2] === 2) return true;      // RFC 5737 TEST-NET-1
  if (a === 198 && b === 51 && o[2] === 100) return true;   // RFC 5737 TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true;    // RFC 5737 TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return true;     // RFC 2544 benchmarking
  if (a === 192 && b === 0 && o[2] === 0) return true;      // RFC 6890 IETF protocol assignments
  return false;
}

function findIPv4(line) {
  const out = [];
  IPV4_RE.lastIndex = 0;
  let m;
  while ((m = IPV4_RE.exec(line)) !== null) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((n) => n > 255)) continue;

    // P1a — version strings share IPv4's shape. `"1.2.3.4-beta"`, `v1.2.3.4`, `^1.2.3.4` are
    // releases, not addresses. Checked on the surrounding characters, not on a keyword.
    const before = line[m.index - 1];
    const after = line[m.index + m[0].length];
    if (before && /[v^~=@-]/.test(before)) continue;
    if (after && /[-+]/.test(after) && /[A-Za-z0-9]/.test(line[m.index + m[0].length + 1] || "")) continue;

    if (isNonIdentifyingV4(octets)) continue;
    const value = m[0];
    if (ALLOWED_IPV4.has(value)) continue;
    out.push({ cls: "ipv4", value, column: m.index + 1, rule: "P1:routable-ipv4" });
  }
  return out;
}

/*
 * P2 — IPv6. The trap here is clock time: `10:01:05` is three valid hex groups. A candidate
 * therefore has to contain a hex letter or a `::` run before it is considered an address at all.
 */
const IPV6_RE = /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])/g;

function findIPv6(line) {
  const out = [];
  IPV6_RE.lastIndex = 0;
  let m;
  while ((m = IPV6_RE.exec(line)) !== null) {
    const value = m[0];
    if (!/[A-Fa-f]/.test(value) && !value.includes("::")) continue; // P2a — clock time
    /*
     * P2b — colon-separated hex BYTES are a certificate fingerprint or a MAC address, not an
     * address: `AA:BB:CC:DD:EE:FF:00:11`, `DE:AD:BE:EF`. Every group exactly two digits wide and
     * no `::` run is a shape no real IPv6 address takes (`2001:db8:5:21::1` has 4-wide groups
     * and a run). 22 of the first run's 36 IPv6 findings were TLS fingerprints in cert tests.
     */
    // Empty trailing group: a fingerprint longer than 8 bytes backtracks the matcher onto a
    // prefix ending in a colon (`AA:BB:CC:`), so the width test ignores empty groups.
    const groups = value.split(":").filter(Boolean);
    if (!value.includes("::") && groups.every((g) => g.length <= 2)) continue;
    const lower = value.toLowerCase();
    if (ALLOWED_IPV6_PREFIXES.some((p) => lower === p || lower.startsWith(p))) continue;
    out.push({ cls: "ipv6", value, column: m.index + 1, rule: "P2:routable-ipv6" });
  }
  return out;
}

/*
 * E1 — e-mail. `128x128@2x.png` is the shape to beat; the TLD list does it.
 */
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.([A-Za-z]{2,24}))(?![A-Za-z0-9-])/g;

function findEmails(line) {
  const out = [];
  EMAIL_RE.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE.exec(line)) !== null) {
    const [value, , domain, tld] = m;
    const t = tld.toLowerCase();
    if (RESERVED_TLDS.has(t)) continue;
    if (!KNOWN_TLDS.has(t)) continue;                 // .png, .zip, … never reach here
    if (RESERVED_DOMAINS.has(registrable(domain))) continue;
    if (/^(noreply|no-reply)@/i.test(value) && ALLOWED_DOMAINS.has(registrable(domain))) continue;
    out.push({ cls: "email", value, column: m.index + 1, rule: "E1:non-documentation-email" });
  }
  return out;
}

/** True when position `idx` on `line` is inside a string literal or a comment. */
function inStringOrComment(line, idx, ext) {
  const before = line.slice(0, idx);
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (HASH_COMMENT_EXTS.has(ext) && trimmed.startsWith("#")) return true;
  const lineComment = before.indexOf("//");
  if (lineComment !== -1) return true;
  if (before.includes("/*")) return true;
  // Unbalanced quote before the match ⇒ the match is inside the literal.
  for (const q of ['"', "'", "`"]) {
    const n = (before.match(new RegExp(`(?<!\\\\)\\${q}`, "g")) || []).length;
    if (n % 2 === 1) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNING
// ═══════════════════════════════════════════════════════════════════════════════

function scanLines(text, relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const findings = [];
  const exceptions = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 4000) continue; // minified or generated; not authored prose
    const hits = [
      ...findAccountNames(line),
      ...findHostnames(line, ext),
      ...findIPv4(line),
      ...findIPv6(line),
      ...findEmails(line),
    ];
    if (hits.length === 0) continue;
    const ex = EXCEPTION_RE.exec(line);
    if (ex) {
      // A marker WITHOUT a reason does not suppress anything (EXCEPTION_RE demands one). An
      // exception has to stay a decision somebody made and signed, not a reflex.
      for (const h of hits) exceptions.push({ file: relPath, line: i + 1, value: h.value, reason: ex[1] });
      continue;
    }
    for (const h of hits) findings.push({ file: relPath, line: i + 1, ...h });
  }
  return { findings, exceptions };
}

/** Scan one blob of text as if it lived at `relPath`. Returns findings only. */
function scanText(text, relPath) {
  return scanLines(text, relPath).findings;
}

function inScope(rel) {
  const p = rel.replace(/\\/g, "/");
  if (SKIP_PREFIXES.some((s) => p.startsWith(s))) return false;
  if (p.split("/").some((seg) => SKIP_SEGMENTS.has(seg))) return false;
  if (SKIP_BASENAMES.has(path.basename(p))) return false;
  if (SKIP_EXTS.has(path.extname(p).toLowerCase())) return false;
  if (SCAN_ROOT_FILES.includes(p)) return true;
  return SCAN_PREFIXES.some((s) => p.startsWith(s));
}

function listTracked(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function walk(dir, root, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (SKIP_SEGMENTS.has(e.name)) continue;
      if (SKIP_PREFIXES.some((s) => (rel + "/").startsWith(s))) continue;
      walk(abs, root, acc);
    } else if (e.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

/**
 * Scan a whole tree.
 * `useGit` (default true) lists TRACKED files: a push carries commits, so an untracked file
 * cannot reach the release branch, and build output never has to be excluded by name.
 */
function scanTree(root, opts = {}) {
  const useGit = opts.useGit !== false;
  const candidates = (useGit ? listTracked(root) : walk(root, root, [])).filter(inScope);
  const findings = [];
  const exceptions = [];
  let filesScanned = 0;
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // listed but absent (a deletion staged, a broken link) — nothing to publish
    }
    if (buf.includes(0)) continue; // binary by content, whatever the extension claims
    filesScanned += 1;
    const r = scanLines(buf.toString("utf8"), rel);
    findings.push(...r.findings);
    exceptions.push(...r.exceptions);
  }
  // `files` is what the baseline needs to tell «this row died» from «this row's file stayed home»
  // — see STORY_TIER below.
  return { findings, exceptions, filesScanned, files: candidates };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASELINE — the accepted findings that were already in the tree
//
// WHY A BASELINE AND NOT A SCRUB
//   The rule this gate enforces is «only documentation-reserved names are allowed», because no
//   script can tell a real server name from an invented `foo.win`  pii-gate-allow: invented example
//   — they have the same shape and differ only in whether a machine answers.
//   That rule is right for NEW and CHANGED code, which is where a real leak arrives. Applied
//   backwards to the whole tree it would mean rewriting hundreds of harmless invented literals
//   (`1.2.3.4`, `evil.com`, `foo@bar.com`)  pii-gate-allow: invented literals, named as examples
//   and the assertions around them, in files nobody asked to change, for no gain in safety. That
//   attempt was made once and abandoned 580 edits deep.
//
//   So the existing findings are recorded here instead: an explicit, checked-in list of accepted
//   debt. It is NOT a silencer. It is greppable, reviewable, and pinned tightly enough that the
//   same pattern appearing somewhere NEW still fails.
//
// THE FOUR PROPERTIES THAT MAKE IT A REGISTER RATHER THAN A MUTE BUTTON
//   1. Pinned by (class, file, value) and by COUNT. A new value fails. A known value in a new file
//      fails. One more occurrence of a known value in a known file fails. There are no line
//      numbers anywhere in the file, so editing a source file never churns the baseline — an
//      added line is always an added exception, never «one line moved».
//   2. Every VALUE needs a written reason. `--write-baseline` cannot invent one: it writes
//      `TODO: …` for anything new, and this gate REFUSES a baseline that still says TODO. So
//      regenerating does not make the gate green; a human has to type why the value is safe.
//   3. It must shrink, never drift. A baseline entry the scan no longer finds is an ERROR, not a
//      courtesy — dead debt in a debt register is how the register stops being read.
//   4. It is sorted and one-finding-per-line, so `git diff` shows an added exception as a single
//      `+` line naming the class, the file and the value.
//
// REGENERATE ON PURPOSE:  node scripts/pii-gate.cjs --write-baseline
// ═══════════════════════════════════════════════════════════════════════════════

const BASELINE_BASENAME = "pii-baseline.txt";
const TODO_PREFIX = "TODO";

/*
 * Key separator. NUL, not a space: an account name can be two words («All Users») and a repository
 * path is allowed to contain one, so any printable separator can be produced by the data it joins
 * and would silently mis-split the key back apart.
 */
const SEP = "\u0000";
const bkey = (cls, file, value) => `${cls}${SEP}${file}${SEP}${value}`;

const BASELINE_HEADER = `# pii-baseline.txt — findings that were already in the tree when the PII gate was adopted.
#
# THIS FILE IS A DEBT REGISTER, NOT A SILENCER. Every line is a value the gate found and a human
# accepted. Regenerate it deliberately with:
#
#     node scripts/pii-gate.cjs --write-baseline
#
# and then WRITE THE REASONS — a value whose reason still starts with "${TODO_PREFIX}" is refused, so a
# blind regenerate cannot turn the gate green. The list must shrink over time: an entry the scan no
# longer finds is reported as stale, and the gate stays red until the file is regenerated.
#
# What still FAILS even though a value is listed here:
#   * the same value in a file that is not listed for it
#   * one more occurrence of it in a file that is
#   * any value not listed at all
#
# Format — two sections, both sorted, no line numbers anywhere (so a source edit never moves a
# line here, and an added line is always an added exception):
#
#   [reasons]  value | why this value identifies nobody
#   [entries]  class | file | value | occurrences
`;

/** Parse a baseline file. Returns `{ reasons: Map, entries: Map, present: boolean }`. */
function parseBaseline(text) {
  const reasons = new Map();
  const entries = new Map();
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[reasons]" || line === "[entries]") {
      section = line;
      continue;
    }
    const cols = line.split("|").map((c) => c.trim());
    if (section === "[reasons]" && cols.length >= 2) {
      reasons.set(cols[0], cols.slice(1).join(" | "));
    } else if (section === "[entries]" && cols.length === 4) {
      entries.set(bkey(cols[0], cols[1], cols[2]), Number(cols[3]));
    }
  }
  return { reasons, entries, present: true };
}

function readBaseline(root) {
  const p = path.join(root, "scripts", BASELINE_BASENAME);
  if (!fs.existsSync(p)) return { reasons: new Map(), entries: new Map(), present: false };
  return parseBaseline(fs.readFileSync(p, "utf8"));
}

/** Group findings into the baseline's key space: `class\0file\0value` -> occurrences. */
function tally(findings) {
  const m = new Map();
  for (const f of findings) {
    const k = bkey(f.cls, f.file.replace(/\\/g, "/"), f.value);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/*
 * The story tier — files the publication ritual deliberately leaves at home (CLAUDE.md § «Что НЕ
 * идёт на release»): stories, MDX docs, `.storybook/`, `_story/`, and the four demo/mock hosts that
 * live outside `_story/`.
 *
 * WHY THE BASELINE NEEDS TO KNOW ABOUT THEM
 *   The scan covers them on purpose (see SCOPE), so the baseline carries rows for them. The
 *   baseline file itself travels to the release branch — CI runs this gate there. On that tree the
 *   story files are absent BY DESIGN, and without this list every one of their rows read as stale,
 *   so obeying the ritual turned every release CI run red. Measured: 13 of the first baseline's 158
 *   rows sit in 8 story-tier files; the first release-shaped run would have failed on all 13.
 *
 * WHY THE EXEMPTION IS THIS NARROW
 *   It applies only to a tree that carries NO story-tier file at all — a release tree. On the
 *   working tree the tier is present, so a story file that really disappeared still leaves a stale
 *   row there, and the register keeps shrinking where it is maintained. Any other absent file stays
 *   stale everywhere: a deleted source file is dead debt on every branch.
 */
const STORY_TIER = [
  /\.stories\.tsx$/,
  /\.mdx$/,
  /^gui-pro\/\.storybook\//,
  /\/_story\//,
  /^gui-pro\/src\/components\/connection\/connection(Demos\.tsx|Mocks\.ts)$/,
  /^gui-pro\/src\/components\/wizard\/wizardStory(Host\.tsx|State\.ts)$/,
];

const isStoryTier = (p) => STORY_TIER.some((re) => re.test(p.replace(/\\/g, "/")));

/**
 * Compare a scan against a baseline.
 *
 * `unaccepted` are the findings that must fail the gate. `stale` and `unreasoned` are baseline
 * DEFECTS — they also fail, because a register that quietly carries dead or unexplained rows is a
 * register nobody rereads. `leftHome` are story-tier rows on a tree without the story tier — not a
 * defect, reported so the exemption is visible rather than silent.
 *
 * `opts.files` is the list of files the scan looked at. Without it no tree shape is known, and
 * every missing row is stale — the strict reading, and the one the unit arms above rely on.
 */
function applyBaseline(findings, baseline, opts = {}) {
  const releaseShaped = Array.isArray(opts.files) && !opts.files.some(isStoryTier);
  const actual = tally(findings);
  const unaccepted = [];
  const grown = [];
  for (const [key, n] of actual) {
    const [cls, file, value] = key.split(SEP);
    const allowed = baseline.entries.get(key);
    if (allowed === undefined) {
      unaccepted.push({ cls, file, value, count: n });
    } else if (n > allowed) {
      grown.push({ cls, file, value, was: allowed, now: n });
    }
  }
  const stale = [];
  const leftHome = [];
  for (const [key, n] of baseline.entries) {
    const [cls, file, value] = key.split(SEP);
    const now = actual.get(key) || 0;
    if (now >= n) continue;
    if (now === 0 && releaseShaped && isStoryTier(file)) leftHome.push({ cls, file, value, was: n });
    else stale.push({ cls, file, value, was: n, now });
  }
  const unreasoned = [];
  const listedValues = new Set([...baseline.entries.keys()].map((k) => k.split(SEP)[2]));
  for (const value of listedValues) {
    const r = baseline.reasons.get(value);
    if (!r) unreasoned.push({ value, why: "no reason line" });
    else if (r.startsWith(TODO_PREFIX)) unreasoned.push({ value, why: `reason still says «${r}»` });
  }
  const orphanReasons = [...baseline.reasons.keys()].filter((v) => !listedValues.has(v));
  return { unaccepted, grown, stale, leftHome, unreasoned, orphanReasons, accepted: baseline.entries.size };
}

/** Render a baseline file, carrying forward every reason a human already wrote. */
function formatBaseline(findings, previous) {
  const actual = tally(findings);
  const rows = [...actual].map(([key, n]) => {
    const [cls, file, value] = key.split(SEP);
    return { cls, file, value, n };
  });
  rows.sort((a, b) =>
    a.cls.localeCompare(b.cls) || a.file.localeCompare(b.file) || a.value.localeCompare(b.value)
  );
  const values = [...new Set(rows.map((r) => r.value))].sort();
  const out = [BASELINE_HEADER, "", "[reasons]"];
  for (const v of values) {
    const kept = previous.reasons.get(v);
    out.push(`${v} | ${kept && !kept.startsWith(TODO_PREFIX) ? kept : `${TODO_PREFIX}: state why this value identifies nobody`}`);
  }
  out.push("", "[entries]");
  for (const r of rows) out.push(`${r.cls} | ${r.file} | ${r.value} | ${r.n}`);
  out.push("");
  return out.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELF-CHECK — a detector edited into inertness must turn this RED, not green
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * Every positive fixture is SYNTHETIC. A gate that carries a real leaked value in its own source
 * as a test vector republishes the very thing it exists to remove — so the IPv4 here is the
 * address IANA publishes for example.com, and the IPv6 is one hex digit off the RFC 3849
 * documentation prefix (which makes it unallocated, hence detectable, and identifies nobody).
 *
 * Each fixture line ends with the gate's OWN inline marker, because `scripts/` is in scan scope
 * and these five lines are leak shapes by construction — without the markers this file reports
 * five findings against itself. The marker is used rather than a basename skip on purpose: a skip
 * would also blind the gate to every FUTURE line of this file, and a leak detector nobody is
 * allowed to scan is how the leaked values reached the public branch to begin with.
 */
const SELF_CHECK = [
  ["account-name", String.raw`// C:\Users\jdoe9\AppData\Local`, String.raw`// C:\Users\Public\Desktop`], // pii-gate-allow: self-check fixture — an invented account name
  ["hostname", '  let h = "somebox.win";', '  let h = "sni.example.com";'], // pii-gate-allow: self-check fixture — an invented host under a real gTLD
  ["ipv4", '  let ip = "93.184.216.34";', '  let ip = "203.0.113.9";'], // pii-gate-allow: self-check fixture — the address IANA published for example.com
  ["ipv6", '  let ip = "2001:db9:5:21::1";', '  let ip = "2001:db8::1";'], // pii-gate-allow: self-check fixture — one hex digit off RFC 3849, so unallocated
  ["email", '  let e = "jdoe9@gmail.com";', '  let e = "you@example.com";'], // pii-gate-allow: self-check fixture — an invented mailbox at a real provider
];

function selfCheck() {
  const broken = [];
  for (const [cls, positive, negative] of SELF_CHECK) {
    const pos = scanText(positive, "gui-pro/src-tauri/src/selfcheck.rs").filter((f) => f.cls === cls);
    const neg = scanText(negative, "gui-pro/src-tauri/src/selfcheck.rs");
    if (pos.length === 0) broken.push(`${cls}: detector did not fire on its own fixture «${positive.trim()}»`);
    if (neg.length !== 0) broken.push(`${cls}: detector fired on its clean fixture «${negative.trim()}»`);
  }
  return broken;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

const LABEL = {
  "account-name": "Windows account name / absolute user path",
  hostname: "hostname outside the documentation + vendor allowlist",
  ipv4: "routable IPv4 address",
  ipv6: "routable IPv6 address",
  email: "e-mail outside the reserved documentation domains",
};

const REMEDY = [
  "Replace each with a documentation-reserved equivalent (example.com, 203.0.113.x,",
  "2001:db8::/32, C:\\Users\\<user>\\…). If a literal is genuinely required, mark that",
  "line `pii-gate-allow: <reason>` — the reason is mandatory and greppable.",
  "",
  "These findings are NEW — they are not in scripts/pii-baseline.txt. The baseline records",
  "what was already in the tree when this gate was adopted; it is deliberately not a place to",
  "put new work. If one of these really belongs there, add it on purpose:",
  "    node scripts/pii-gate.cjs --write-baseline    (then write the reason it asks you for)",
];

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const verbose = args.includes("--verbose");
  const write = args.includes("--write-baseline");
  // --no-git: walk the directory instead of asking git what is tracked. For a tree that is not a
  // checkout — `git archive <commit> | tar -x` of the exact commit about to be pushed, which is
  // the one tree whose verdict actually matters at publication time.
  const useGit = !args.includes("--no-git");
  const root = path.resolve(args.filter((a) => !a.startsWith("--"))[0] || path.join(__dirname, ".."));

  const broken = selfCheck();
  if (broken.length) {
    console.error("PII GATE IS BROKEN — its own detectors failed their fixtures:");
    for (const b of broken) console.error(`  ${b}`);
    console.error("Exit 2: this is a gate defect, not a clean tree.");
    return 2;
  }

  let res;
  try {
    res = scanTree(root, { useGit });
  } catch (e) {
    console.error(`PII GATE COULD NOT RUN: ${e && e.message}`);
    return 2;
  }

  const baseline = readBaseline(root);

  if (write) {
    const target = path.join(root, "scripts", BASELINE_BASENAME);
    const text = formatBaseline(res.findings, baseline);
    fs.writeFileSync(target, text, "utf8");
    const todo = (text.match(new RegExp(`\\| ${TODO_PREFIX}:`, "g")) || []).length;
    console.log(`pii-gate: wrote ${target}`);
    console.log(`  ${tally(res.findings).size} accepted finding(s) across ${new Set(res.findings.map((f) => f.file)).size} file(s)`);
    if (todo) {
      console.log(`  ${todo} value(s) still say ${TODO_PREFIX}. The gate REFUSES a baseline with a`);
      console.log("  TODO reason, so regenerating on its own cannot make it green — write the");
      console.log("  reasons, or scrub the values instead of accepting them.");
      return 1;
    }
    console.log("  every value carries a written reason.");
    return 0;
  }

  const cmp = applyBaseline(res.findings, baseline, { files: res.files });

  if (json) {
    console.log(JSON.stringify({ ...res, baseline: cmp }, null, 2));
    return cmp.unaccepted.length || cmp.grown.length || cmp.stale.length || cmp.unreasoned.length ? 1 : 0;
  }

  console.log(`pii-gate: ${res.filesScanned} published files scanned under ${root}`);
  if (res.exceptions.length) {
    console.log(`  inline exceptions in use: ${res.exceptions.length}`);
    for (const e of res.exceptions) console.log(`    ${e.file}:${e.line}  «${e.value}» — ${e.reason}`);
  }
  if (baseline.present) {
    console.log(`  baselined findings accepted: ${cmp.accepted} (scripts/${BASELINE_BASENAME})`);
  } else {
    console.log(`  no scripts/${BASELINE_BASENAME} — every finding below is treated as new`);
  }
  if (verbose) for (const c of Object.keys(LABEL)) {
    console.log(`  ${c}: ${res.findings.filter((f) => f.cls === c).length}`);
  }

  let failed = false;

  if (cmp.unaccepted.length || cmp.grown.length) {
    failed = true;
    const total = cmp.unaccepted.reduce((n, u) => n + u.count, 0) + cmp.grown.length;
    console.log("");
    console.log(`FOUND ${total} value(s) that must not reach the public repository:`);
    for (const cls of Object.keys(LABEL)) {
      const group = cmp.unaccepted.filter((f) => f.cls === cls);
      if (!group.length) continue;
      console.log(`\n  ${LABEL[cls]} (${group.length}):`);
      for (const u of group) {
        // Line numbers come from the scan, not the baseline — the baseline never stores one.
        const where = res.findings
          .filter((f) => f.cls === u.cls && f.file.replace(/\\/g, "/") === u.file && f.value === u.value)
          .map((f) => `${f.line}:${f.column}`)
          .join(", ");
        console.log(`    ${u.file}  ${u.value}   (line ${where})`);
      }
    }
    for (const g of cmp.grown) {
      console.log(`\n  MORE OCCURRENCES than the baseline accepts:`);
      console.log(`    ${g.file}  ${g.value}   baseline ${g.was}, now ${g.now}`);
    }
    console.log("");
    for (const l of REMEDY) console.log(l);
  }

  if (cmp.unreasoned.length) {
    failed = true;
    console.log("");
    console.log(`BASELINE REFUSED — ${cmp.unreasoned.length} value(s) carry no written reason:`);
    for (const u of cmp.unreasoned) console.log(`    ${u.value} — ${u.why}`);
    console.log("An exception nobody explained is an exception nobody reviewed. Fill the reason in");
    console.log(`  scripts/${BASELINE_BASENAME}, or scrub the value instead of accepting it.`);
  }

  if (cmp.stale.length) {
    failed = true;
    console.log("");
    console.log(`BASELINE IS STALE — ${cmp.stale.length} entr(ies) the scan no longer finds:`);
    for (const s of cmp.stale) console.log(`    ${s.file}  ${s.value}   baseline ${s.was}, now ${s.now}`);
    console.log("Good news, and it still fails: dead rows in a debt register are how the register");
    console.log("stops being read. Shrink it: node scripts/pii-gate.cjs --write-baseline");
  }

  if (cmp.leftHome.length) {
    console.log("");
    console.log(`  note: ${cmp.leftHome.length} baseline row(s) belong to the story tier, which this tree`);
    console.log("  does not carry (a release tree) — left at home by the ritual, not stale.");
  }

  if (cmp.orphanReasons.length) {
    console.log("");
    console.log(`  note: ${cmp.orphanReasons.length} reason line(s) describe values no entry uses —`);
    console.log("  harmless, and `--write-baseline` drops them.");
  }

  if (!failed) {
    console.log("RESULT: PASS — no personal data on the publication path beyond the accepted baseline.");
    return 0;
  }
  console.log("RESULT: FAILURE");
  return 1;
}

module.exports = {
  scanText,
  scanTree,
  selfCheck,
  inScope,
  parseBaseline,
  applyBaseline,
  formatBaseline,
  KNOWN_TLDS,
  ALLOWED_DOMAINS,
};

if (require.main === module) process.exit(main(process.argv));
