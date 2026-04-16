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
  Radio,
  Server,
} from "lucide-react";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Badge } from "../../shared/ui/Badge";

/* ═══════════════════════════════════════════════════════
   Phase 13 Overview Mockup — rows with variable columns
   Row 1: 2 cards (Status wide + Protocol)
   Row 2: 3 cards (Security + Speed + Users)
   Row 3: 1 card  (Server Load full width)
   ═══════════════════════════════════════════════════════ */

const card = "rounded-[var(--radius-lg)] p-[var(--space-4)]";
const cardBg = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const secondary = { color: "var(--color-text-secondary)" };

/* ── Card Title — unified across all cards ── */
function CardTitle({ icon, title, clickable }: { icon: React.ReactNode; title: string; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <span style={muted}>{icon}</span>
        <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>{title}</span>
      </div>
      {clickable && <ChevronRight className="w-4 h-4" style={muted} />}
    </div>
  );
}

/* ── Info Row — label : value ── */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={muted}>{label}</span>
      <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{children}</span>
    </div>
  );
}

function OverviewMockup() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      {/* ── Row 1: Status (3fr) + Protocol (2fr) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "3fr 2fr" }}>
        {/* Статус */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-4.5 h-4.5" />} title="Статус" />
          <div className="space-y-2.5">
            <div className="flex items-center gap-2.5">
              <StatusIndicator status="success" size="md" pulse />
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
              <Badge variant="success" size="md"><Activity className="w-3 h-3" />42ms</Badge>
            </div>
            <InfoRow label="IP">185.22.153.xx</InfoRow>
            <InfoRow label="Страна"><span>&#127465;&#127466; Германия</span></InfoRow>
          </div>
        </div>

        {/* Протокол */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Radio className="w-4.5 h-4.5" />} title="Протокол" clickable />
          <p className="text-lg font-[var(--font-weight-semibold)]" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.1.0</Badge>
            <Badge variant="success" size="md">Актуальная</Badge>
          </div>
        </div>
      </div>

      {/* ── Row 2: Security (2fr) + Speed (2fr) + Users (1fr) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 2fr 1fr" }}>
        {/* Безопасность */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-4.5 h-4.5" />} title="Безопасность" clickable />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="success" size="sm" />
                <span className="text-sm" style={secondary}>Firewall</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="danger" size="sm" />
                <span className="text-sm" style={secondary}>Fail2Ban</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-danger-500)" }}>Выключен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="danger" size="sm" />
                <span className="text-sm" style={secondary}>SSH-ключ</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-danger-500)" }}>Нет</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="success" size="sm" />
                <span className="text-sm" style={secondary}>TLS</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-success-500)" }}>89 дн.</span>
            </div>
          </div>
        </div>

        {/* Скорость */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Gauge className="w-4.5 h-4.5" />} title="Скорость" />
          <div className="flex items-center gap-5 mt-1">
            <div className="flex items-center gap-1.5">
              <ArrowDown className="w-4 h-4" style={{ color: "var(--color-success-400)" }} />
              <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>124</span>
              <span className="text-sm" style={muted}>Мбит/с</span>
            </div>
            <div className="flex items-center gap-1.5">
              <ArrowUp className="w-4 h-4" style={{ color: "var(--color-accent-interactive)" }} />
              <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>98</span>
              <span className="text-sm" style={muted}>Мбит/с</span>
            </div>
          </div>
          <p className="text-xs mt-2" style={muted}>2 мин назад</p>
        </div>

        {/* Пользователи */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Users className="w-4.5 h-4.5" />} title="Польз." clickable />
          <p className="text-3xl font-[var(--font-weight-semibold)] text-center" style={primary}>2</p>
        </div>
      </div>

      {/* ── Row 3: Server Load (full width) ── */}
      <div className={card} style={cardBg}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span style={muted}><Cpu className="w-4.5 h-4.5" /></span>
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Нагрузка</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5" style={muted} />
            <span className="text-sm" style={muted}>Uptime: 14 дней 7 часов</span>
          </div>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm" style={muted}>CPU</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span>
            </div>
            <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full" style={{ width: "12%", backgroundColor: "var(--color-success-500)" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm" style={muted}>RAM</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
            </div>
            <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full" style={{ width: "33%", backgroundColor: "var(--color-accent-interactive)" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Variant 2: Update available, speed not measured, high load, all security green ── */
function OverviewMockupMixed() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      {/* Row 1 */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "3fr 2fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-4.5 h-4.5" />} title="Статус" />
          <div className="space-y-2.5">
            <div className="flex items-center gap-2.5">
              <StatusIndicator status="success" size="md" pulse />
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
              <Badge variant="warning" size="md"><Activity className="w-3 h-3" />187ms</Badge>
            </div>
            <InfoRow label="IP">45.87.214.xx</InfoRow>
            <InfoRow label="Страна"><span>&#127475;&#127473; Нидерланды</span></InfoRow>
          </div>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Radio className="w-4.5 h-4.5" />} title="Протокол" clickable />
          <p className="text-lg font-[var(--font-weight-semibold)]" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.0.2</Badge>
            <Badge variant="warning" size="md">Обновление</Badge>
          </div>
        </div>
      </div>

      {/* Row 2 */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 2fr 1fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-4.5 h-4.5" />} title="Безопасность" clickable />
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="success" size="sm" />
                <span className="text-sm" style={secondary}>Firewall</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="success" size="sm" />
                <span className="text-sm" style={secondary}>Fail2Ban</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-success-500)" }}>Активен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="success" size="sm" />
                <span className="text-sm" style={secondary}>SSH-ключ</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-success-500)" }}>Настроен</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusIndicator status="warning" size="sm" />
                <span className="text-sm" style={secondary}>TLS</span>
              </div>
              <span className="text-sm" style={{ color: "var(--color-warning-500)" }}>12 дн.</span>
            </div>
          </div>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Gauge className="w-4.5 h-4.5" />} title="Скорость" />
          <p className="text-sm mt-1" style={muted}>Не замерена</p>
          <button
            className="mt-3 text-sm px-4 py-2 rounded-[var(--radius-md)] transition-colors font-[var(--font-weight-semibold)]"
            style={{ backgroundColor: "var(--color-bg-elevated)", color: "var(--color-text-secondary)" }}
          >
            Замерить
          </button>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Users className="w-4.5 h-4.5" />} title="Польз." clickable />
          <p className="text-3xl font-[var(--font-weight-semibold)] text-center" style={primary}>5</p>
        </div>
      </div>

      {/* Row 3 */}
      <div className={card} style={cardBg}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span style={muted}><Cpu className="w-4.5 h-4.5" /></span>
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Нагрузка</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5" style={muted} />
            <span className="text-sm" style={muted}>Uptime: 47 дней 3 часа</span>
          </div>
        </div>
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm" style={muted}>CPU</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>67%</span>
            </div>
            <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full" style={{ width: "67%", backgroundColor: "var(--color-warning-500)" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm" style={muted}>RAM</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>780 / 1024 МБ</span>
            </div>
            <div className="h-2 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full" style={{ width: "76%", backgroundColor: "var(--color-danger-500)" }} />
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

/** All data available: good ping, speed measured, mixed security, low load. */
export const AllData: Story = { render: () => <OverviewMockup /> };

/** Update available, speed not measured, all security green, TLS warning, high load. */
export const MixedState: Story = { render: () => <OverviewMockupMixed /> };
