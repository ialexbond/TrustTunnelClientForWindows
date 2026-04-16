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
  Globe,
} from "lucide-react";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Badge } from "../../shared/ui/Badge";

/* ═══════════════════════════════════════════════════════
   Phase 13 Overview Mockup v7
   Row 1: Status (2fr) + Protocol (1.5fr) + Speed (1.5fr) + Users (0.8fr)
   Row 2: Security (1fr) + Load (1fr)
   ═══════════════════════════════════════════════════════ */

const card = "rounded-[var(--radius-lg)] p-[var(--space-4)]";
const cardBg = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const secondary = { color: "var(--color-text-secondary)" };

function CardTitle({ icon, title, clickable }: { icon: React.ReactNode; title: string; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <span style={muted}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{title}</span>
      </div>
      {clickable && <ChevronRight className="w-5 h-5" style={muted} />}
    </div>
  );
}

function pluralUsers(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return "пользователь";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "пользователя";
  return "пользователей";
}

function OverviewMockup() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      {/* ── Row 1: Status + Protocol + Speed + Users ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 1.5fr 1.5fr 0.8fr" }}>

        {/* Статус */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-3 mb-3">
            <StatusIndicator status="success" size="lg" pulse />
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>Ping</span>
              </div>
              <Badge variant="success" size="md">42ms</Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>IP</span>
              </div>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-sm" style={primary}>&#127465;&#127466; Германия</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>Uptime</span>
              </div>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span>
            </div>
          </div>
        </div>

        {/* Протокол */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-2xl font-[var(--font-weight-semibold)] flex-1 flex items-center" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.1.0</Badge>
            <Badge variant="success" size="md">Актуальная</Badge>
          </div>
        </div>

        {/* Скорость — inline Мбит/с рядом с числом */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex flex-col justify-center gap-1.5">
            <div className="flex items-center gap-1">
              <ArrowDown style={{ width: "1.5rem", height: "1.5rem", color: "var(--color-success-400)" }} />
              <span className="text-2xl font-[var(--font-weight-semibold)]" style={primary}>124</span>
              <span className="text-xs self-end mb-0.5" style={muted}>Мбит/с</span>
            </div>
            <div className="flex items-center gap-1">
              <ArrowUp style={{ width: "1.5rem", height: "1.5rem", color: "var(--color-warning-500)" }} />
              <span className="text-2xl font-[var(--font-weight-semibold)]" style={primary}>98</span>
              <span className="text-xs self-end mb-0.5" style={muted}>Мбит/с</span>
            </div>
          </div>
          <p className="text-xs" style={muted}>2 мин назад</p>
        </div>

        {/* Пользователи — title склоняется динамически */}
        <div className={`${card} flex flex-col items-center justify-center`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title={`2 ${pluralUsers(2)}`} clickable />
        </div>
      </div>

      {/* ── Row 2: Security (1fr) + Load (1fr) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>

        {/* Безопасность */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="grid grid-cols-2 gap-2">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: false, label: "Выключен" },
              { name: "SSH-ключ", ok: false, label: "Нет" },
              { name: "TLS", ok: true, label: "89 дн." },
            ].map((item) => (
              <div
                key={item.name}
                className="rounded-[var(--radius-md)] p-3 flex flex-col gap-1"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}
              >
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-sm" style={{
                  color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)"
                }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Нагрузка */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Cpu className="w-5 h-5" />} title="Нагрузка" />
          <div className="flex gap-0">
            <div className="flex-1 px-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm" style={muted}>CPU</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>12%</span>
              </div>
              <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "12%", backgroundColor: "var(--color-success-500)" }} />
              </div>
            </div>
            <div className="self-stretch mx-3" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex-1 px-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm" style={muted}>RAM</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
              </div>
              <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "33%", backgroundColor: "var(--color-accent-interactive)" }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Variant 2 ── */
function OverviewMockupMixed() {
  return (
    <div
      className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 1.5fr 1.5fr 0.8fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-3 mb-3">
            <StatusIndicator status="success" size="lg" pulse />
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>Ping</span>
              </div>
              <Badge variant="warning" size="md">187ms</Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>IP</span>
              </div>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>45.87.214.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-sm" style={primary}>&#127475;&#127473; Нидерланды</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" style={muted} />
                <span className="text-sm" style={muted}>Uptime</span>
              </div>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>47д 3ч</span>
            </div>
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-2xl font-[var(--font-weight-semibold)] flex-1 flex items-center" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="neutral" size="md">v3.0.2</Badge>
            <Badge variant="warning" size="md">Обновление</Badge>
          </div>
        </div>

        {/* Скорость — не замерена */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex flex-col items-center justify-center gap-2">
            <p className="text-sm" style={muted}>Не замерена</p>
            <button
              className="text-xs px-4 py-2 rounded-[var(--radius-md)] transition-colors font-[var(--font-weight-semibold)]"
              style={{ backgroundColor: "var(--color-bg-elevated)", color: "var(--color-text-secondary)" }}
            >
              Замерить
            </button>
          </div>
        </div>

        <div className={`${card} flex flex-col items-center justify-center`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title={`5 ${pluralUsers(5)}`} clickable />
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="grid grid-cols-2 gap-2">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: true, label: "Активен" },
              { name: "SSH-ключ", ok: true, label: "Настроен" },
              { name: "TLS", ok: false, label: "12 дн." },
            ].map((item) => (
              <div
                key={item.name}
                className="rounded-[var(--radius-md)] p-3 flex flex-col gap-1"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}
              >
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-sm" style={{
                  color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)"
                }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Cpu className="w-5 h-5" />} title="Нагрузка" />
          <div className="flex gap-0">
            <div className="flex-1 px-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm" style={muted}>CPU</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>67%</span>
              </div>
              <div className="h-2.5 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "67%", backgroundColor: "var(--color-warning-500)" }} />
              </div>
            </div>
            <div className="self-stretch mx-3" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex-1 px-1">
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
