/**
 * CertIcons.tsx — inline cert-type icons for the EndpointStep TLS-certificate cards.
 *
 * UAT (06-uat fix 2): the three cert cards previously had INCONSISTENT icons
 * (Let's Encrypt = Lucide CheckCircle2, Self-signed = none, Custom = Lucide FileKey).
 * The user supplied a matched MingCute SVG set so all three cards share one visual
 * family. The project's Lucide-only rule is explicitly WAIVED by the user for these
 * three cert icons only.
 *
 * Each icon uses `fill="currentColor"` so the color is driven by the caller's text
 * token class (success/warning/muted), and renders at the same `w-4 h-4` size as the
 * Lucide icons it replaces. viewBox is kept at 0 0 24 24 to match Lucide sizing.
 */

type IconProps = { className?: string };

/** Let's Encrypt — a checkmark badge (rendered green by the caller). */
export function CertLetsEncryptIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M10.586 2.1a2 2 0 0 1 2.7-.116l.128.117L15.314 4H18a2 2 0 0 1 1.994 1.85L20 6v2.686l1.9 1.9a2 2 0 0 1 .116 2.701l-.117.127l-1.9 1.9V18a2 2 0 0 1-1.85 1.995L18 20h-2.685l-1.9 1.9a2 2 0 0 1-2.701.116l-.127-.116l-1.9-1.9H6a2 2 0 0 1-1.995-1.85L4 18v-2.686l-1.9-1.9a2 2 0 0 1-.116-2.701l.116-.127l1.9-1.9V6a2 2 0 0 1 1.85-1.994L6 4h2.686zm4.493 6.883l-4.244 4.244l-1.768-1.768a1 1 0 0 0-1.414 1.415l2.404 2.404a1.1 1.1 0 0 0 1.556 0l4.88-4.881a1 1 0 0 0-1.414-1.414"
      />
    </svg>
  );
}

/** Self-signed — a shield/server glyph (rendered yellow by the caller). */
export function CertSelfSignedIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M19 11a3 3 0 0 1 2 5.236v4.955a.5.5 0 0 1-.724.447L19 21l-1.276.638a.5.5 0 0 1-.724-.447v-4.955A3 3 0 0 1 19 11m1-7a2 2 0 0 1 2 2v4a5 5 0 0 0-7 7v3H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 13H6a1 1 0 1 0 0 2h2a1 1 0 1 0 0-2m4-4H6a1 1 0 0 0-.117 1.993L6 11h6a1 1 0 0 0 .117-1.993z"
      />
    </svg>
  );
}

/** Custom / provided cert — a file-with-key glyph (rendered neutral/muted by the caller). */
export function CertProvidedIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M13.586 2A2 2 0 0 1 15 2.586L19.414 7A2 2 0 0 1 20 8.414V20a2 2 0 0 1-2 2h-5a1 1 0 1 1 0-2h5V10h-4.5A1.5 1.5 0 0 1 12 8.5V4H6v4a1 1 0 0 1-2 0V4a2 2 0 0 1 2-2zM7 10a4 4 0 0 1 3 6.646v4.192a1.1 1.1 0 0 1-1.592.984L7 21.118l-1.408.704A1.1 1.1 0 0 1 4 20.838v-4.192A4 4 0 0 1 7 10m1 7.874a4 4 0 0 1-2 0v1.508l.553-.276a1 1 0 0 1 .894 0l.553.276zM7 12a2 2 0 1 0 0 4a2 2 0 0 0 0-4m7-7.586V8h3.586z"
      />
    </svg>
  );
}
