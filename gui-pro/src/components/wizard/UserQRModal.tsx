import { Loader2, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../shared/ui/Modal";

interface UserQRModalProps {
  qrUser: string | null;
  qrLink: string;
  qrLoading: boolean;
  onClose: () => void;
}

export function UserQRModal({ qrUser, qrLink, qrLoading, onClose }: UserQRModalProps) {
  const { t } = useTranslation();

  return (
    <Modal isOpen={!!qrUser} onClose={onClose} closeOnBackdrop>
      <div className="max-w-xs w-full mx-4 p-6 rounded-2xl shadow-2xl text-center bg-[var(--color-bg-elevated)]">
        {qrLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--color-accent-500)]" />
          </div>
        ) : qrLink ? (
          <>
            <div className="flex justify-center mb-4">
              {/* opacity stays in style (not a color/bg/border) — fgColor=currentColor inherits
                  the token text color from the className below. */}
              <QRCodeSVG value={qrLink} size={200} bgColor="transparent" fgColor="currentColor" level="M" className="text-[var(--color-text-primary)]" style={{ opacity: 0.85 }} />
            </div>
            <p className="text-xs font-medium mb-1 text-[var(--color-text-primary)]">{qrUser}</p>
            <p className="text-xs text-[var(--color-text-muted)]">{t("server.export.scan_qr")}</p>
          </>
        ) : null}
        <button onClick={onClose} className="absolute top-3 right-3 p-1 rounded-full transition-opacity hover:opacity-70 text-[var(--color-text-muted)]">
          <X className="w-4 h-4" />
        </button>
      </div>
    </Modal>
  );
}
