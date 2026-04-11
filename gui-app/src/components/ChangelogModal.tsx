import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-shell";
import { Modal } from "../shared/ui/Modal";

type CP = { children?: ReactNode };

interface ChangelogModalProps {
  open: boolean;
  onClose: () => void;
  version: string;
  releaseNotes: string;
}

export function ChangelogModal({ open: isOpen, onClose, version, releaseNotes }: ChangelogModalProps) {
  const { t } = useTranslation();

  return (
    <Modal open={isOpen} onClose={onClose} closeOnBackdrop closeOnEscape>
      <div
        className="w-full max-w-md rounded-xl overflow-hidden"
        style={{
          backgroundColor: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          width: "448px",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between py-3 px-4"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--color-text-primary)" }}
          >
            {t("modal.changelog_title", { version })}
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded transition-colors hover:opacity-100"
            style={{ color: "var(--color-text-muted)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div
          className="scroll-visible overflow-y-auto p-4"
          style={{ maxHeight: "320px" }}
        >
          <ReactMarkdown
            components={{
              h1: ({ children }: CP) => (
                <h1
                  className="text-sm font-semibold mt-0 mb-2"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {children}
                </h1>
              ),
              h2: ({ children }: CP) => (
                <h2
                  className="text-sm font-semibold mt-3 mb-1.5"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {children}
                </h2>
              ),
              h3: ({ children }: CP) => (
                <h3
                  className="text-xs font-semibold mt-2 mb-1"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {children}
                </h3>
              ),
              p: ({ children }: CP) => (
                <p
                  className="text-xs leading-relaxed mb-2"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {children}
                </p>
              ),
              strong: ({ children }: CP) => (
                <strong
                  className="font-semibold"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  {children}
                </strong>
              ),
              em: ({ children }: CP) => (
                <em className="italic" style={{ color: "var(--color-text-secondary)" }}>
                  {children}
                </em>
              ),
              ul: ({ children }: CP) => (
                <ul className="list-disc pl-4 space-y-0.5 mb-2">{children}</ul>
              ),
              ol: ({ children }: CP) => (
                <ol className="list-decimal pl-4 space-y-0.5 mb-2">{children}</ol>
              ),
              li: ({ children }: CP) => (
                <li className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                  {children}
                </li>
              ),
              hr: () => (
                <hr
                  className="my-3"
                  style={{ borderColor: "var(--color-border)" }}
                />
              ),
              code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
                const isBlock = Boolean(className);
                if (isBlock) {
                  return (
                    <pre
                      className="text-[11px] font-mono p-3 rounded-lg overflow-x-auto mb-2"
                      style={{
                        backgroundColor: "var(--color-bg-elevated)",
                        color: "var(--color-text-primary)",
                      }}
                    >
                      <code>{children}</code>
                    </pre>
                  );
                }
                return (
                  <code
                    className="text-[11px] font-mono px-1 py-0.5 rounded"
                    style={{
                      backgroundColor: "var(--color-bg-hover)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {children}
                  </code>
                );
              },
              a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
                <a
                  href={href}
                  className="underline underline-offset-2 opacity-80 hover:opacity-100 cursor-pointer"
                  style={{ color: "var(--color-accent-500)" }}
                  onClick={(e) => {
                    e.preventDefault();
                    if (href) open(href);
                  }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {releaseNotes}
          </ReactMarkdown>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end py-3 px-4"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <button
            onClick={onClose}
            className="flex items-center justify-center px-3 h-8 rounded-lg text-xs transition-colors"
            style={{
              backgroundColor: "var(--color-bg-hover)",
              color: "var(--color-text-primary)",
            }}
          >
            {t("buttons.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default ChangelogModal;
