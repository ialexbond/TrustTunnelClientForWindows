import type { Meta, StoryObj } from "@storybook/react";
import {
  Shield,
  Users,
  Gauge,
  Zap,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  HeartPulse,
  Package,
  RefreshCw,
  ArrowUpCircle,
} from "lucide-react";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";

const card = "rounded-[var(--radius-lg)] p-[var(--space-4)]";
const cardBg = { backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" };
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };

function CardTitle({ icon, title, clickable, onRefresh }: { icon?: React.ReactNode; title: string; clickable?: boolean; onRefresh?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {icon && <span className="flex items-center justify-center w-5 h-5 shrink-0" style={muted}>{icon}</span>}
        <span className="text-lg font-[var(--font-weight-semibold)] leading-none" style={primary}>{title}</span>
      </div>
      <div className="flex items-center gap-1">
        {onRefresh && <button className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] transition-colors" aria-label="Обновить" style={muted}><RefreshCw className="w-4 h-4" /></button>}
        {clickable && <ChevronRight className="w-5 h-5" style={muted} />}
      </div>
    </div>
  );
}

function OverviewMockup() {
  return (
    <div className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3" style={{ backgroundColor: "var(--color-bg-primary)" }}>

      {/* ── Row 1: Status(1.5fr) + Version(1.5fr) + Speed(2fr) + Users(1fr) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1.5fr 1.5fr 2fr 1fr" }}>

        {/* Статус */}
        <section aria-label="Статус сервера" className={card} style={cardBg}>
          <CardTitle icon={<HeartPulse className="w-5 h-5" />} title="Статус" onRefresh />
          <div className="flex items-center gap-2 mb-3" aria-live="polite">
            <StatusIndicator status="success" size="md" pulse />
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Ping</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-success-500)" }}>42ms</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>IP</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-sm" style={primary}>&#127465;&#127466; Германия</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Uptime</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span>
            </div>
          </div>
        </section>

        <section aria-label="Версия протокола" className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Package className="w-5 h-5" />} title="Версия протокола" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, lineHeight: 1, ...primary }}>1.0.49</span>
          </div>
        </section>

        <section aria-label="Скорость соединения" className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Zap className="w-5 h-5" />} title="Скорость" onRefresh />
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-2">
              <ArrowDown className="w-8 h-8" style={{ color: "var(--color-success-400)" }} />
              <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, ...primary }}>124</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
            <div className="mx-4 h-8" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-2">
              <ArrowUp className="w-8 h-8" style={{ color: "var(--color-warning-500)" }} />
              <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, ...primary }}>98</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
          </div>
        </section>

        <section aria-label="Пользователи" className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователей" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, lineHeight: 1, ...primary }}>2</span>
          </div>
        </section>
      </div>

      {/* ── Row 2: Security(0.7fr) + Load(1fr) — безопасность уже ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "0.7fr 1fr" }}>

        <section aria-label="Безопасность" className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="grid grid-cols-2 gap-2">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: false, label: "Выключен" },
              { name: "SSH-ключ", ok: false, label: "Нет" },
              { name: "TLS", ok: true, label: "89 дн." },
            ].map((item) => (
              <div key={item.name} className="rounded-[var(--radius-md)] p-2.5 flex flex-col gap-0.5"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <span className="text-xs font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-xs" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Нагрузка сервера" className={card} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Нагрузка" onRefresh />
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
        </section>
      </div>
    </div>
  );
}

/* ── Variant 2: update available ── */
function OverviewMockupMixed() {
  return (
    <div className="flex-1 flex flex-col overflow-auto scroll-overlay py-4 px-6 gap-3" style={{ backgroundColor: "var(--color-bg-primary)" }}>
      <div className="grid gap-3" style={{ gridTemplateColumns: "1.5fr 1.5fr 2fr 1fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<HeartPulse className="w-5 h-5" />} title="Статус" onRefresh />
          <div className="flex items-center gap-2 mb-3">
            <StatusIndicator status="success" size="md" pulse />
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Ping</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-warning-500)" }}>187ms</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>IP</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>45.87.214.xx</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Страна</span>
              <span className="text-sm" style={primary}>&#127475;&#127473; Нидерланды</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Uptime</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>47д 3ч</span>
            </div>
          </div>
        </div>

        {/* Версия — обновление доступно */}
        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Package className="w-5 h-5" />} title="Версия протокола" clickable />
          <div className="flex-1 flex items-center justify-center gap-2">
            <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, lineHeight: 1, ...primary }}>1.0.47</span>
            <ArrowUpCircle className="w-6 h-6" style={{ color: "var(--color-warning-500)" }} />
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Zap className="w-5 h-5" />} title="Скорость" onRefresh />
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm" style={muted}>Не замерена</p>
          </div>
        </div>

        <div className={`${card} flex flex-col`} style={cardBg}>
          <CardTitle icon={<Users className="w-5 h-5" />} title="Пользователей" clickable />
          <div className="flex-1 flex items-center justify-center">
            <span style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, lineHeight: 1, ...primary }}>5</span>
          </div>
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "0.7fr 1fr" }}>
        <div className={card} style={cardBg}>
          <CardTitle icon={<Shield className="w-5 h-5" />} title="Безопасность" clickable />
          <div className="grid grid-cols-2 gap-2">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: true, label: "Активен" },
              { name: "SSH-ключ", ok: true, label: "Настроен" },
              { name: "TLS", ok: false, label: "12 дн." },
            ].map((item) => (
              <div key={item.name} className="rounded-[var(--radius-md)] p-2.5 flex flex-col gap-0.5"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <span className="text-xs font-[var(--font-weight-semibold)]" style={primary}>{item.name}</span>
                <span className="text-xs" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={card} style={cardBg}>
          <CardTitle icon={<Gauge className="w-5 h-5" />} title="Нагрузка" onRefresh />
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
