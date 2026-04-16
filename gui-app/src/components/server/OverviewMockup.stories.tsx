import type { Meta, StoryObj } from "@storybook/react";
import {
  Activity,
  Shield,
  Users,
  Gauge,
  Cpu,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  Clock,
} from "lucide-react";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Badge } from "../../shared/ui/Badge";

/* ═══════════════════════════════════════════════════════
   Phase 13 Overview Mockup — masonry independent cards
   Static mockup for layout approval. No real data.
   ═══════════════════════════════════════════════════════ */

const cardBase = "rounded-[var(--radius-lg)] p-[var(--space-4)] cursor-pointer transition-colors hover:brightness-105";
const cardStyle = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const labelStyle = { color: "var(--color-text-muted)" };
const valueStyle = { color: "var(--color-text-primary)" };
const mutedStyle = { color: "var(--color-text-secondary)" };
const titleClass = "text-base font-[var(--font-weight-semibold)]";
const contentClass = "text-sm";
const smallClass = "text-xs";

function OverviewMockup() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      {/* Masonry — CSS columns for independent sizing */}
      <div
        style={{
          columnCount: 2,
          columnGap: "12px",
        }}
      >
        {/* ── Card 1: Server Status — tall card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <StatusIndicator status="success" size="lg" pulse />
              <span className={titleClass} style={valueStyle}>Работает</span>
            </div>
            <ChevronRight className="w-4 h-4" style={labelStyle} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>Ping</span>
              <Badge variant="success" size="md">
                <Activity className="w-3 h-3" />
                42ms
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>IP</span>
              <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>185.22.153.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>Страна</span>
              <span className={contentClass} style={valueStyle}>🇩🇪 Германия</span>
            </div>
          </div>
        </div>

        {/* ── Card 2: Protocol — medium card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center justify-between mb-3">
            <span className={smallClass} style={labelStyle}>Протокол</span>
            <ChevronRight className="w-4 h-4" style={labelStyle} />
          </div>
          <p className="text-lg font-[var(--font-weight-semibold)]" style={valueStyle}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-3">
            <Badge variant="neutral" size="md">v3.1.0</Badge>
            <Badge variant="success" size="md">Актуальная</Badge>
          </div>
        </div>

        {/* ── Card 3: Security Summary — tall card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <Shield className="w-5 h-5" style={labelStyle} />
              <span className={titleClass} style={valueStyle}>Безопасность</span>
            </div>
            <ChevronRight className="w-4 h-4" style={labelStyle} />
          </div>
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="success" size="md" />
                <span className={contentClass} style={mutedStyle}>Firewall</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="danger" size="md" />
                <span className={contentClass} style={mutedStyle}>Fail2Ban</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-danger-500)" }}>Выключен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="danger" size="md" />
                <span className={contentClass} style={mutedStyle}>SSH-ключ</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-danger-500)" }}>Не настроен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="success" size="md" />
                <span className={contentClass} style={mutedStyle}>TLS</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-success-500)" }}>89 дней</span>
            </div>
          </div>
        </div>

        {/* ── Card 4: Speed Test — medium card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-3">
            <Gauge className="w-5 h-5" style={labelStyle} />
            <span className={titleClass} style={valueStyle}>Скорость</span>
          </div>
          <div className="flex items-center gap-6 mt-2">
            <div className="flex items-center gap-1.5">
              <ArrowDown className="w-4 h-4" style={{ color: "var(--color-success-400)" }} />
              <span className="text-lg font-[var(--font-weight-semibold)]" style={valueStyle}>124</span>
              <span className={contentClass} style={labelStyle}>Мбит/с</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowUp className="w-4 h-4" style={{ color: "var(--color-accent-interactive)" }} />
              <span className="text-lg font-[var(--font-weight-semibold)]" style={valueStyle}>98</span>
              <span className={contentClass} style={labelStyle}>Мбит/с</span>
            </div>
          </div>
          <p className={`${smallClass} mt-3`} style={labelStyle}>Замерено 2 мин назад</p>
        </div>

        {/* ── Card 5: Users — compact card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2.5">
              <Users className="w-5 h-5" style={labelStyle} />
              <span className={titleClass} style={labelStyle}>Пользователи</span>
            </div>
            <ChevronRight className="w-4 h-4" style={labelStyle} />
          </div>
          <p className="text-3xl font-[var(--font-weight-semibold)]" style={valueStyle}>2</p>
        </div>

        {/* ── Card 6: Server Load + Uptime — tall card ── */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-4">
            <Cpu className="w-5 h-5" style={labelStyle} />
            <span className={titleClass} style={valueStyle}>Нагрузка</span>
          </div>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={contentClass} style={labelStyle}>CPU</span>
                <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>12%</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "12%", backgroundColor: "var(--color-success-500)" }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={contentClass} style={labelStyle}>RAM</span>
                <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>340 / 1024 МБ</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "33%", backgroundColor: "var(--color-accent-interactive)" }} />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <Clock className="w-4 h-4" style={labelStyle} />
              <span className={contentClass} style={labelStyle}>Uptime: 14 дней 7 часов</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Variant: Speed not measured ── */
