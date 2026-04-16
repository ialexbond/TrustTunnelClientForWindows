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
   Phase 13 Overview Mockup v4 — adaptive, bold, fill space
   Row 1: Status (3fr) + Protocol (2fr)
   Row 2: Security (2fr) + Speed (2fr) + Users (1fr)
   Row 3: Load (full)
   ═══════════════════════════════════════════════════════ */

const card = "rounded-[var(--radius-lg)] p-[var(--space-4)]";
const cardBg = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const secondary = { color: "var(--color-text-secondary)" };

function CardTitle({ icon, title, clickable }: { icon: React.ReactNode; title: string; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
        <span style={muted}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{title}</span>
      </div>
      {clickable && <ChevronRight className="w-5 h-5" style={muted} />}
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
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-3 mb-3">
            <StatusIndicator status="success" size="lg" pulse />
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
            <Badge variant="success" size="md"><Activity className="w-3 h-3" />42ms</Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>IP</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-base" style={primary}>&#127465;&#127466; Германия</span>
            </div>
          </div>
        </div>

        {/* Протокол */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-xl font-[var(--font-weight-semibold)] flex-1 flex items-center" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.1.0</Badge>
            <Badge variant="success" size="md">Актуальная</Badge>
          </div>
        </div>
      </div>

      {/* ── Row 2: Security (2fr) + Speed (2fr) + Users (1.2fr) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 2fr 1.2fr" }}>

        {/* Безопасность */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="space-y-3">
            {[
              { name: "Firewall", status: "success" as const, label: "Активен" },
              { name: "Fail2Ban", status: "danger" as const, label: "Выключен" },
              { name: "SSH-ключ", status: "danger" as const, label: "Нет" },
              { name: "TLS", status: "success" as const, label: "89 дн." },
            ].map((item) => (
              <div key={item.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <StatusIndicator status={item.status} size="md" />
                  <span className="text-sm" style={secondary}>{item.name}</span>
                </div>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={{
                  color: item.status === "success" ? "var(--color-success-500)"
                    : item.status === "warning" ? "var(--color-warning-500)"
                    : "var(--color-danger-500)"
                }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Скорость */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex items-center justify-center gap-6">
            <div className="text-center">
              <div className="flex items-center gap-1.5 justify-center">
                <ArrowDown className="w-5 h-5" style={{ color: "var(--color-success-400)" }} />
                <span style={{ fontSize: "clamp(1.5rem, 4vw, 2.5rem)", fontWeight: 600, ...primary }}>124</span>
              </div>
              <span className="text-sm" style={muted}>Мбит/с</span>
            </div>
            <div className="text-center">
              <div className="flex items-center gap-1.5 justify-center">
                <ArrowUp className="w-5 h-5" style={{ color: "var(--color-accent-interactive)" }} />
                <span style={{ fontSize: "clamp(1.5rem, 4vw, 2.5rem)", fontWeight: 600, ...primary }}>98</span>
              </div>
              <span className="text-sm" style={muted}>Мбит/с</span>
            </div>
          </div>
          <p className="text-xs mt-1" style={muted}>2 мин назад</p>
        </div>

        {/* Пользователи */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователи" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2.5rem, 8vw, 5rem)", fontWeight: 600, lineHeight: 1, ...primary }}>2</span>
          </div>
        </div>
      </div>

      {/* ── Row 3: Server Load (full width) ── */}
      <div className={card} style={cardBg}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span style={muted}><Cpu className="w-5 h-5" /></span>
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Нагрузка</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4" style={muted} />
            <span className="text-sm" style={muted}>Uptime: 14 дней 7 часов</span>
          </div>
        </div>
        <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm" style={muted}>CPU</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>12%</span>
            </div>
            <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full transition-all" style={{ width: "12%", backgroundColor: "var(--color-success-500)" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm" style={muted}>RAM</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
            </div>
            <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full transition-all" style={{ width: "33%", backgroundColor: "var(--color-accent-interactive)" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Variant 2: Mixed ── */
function OverviewMockupMixed() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: "3fr 2fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-3 mb-3">
            <StatusIndicator status="success" size="lg" pulse />
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
            <Badge variant="warning" size="md"><Activity className="w-3 h-3" />187ms</Badge>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>IP</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>45.87.214.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-base" style={primary}>&#127475;&#127473; Нидерланды</span>
            </div>
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-xl font-[var(--font-weight-semibold)] flex-1 flex items-center" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.0.2</Badge>
            <Badge variant="warning" size="md">Обновление</Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 2fr 1.2fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="space-y-3">
            {[
              { name: "Firewall", status: "success" as const, label: "Активен" },
              { name: "Fail2Ban", status: "success" as const, label: "Активен" },
              { name: "SSH-ключ", status: "success" as const, label: "Настроен" },
              { name: "TLS", status: "warning" as const, label: "12 дн." },
            ].map((item) => (
              <div key={item.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <StatusIndicator status={item.status} size="md" />
                  <span className="text-sm" style={secondary}>{item.name}</span>
                </div>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={{
                  color: item.status === "success" ? "var(--color-success-500)" : "var(--color-warning-500)"
                }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <p className="text-base" style={muted}>Не замерена</p>
            <button
              className="text-sm px-5 py-2.5 rounded-[var(--radius-md)] transition-colors font-[var(--font-weight-semibold)]"
              style={{ backgroundColor: "var(--color-bg-elevated)", color: "var(--color-text-secondary)" }}
            >
              Замерить скорость
            </button>
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователи" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2.5rem, 8vw, 5rem)", fontWeight: 600, lineHeight: 1, ...primary }}>5</span>
          </div>
        </div>
      </div>

      <div className={card} style={cardBg}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span style={muted}><Cpu className="w-5 h-5" /></span>
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Нагрузка</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4" style={muted} />
            <span className="text-sm" style={muted}>Uptime: 47 дней 3 часа</span>
          </div>
        </div>
        <div className="grid gap-6" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm" style={muted}>CPU</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>67%</span>
            </div>
            <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <div className="h-full rounded-full" style={{ width: "67%", backgroundColor: "var(--color-warning-500)" }} />
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm" style={muted}>RAM</span>
              <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>780 / 1024 МБ</span>
            </div>
            <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
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

export const AllData: Story = { render: () => <OverviewMockup /> };
export const MixedState: Story = { render: () => <OverviewMockupMixed /> };
