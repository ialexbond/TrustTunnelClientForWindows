import { buildVersionLabel } from "../../shared/utils/buildVersionLabel";

export interface AboutHeroProps {
  /** The installed version, without the build suffix. */
  version: string;
  /**
   * The build suffix, exactly as it was injected at build time. Required rather than defaulted,
   * because the two states this block has to show — a label WITH a build suffix and the documented
   * fallback WITHOUT one — differ only in this value, and a default would hide one of them.
   */
  buildHash: string;
}

/**
 * The hero: logo, wordmark with the PRO badge, and the version chip carrying the build label.
 *
 * Ported from the story tier's own drawing of this band. Before the port the same markup lived
 * inline in `AboutPanel` as a narrow centred stack with the label set two sizes smaller; the
 * geometry below is the design's, lifted rather than redrawn. The drawing it was lifted from has
 * since been deleted, because the showcase now renders THIS component — the screen and the showcase
 * cannot drift apart when there is only one of them.
 *
 * It is a BAND, not a card. It spans the whole column, sits on its own background step and carries
 * a wider vertical rhythm than the cards below it, so the eye reads it as the screen's header
 * rather than as the first item of the stack. The emphasis is fill plus spacing only — no edge, no
 * ring, no glow.
 *
 * WHY THE CHIP IS PLAIN, AND WHY IT IS NOT SMALL.
 *
 * The chip is the only place in the application that states WHICH BUILD is installed. Verifying a
 * build means reading that string off the screen and comparing it, character by character, against
 * one quoted elsewhere — so anything that shortens it, hides it behind a hover, or replaces it with
 * a copy button breaks the check rather than improving it. The label is therefore produced by the
 * application's own pure helper (which appends the suffix when a hash was injected and falls back
 * to the bare version when it was not), rendered in the monospace face at the same text size as
 * card body copy, and kept on one line.
 */
