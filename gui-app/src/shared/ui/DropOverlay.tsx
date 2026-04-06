import { useTranslation } from "react-i18next";

interface DropOverlayProps {
  isDragging: boolean;
}

export function DropOverlay({ isDragging }: DropOverlayProps) {
  const { t } = useTranslation();

  if (!isDragging) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        backgroundColor: "rgba(0, 0, 0, 0.4)",
        transition: "opacity 150ms ease",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "12px",
          color: "#fff",
          fontSize: "18px",
          fontWeight: 500,
          textShadow: "0 1px 4px rgba(0,0,0,0.5)",
        }}
      >
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>{t("drop.overlay_text", "Drop file here")}</span>
        <span
          style={{
            fontSize: "13px",
            fontWeight: 400,
            opacity: 0.7,
          }}
        >
          {t("drop.overlay_hint", ".toml — VPN config, .json — routing rules")}
        </span>
      </div>
    </div>
  );
}