function OverviewMockupNoSpeed() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      <div style={{ columnCount: 2, columnGap: "12px" }}>
        {/* Card 1: Status */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-3">
            <StatusIndicator status="success" size="lg" pulse />
            <span className={titleClass} style={valueStyle}>Работает</span>
          </div>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>Ping</span>
              <Badge variant="warning" size="md"><Activity className="w-3 h-3" />187ms</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>IP</span>
              <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>45.87.214.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className={contentClass} style={labelStyle}>Страна</span>
              <span className={contentClass} style={valueStyle}>🇳🇱 Нидерланды</span>
            </div>
          </div>
        </div>

        {/* Card 2: Protocol — update available */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <span className={smallClass} style={labelStyle}>Протокол</span>
          <p className="text-lg font-[var(--font-weight-semibold)]" style={valueStyle}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.0.2</Badge>
            <Badge variant="warning" size="md">Обновление</Badge>
          </div>
        </div>

        {/* Card 3: Security — all green except TLS warning */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-3">
            <Shield className="w-5 h-5" style={labelStyle} />
            <span className={titleClass} style={valueStyle}>Безопасность</span>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="success" size="md" />
                <span className={contentClass} style={mutedStyle}>Firewall</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="success" size="md" />
                <span className={contentClass} style={mutedStyle}>Fail2Ban</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="success" size="md" />
                <span className={contentClass} style={mutedStyle}>SSH-ключ</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-success-500)" }}>Настроен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <StatusIndicator status="warning" size="md" />
                <span className={contentClass} style={mutedStyle}>TLS</span>
              </div>
              <span className={contentClass} style={{ color: "var(--color-warning-500)" }}>12 дней</span>
            </div>
          </div>
        </div>

        {/* Card 4: Speed — not measured */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-2">
            <Gauge className="w-5 h-5" style={labelStyle} />
            <span className={titleClass} style={valueStyle}>Скорость</span>
          </div>
          <p className={`${contentClass} mt-1`} style={labelStyle}>Не замерена</p>
          <button
            className={`mt-3 ${contentClass} px-4 py-2 rounded-[var(--radius-md)] transition-colors font-[var(--font-weight-semibold)]`}
            style={{ backgroundColor: "var(--color-bg-elevated)", color: "var(--color-text-secondary)" }}
          >
            Замерить
          </button>
        </div>

        {/* Card 5: Users */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2.5">
              <Users className="w-5 h-5" style={labelStyle} />
              <span className={titleClass} style={labelStyle}>Пользователи</span>
            </div>
            <ChevronRight className="w-4 h-4" style={labelStyle} />
          </div>
          <p className="text-3xl font-[var(--font-weight-semibold)]" style={valueStyle}>5</p>
        </div>

        {/* Card 6: Load — high usage */}
        <div className={cardBase} style={{ ...cardStyle, marginBottom: "12px", breakInside: "avoid" }}>
          <div className="flex items-center gap-2.5 mb-3">
            <Cpu className="w-5 h-5" style={labelStyle} />
            <span className={titleClass} style={valueStyle}>Нагрузка</span>
          </div>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={contentClass} style={labelStyle}>CPU</span>
                <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>67%</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "67%", backgroundColor: "var(--color-warning-500)" }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={contentClass} style={labelStyle}>RAM</span>
                <span className={`${contentClass} font-[var(--font-weight-semibold)]`} style={valueStyle}>780 / 1024 МБ</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "76%", backgroundColor: "var(--color-danger-500)" }} />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Clock className="w-4 h-4" style={labelStyle} />
              <span className={contentClass} style={labelStyle}>Uptime: 47 дней 3 часа</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Screens/Overview Mockup (Phase 13)",
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 700, display: "flex", flexDirection: "column", backgroundColor: "var(--color-bg-primary)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/** Masonry layout: 6 independent cards, each with its own natural size. Speed measured, security mixed. */
export const AllData: Story = {
  render: () => <OverviewMockup />,
};

/** Speed not measured, update available, security fully configured, high load. */
export const MixedState: Story = {
  render: () => <OverviewMockupNoSpeed />,
};
