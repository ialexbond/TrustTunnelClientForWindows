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
  ArrowUpCircle,
} from "lucide-react";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Badge } from "../../shared/ui/Badge";

const card = "rounded-[var(--radius-lg)] p-[var(--space-4)]";
const cardBg = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };

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

function InfoRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {icon && <span style={muted}>{icon}</span>}
        <span className="text-sm" style={muted}>{label}</span>
      </div>
      <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{value}</span>
    </div>
  );
}

function OverviewMockup() {
  return (
    <div className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3" style={{ backgroundColor: "var(--color-bg-primary)" }}>

      {/* ── Row 1: Status + Protocol + Speed + Users ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1.5fr 1.5fr 2fr 1fr" }}>

        {/* Статус */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-2 mb-3">
            <StatusIndicator status="success" size="md" pulse />
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <InfoRow icon={<Activity className="w-3.5 h-3.5" />} label="Ping" value={<Badge variant="success" size="sm">42ms</Badge>} />
            <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="IP" value="185.22.153.xx" />
            <InfoRow label="Страна" value={<span>&#127465;&#127466; Германия</span>} />
            <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Uptime" value="14д 7ч" />
          </div>
        </div>

        {/* Протокол — название крупно, версия крупно текстом */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-xl font-[var(--font-weight-semibold)]" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-auto pt-2">
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>v1.0.49</span>
            <span className="text-xs" style={{ color: "var(--color-success-500)" }}>актуальная</span>
          </div>
        </div>

        {/* Скорость — крупные цифры, сепаратор */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-2">
              <ArrowDown className="w-8 h-8" style={{ color: "var(--color-success-400)" }} />
              <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, ...primary }}>124</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
            {/* Separator */}
            <div className="self-stretch mx-4" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-2">
              <ArrowUp className="w-8 h-8" style={{ color: "var(--color-warning-500)" }} />
              <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, ...primary }}>98</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
          </div>
          <p className="text-xs" style={muted}>2 мин назад</p>
        </div>

        {/* Пользователей */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователей" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2.5rem, 6vw, 4rem)", fontWeight: 600, lineHeight: 1, ...primary }}>2</span>
          </div>
        </div>
      </div>

      {/* ── Row 2: Security + Load ── */}
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
              <div key={item.name} className="rounded-[var(--radius-md)] p-3 flex flex-col gap-1"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-sm" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Нагрузка */}
        <div className={card} style={cardBg}>
          <CardTitle icon={<Cpu className="w-5 h-5" />} title="Нагрузка" />
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-base" style={muted}>CPU</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>12%</span>
              </div>
              <div className="h-3 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "12%", backgroundColor: "var(--color-success-500)" }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-base" style={muted}>RAM</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
              </div>
              <div className="h-3 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "33%", backgroundColor: "var(--color-accent-interactive)" }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Variant 2: update available, speed not measured ── */
function OverviewMockupMixed() {
  return (
    <div className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3" style={{ backgroundColor: "var(--color-bg-primary)" }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1.5fr 1.5fr 2fr 1fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Server className="w-5 h-5" />} title="Статус" />
          <div className="flex items-center gap-2 mb-3">
            <StatusIndicator status="success" size="md" pulse />
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <InfoRow icon={<Activity className="w-3.5 h-3.5" />} label="Ping" value={<Badge variant="warning" size="sm">187ms</Badge>} />
            <InfoRow icon={<Globe className="w-3.5 h-3.5" />} label="IP" value="45.87.214.xx" />
            <InfoRow label="Страна" value={<span>&#127475;&#127473; Нидерланды</span>} />
            <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Uptime" value="47д 3ч" />
          </div>
        </div>

        {/* Протокол — обновление доступно */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Radio className="w-5 h-5" />} title="Протокол" clickable />
          <p className="text-xl font-[var(--font-weight-semibold)]" style={primary}>TrustTunnel</p>
          <div className="flex items-center gap-2 mt-auto pt-2">
            <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>v1.0.47</span>
            <ArrowUpCircle className="w-5 h-5" style={{ color: "var(--color-warning-500)" }} />
            <span className="text-xs" style={{ color: "var(--color-warning-500)" }}>1.0.49</span>
          </div>
        </div>

        {/* Скорость — не замерена */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Скорость" />
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm" style={muted}>Не замерена</p>
            <button className="ml-3 text-xs px-3 py-1.5 rounded-[var(--radius-md)] font-[var(--font-weight-semibold)]"
              style={{ backgroundColor: "var(--color-bg-elevated)", color: "var(--color-text-secondary)" }}>
              Замерить
            </button>
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователей" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2.5rem, 6vw, 4rem)", fontWeight: 600, lineHeight: 1, ...primary }}>5</span>
          </div>
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
              <div key={item.name} className="rounded-[var(--radius-md)] p-3 flex flex-col gap-1"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-sm" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Cpu className="w-5 h-5" />} title="Нагрузка" />
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-base" style={muted}>CPU</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>67%</span>
              </div>
              <div className="h-3 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                <div className="h-full rounded-full" style={{ width: "67%", backgroundColor: "var(--color-warning-500)" }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-base" style={muted}>RAM</span>
                <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>780 / 1024 МБ</span>
              </div>
              <div className="h-3 rounded-full" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
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
  decorators: [(Story) => (
    <div style={{ height: 700, display: "flex", flexDirection: "column", backgroundColor: "var(--color-bg-primary)" }}>
      <Story />
    </div>
  )],
};

export default meta;
type Story = StoryObj;

export const AllData: Story = { render: () => <OverviewMockup /> };
export const MixedState: Story = { render: () => <OverviewMockupMixed /> };