export function AboutHero({ version, buildHash }: AboutHeroProps) {
  const versionLabel = buildVersionLabel(version, buildHash);

  return (
    // NO SHELL, ON PURPOSE (G-30-17a). This block carried the card shell — radius, border and
    // `bg-elevated` — which is the exact treatment the two cards below it use, so in the column it
    // read as a third card rather than as the screen's masthead. The spec says the opposite in as
    // many words: «полоса во всю ширину, А НЕ КАРТОЧКА… читается как шапка экрана, а не как ещё
    // один блок в общем столбце», and states the principle plainly for the footer — the least
    // important block must not weigh the same as the update card, so it gets no backdrop and no
    // border. The footer already obeyed that; this was the one place it was not applied.
    // The air stays: padding is unchanged, so the masthead still breathes more freely than the
    // cards without borrowing their shell to do it.
    <div className="flex w-full flex-col items-center gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-7)]">
      <div className="flex flex-wrap items-center justify-center gap-[var(--space-4)]">
        {/* The logo pair is theme-swapped by CSS alone (`.only-dark` / `.only-light` keyed on the
            document's theme attribute, see index.css) — so a theme change repaints the mark without
            any component being told about it, and this block never re-renders for a theme. */}
        <img
          src="/logo/shield-dark.svg"
          alt="TrustTunnel"
          width={72}
          height={72}
          className="only-dark shrink-0"
          draggable={false}
        />
        <img
          src="/logo/shield-light.svg"
          alt="TrustTunnel"
          width={72}
          height={72}
          className="only-light shrink-0"
          draggable={false}
        />
        {/* The heading is the flex ROW, not just the wordmark.
            The story-tier drawing had the badge as a SIBLING of the `h1`, which renders the same
            picture but announces the heading as «TrustTunnel» — dropping the one word that says
            WHICH EDITION is installed. In a two-edition product (Pro and Light ship from this same
            repository) that is the part of the name a screen-reader user most needs. Wrapping the
            row makes the accessible name «TrustTunnel PRO» while leaving the geometry untouched:
            same flex container, same `items-start`, same gap. */}
        <h1 className="flex items-start gap-[var(--space-1-5)]">
          {/* Two spans, one word: «Trust» in the primary text colour and «Tunnel» in the accent,
              in the display face. The badge is pinned to the TOP of the wordmark (items-start),
              which is what makes it read as a superscript rather than as a second word. */}
          <span
            className="text-5xl font-bold leading-none tracking-wide"
            style={{ fontFamily: "var(--font-family-display)" }}
          >
            <span style={{ color: "var(--color-text-primary)" }}>Trust</span>
            <span style={{ color: "var(--color-accent-interactive)" }}>Tunnel</span>
          </span>
          <span
            // The same badge treatment the TitleBar's PRO mark uses, one step larger: accent tint
            // behind accent text, small radius, asymmetric padding for optical centring.
            //
            // THE TEXT COLOUR IS --color-accent-on-tint, NOT --color-accent-interactive.
            // This badge shipped with accent-interactive and FAILED WCAG AA in both themes.
            // Measured in the live Storybook with transitions disabled (without that the browser
            // will not re-resolve a var()-derived colour on a data-theme flip and you measure the
            // previous theme): 4.11:1 dark / 3.58:1 light against the composited tint, where the
            // bar is 4.5:1 — 11px bold is NOT WCAG "large text" (large needs >=24px, or >=18.66px
            // bold), so the 3:1 relaxation never applied here. With accent-on-tint: 6.21 / 4.98.
            // --color-accent-fg was tried and rejected: it clears light but leaves dark at 4.41.
            //
            // THIS IS A REPEAT OF R4-F08, WHICH Badge.tsx ALREADY FIXED ONCE (see its `info`
            // variant comment: bright accent-400 on a same-hue transparent fill reads badly).
            // It came back HERE because this badge is a hand-rolled span rather than a <Badge>,
            // so the shared component's hard-won colour pairing never applied to it.
            //
            // WHY IT STAYS A SPAN RATHER THAN BECOMING <Badge>. Badge would carry the colour, but
            // not this shape: it is a full-radius pill at 12px with uppercase tracking and a
            // border on every variant, and it has no accent variant at all. Reusing it here means
            // adding a one-off `accent` variant AND overriding radius, size, padding and border —
            // i.e. fighting the base until nothing of it is left, which distorts the shared
            // component for a single caller. The geometry is also load-bearing: `items-start` plus
            // the asymmetric pt/pb pins the badge as a SUPERSCRIPT on the 48px wordmark's cap
            // height, and it must stay inline inside the <h1> so the heading's accessible name
            // reads «TrustTunnelPRO» (asserted in AboutHero.test.tsx). An honest span with the
            // correct token beats a Badge bent out of shape.
            className="rounded-[var(--radius-sm)] px-[var(--space-2)] pb-[3px] pt-[4px] text-[11px] font-bold leading-none"
            style={{
              backgroundColor: "var(--color-accent-tint-10)",
              color: "var(--color-accent-on-tint)",
            }}
          >
            PRO
          </span>
        </h1>
      </div>

      {/* The build label. `whitespace-nowrap` is load-bearing rather than cosmetic: a wrapped or
          clipped label is a label that can be misread, and misreading it means testing the wrong
          build. It is a plain pill — deliberately not a button, not a tooltip and not truncated.

          The colour is `text-secondary`, NOT `text-muted`. Measured on the rendered story: muted put
          the label at 4.16:1 against the pill in the dark theme and 4.42:1 in the light one — both
          under the 4.5:1 the label's own size needs. The rule this label exists for is that a tester
          reads the hash at a glance and confirms which build is installed; a label that is merely
          present but hard to read fails that rule quietly, which is the worse way to fail it.
          Secondary measures 5.10:1 dark / 5.31:1 light and still reads as a quiet pill rather than
          a heading. Found by the automated pass of the phase UAT.

          This comment travelled with the markup on the phase-30 port ON PURPOSE. The numbers are the
          only record that the token was chosen and not defaulted; without them the cheapest future
          «cleanup» is to dim the label back to muted and undo a measurement nobody would repeat. */}
      <span
        className="whitespace-nowrap rounded-[var(--radius-full)] px-[var(--space-3)] py-[var(--space-1)] font-mono text-sm"
        style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}
      >
        v{versionLabel}
      </span>
    </div>
  );
}
