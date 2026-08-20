#!/bin/sh
# i18n-dead-keys.sh — the coverage gate T-42 asked for (.planning/BACKLOG.md, bucket A).
#
# THE PROBLEM IT EXISTS FOR
#   gui-pro/src/shared/i18n/i18n.test.ts checks ru-en PARITY and nothing else. Parity
#   says the two bundles agree; it says nothing about whether the app still uses what
#   they agree on. So a key whose screen was deleted stays green forever, and a key
#   deleted from BOTH bundles also stays green. Phase 25 removed two such blocks by
#   hand (14 + 19 keys) precisely because no gate could see them.
#
# WHAT IT DOES
#   Derives two sets and compares them.
#
#     KEYS        every leaf key of gui-pro/src/shared/i18n/locales/ru.json, flattened
#                 to dotted form (server.cert.title). en.json is flattened too and the
#                 two leaf counts are reported side by side — a mismatch is i18n.test.ts's
#                 job to fail, but seeing it here stops this gate being read as parity.
#     REFERENCED  every key the tree can be shown to reach. FOUR independent rules, and
#                 each one exists because a key it rescues would otherwise be deleted:
#
#                   1. LITERAL   the dotted key occurs as a substring anywhere in the
#                                corpus (see WHAT COUNTS AS CORPUS). Substring, not a
#                                t("...") call pattern, deliberately: keys also travel as
#                                object fields (tooltipKey: "server.config..."), as props
#                                (labelKey), through lookup tables (CORE_MESSAGE_I18N in
#                                vpnEventHelpers.ts), and are read as property paths in
#                                tests (ru.messages.foo). Matching the literal catches
#                                every one of those; matching t( would catch none.
#                   2. PLURAL    i18next appends a CLDR suffix at lookup time, so
#                                t("drop.configs_added", { count }) reaches
#                                drop.configs_added_one / _few / _many / _other, none of
#                                which is ever written down anywhere. A key whose base —
#                                after stripping one such suffix — is referenced is live.
#                   3. DYNAMIC   a key built as a template literal, t(`routing.${b}Title`).
#                                The prefix in front of the first ${ is taken as live,
#                                AND SO IS EVERYTHING BELOW IT. That is deliberately
#                                blunt: the interpolated value is a runtime variable, so
#                                the honest statement is "some member of this subtree is
#                                reached and this script cannot tell which". Narrowing it
#                                to the shape of the rest of the literal would delete real
#                                keys the first time someone changed the variable.
#                   4. ALLOWED   the explicit allow-list below, one commented entry per
#                                reason. For anything rules 1-3 structurally cannot see.
#
#   A key matched by none of the four is reported as DEAD and fails the gate.
#
# WHAT COUNTS AS CORPUS — AND WHY THE BACKEND IS IN IT
#   . gui-pro/src/**             .ts .tsx .js .jsx .mdx, minus the locale files themselves
#                                (a key obviously occurs in its own bundle). Tests and
#                                Storybook stories ARE scanned: a key used only by a story
#                                is still a key something renders, and dropping it would
#                                break npm run storybook on the next run.
#   . gui-pro/src-tauri/src/**   .rs. NOT optional. commands/updater.rs emits progress
#                                stage keys as bare strings — emit("download", 5,
#                                "update.connecting") — which the frontend hands straight
#                                to t(). Five keys (update.connecting, .launching,
#                                .preparing, .starting, .verifying) exist ONLY there.
#                                A frontend-only scan calls all five dead, and deleting
#                                them puts raw key names in the updater progress line.
#   . gui-pro/*.html             the three webview entry documents.
#
# HEURISTIC ON THE REFERENCE SIDE — READ THIS BEFORE TRUSTING A DEAD VERDICT
#   The rules above are static. Twenty-seven call sites pass a VARIABLE to t()
#   (t(key), t(err), t(tab.labelKey), ...). Every one of them was traced by hand for
#   T-42 and every one is fed from a literal that rule 1 sees — but that is a fact about
#   the tree as it stands today, not a property this script enforces. If a future change
#   assembles a key from parts ("server." + section), or reads one from disk, this gate
#   will call the result dead and be wrong. Add it to the allow-list with a reason rather
#   than weakening a rule.
#
#   The converse is the cheap failure and is fine: a key spared by rule 3 may well be
#   dead. Rule 3's rescues are printed as their own section for exactly that reason —
#   they are a hand-audit queue, never a clean bill of health.
#
# WHY NODE AND NOT PURE SED
#   Flattening nested JSON to dotted paths with sed means depending on the file's current
#   indentation, which nobody has promised to keep. Node is already a hard build
#   dependency of this repository (CI installs it before it can run anything else), so
#   the set math runs there. Everything else about this script — POSIX sh, read-only, no
#   network, no installs, no temp files, sections then summary, exit code as the contract
#   — follows scripts/command-registry-audit.sh.
#
# USAGE
#   sh scripts/i18n-dead-keys.sh          # this wrapper, from anywhere
#   npm run i18n:check                    # from gui-pro/ (also part of npm run prerelease)
#   Paths resolve from the script's own location, not the caller's cwd. The npm entry
#   point calls the .cjs directly rather than going through this wrapper, because `sh`
#   is not on PATH for npm scripts on a stock Git-for-Windows install and the owner runs
#   `npm run prerelease` there. Both entry points reach the same file, so neither can
#   drift into checking something different.
#
# EXIT CODE
#   0 = every locale key is reachable by one of the four rules
#   1 = at least one key is reachable by none of them; each is listed
#
# SCOPE / SAFETY
#   Read-only. It never edits a locale file — deleting a key is a human decision made
#   with this report in hand.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

RU="$ROOT/gui-pro/src/shared/i18n/locales/ru.json"
EN="$ROOT/gui-pro/src/shared/i18n/locales/en.json"

if [ ! -f "$RU" ] || [ ! -f "$EN" ]; then
  echo "FAIL: locale bundles not found under $ROOT/gui-pro/src/shared/i18n/locales" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required (it flattens the locale JSON — see WHY NODE AND NOT PURE SED)" >&2
  exit 1
fi

node "$SCRIPT_DIR/i18n-dead-keys.cjs" "$ROOT"
exit $?
