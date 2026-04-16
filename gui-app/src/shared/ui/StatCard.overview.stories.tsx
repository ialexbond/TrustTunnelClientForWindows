import type { Meta, StoryObj } from "@storybook/react";
import {
  HeartPulse, Package, Zap, Users, Shield, Gauge,
  ArrowDown, ArrowUp, ChevronRight, RefreshCw, ArrowUpCircle,
} from "lucide-react";
import { StatusIndicator } from "./StatusIndicator";
import { ProgressBar } from "./ProgressBar";
import { Skeleton } from "./Skeleton";
import { Card } from "./Card";

/* ═══════════════════════════════════════════════════════
   StatCard Overview Variants v3

   Rules:
   - Each card has minWidth so titles fit on ONE line
   - Cards stretch to fill container edges (no floating)
   - Same height with data and without (skeleton = same size)
   - Security: bigger text, wider card
   - Row 2 right edge = Row 1 right edge
   ═══════════════════════════════════════════════════════ */

const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const accent = { color: "var(--color-accent-interactive)" };
const bigNum = { fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)", fontWeight: 600, lineHeight: 1, color: "var(--color-text-primary)" } as const;

function Title({ icon, text, onRefresh, clickable }: { icon: React.ReactNode; text: string; onRefresh?: boolean; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
      <div className="flex items-center gap-2 h-full whitespace-nowrap">
        <span className="flex items-center justify-center w-5 h-5 shrink-0" style={accent}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{text}</span>
      </div>
      <div className="flex items-center gap-1 h-full shrink-0 ml-2">
        {onRefresh && (
          <button className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] transition-colors" aria-label="Обновить" style={muted}>
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
        {clickable && <ChevronRight className="w-5 h-5" style={muted} />}
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Primitives/StatCard/Overview Variants",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

/* ── 1. Статус ── */
export const Status: Story = {
  name: "1. Статус",
  decorators: [(S) => <div style={{ minWidth: 280, maxWidth: 320, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
      <div className="flex items-center gap-2 mb-3">
        <StatusIndicator status="success" size="md" pulse />
        <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Ping</span><span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-success-500)" }}>42ms</span></div>
        <div className="flex items-center justify-between"><span className="text-sm" style={muted}>IP</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span></div>
        <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Страна</span><span className="text-sm" style={primary}>🇩🇪 Германия</span></div>
        <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Uptime</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span></div>
      </div>
    </Card>
  ),
};

export const StatusSkeleton: Story = {
  name: "1b. Статус (skeleton)",
  decorators: [(S) => <div style={{ minWidth: 280, maxWidth: 320, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
      <div className="flex items-center gap-2 mb-3"><Skeleton variant="card" width={10} height={10} className="rounded-full" /><Skeleton variant="line" width={80} height={16} /></div>
      <div className="space-y-2">
        {[1,2,3,4].map(i => <div key={i} className="flex items-center justify-between"><Skeleton variant="line" width={50} height={14} /><Skeleton variant="line" width={90} height={14} /></div>)}
      </div>
    </Card>
  ),
};

/* ── 1c-1f. Отдельные карточки из Статуса ── */
export const StatusOnly: Story = {
  name: "1c. Статус (только)",
  decorators: [(S) => <div style={{ minWidth: 200, maxWidth: 240, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
      <div className="flex items-center gap-2 py-2">
        <StatusIndicator status="success" size="md" pulse />
        <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
      </div>
    </Card>
  ),
};

export const PingCard: Story = {
  name: "1d. Ping",
  decorators: [(S) => <div style={{ minWidth: 160, maxWidth: 200, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <span aria-hidden="true" style={accent}><HeartPulse className="w-4 h-4" /></span>
        <span style={bigNum}>42<span className="text-sm" style={muted}>ms</span></span>
        <span className="text-sm" style={muted}>Ping</span>
      </div>
    </Card>
  ),
};

export const IpCard: Story = {
  name: "1e. IP",
  decorators: [(S) => <div style={{ minWidth: 180, maxWidth: 220, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <span aria-hidden="true" style={accent}><HeartPulse className="w-4 h-4" /></span>
        <span className="text-xl font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span>
        <span className="text-sm" style={muted}>IP-адрес</span>
      </div>
    </Card>
  ),
};

export const CountryCard: Story = {
  name: "1f. Страна",
  decorators: [(S) => <div style={{ minWidth: 160, maxWidth: 200, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <span aria-hidden="true" style={accent}><HeartPulse className="w-4 h-4" /></span>
        <span className="text-xl font-[var(--font-weight-semibold)]" style={primary}>🇩🇪 Германия</span>
        <span className="text-sm" style={muted}>Страна</span>
      </div>
    </Card>
  ),
};

export const UptimeCard: Story = {
  name: "1g. Uptime",
  decorators: [(S) => <div style={{ minWidth: 160, maxWidth: 200, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <span aria-hidden="true" style={accent}><HeartPulse className="w-4 h-4" /></span>
        <span className="text-xl font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span>
        <span className="text-sm" style={muted}>Uptime</span>
      </div>
    </Card>
  ),
};

/* ── 2. Версия протокола ── */
export const Version: Story = {
  name: "2. Версия протокола",
  decorators: [(S) => <div style={{ minWidth: 240, maxWidth: 280, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>1.0.49</span>
      </div>
    </Card>
  ),
};

export const VersionUpdate: Story = {
  name: "2b. Версия (обновление)",
  decorators: [(S) => <div style={{ minWidth: 240, maxWidth: 280, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center gap-3 py-2">
        <span style={bigNum}>1.0.47</span>
        <ArrowUpCircle className="w-6 h-6 shrink-0" style={{ color: "var(--color-warning-500)" }} />
      </div>
    </Card>
  ),
};

export const VersionSkeleton: Story = {
  name: "2c. Версия (skeleton)",
  decorators: [(S) => <div style={{ minWidth: 240, maxWidth: 280, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center py-2"><Skeleton variant="line" width={120} height={36} /></div>
    </Card>
  ),
};

/* ── 3. Скорость ── */
export const Speed: Story = {
  name: "3. Скорость",
  decorators: [(S) => <div style={{ minWidth: 360, maxWidth: 420, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center gap-6 py-2">
        <div className="flex items-center gap-2">
          <ArrowDown className="w-7 h-7 shrink-0" style={{ color: "var(--color-success-400)" }} />
          <span style={bigNum}>124</span>
          <span className="text-xs shrink-0" style={muted}>Мбит/с</span>
        </div>
        <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
        <div className="flex items-center gap-2">
          <ArrowUp className="w-7 h-7 shrink-0" style={{ color: "var(--color-warning-500)" }} />
          <span style={bigNum}>98</span>
          <span className="text-xs shrink-0" style={muted}>Мбит/с</span>
        </div>
      </div>
    </Card>
  ),
};

export const SpeedNotMeasured: Story = {
  name: "3b. Скорость (не замерена)",
  decorators: [(S) => <div style={{ minWidth: 360, maxWidth: 420, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 56 }}>
        <span className="text-sm" style={muted}>Не замерена</span>
      </div>
    </Card>
  ),
};

/* ── 4. Пользователей ── */
export const UsersCount: Story = {
  name: "4. Пользователей",
  decorators: [(S) => <div style={{ minWidth: 200, maxWidth: 240, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>2</span>
      </div>
    </Card>
  ),
};

/* ── 5. Безопасность (шире, текст крупнее) ── */
export const Security: Story = {
  name: "5. Безопасность",
  decorators: [(S) => <div style={{ minWidth: 320, maxWidth: 400, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      <div className="grid grid-cols-2 gap-2 mt-1">
        {[
          { name: "Firewall", ok: true, label: "Активен" },
          { name: "Fail2Ban", ok: false, label: "Выключен" },
          { name: "SSH-ключ", ok: false, label: "Нет" },
          { name: "TLS", ok: true, label: "89 дн." },
        ].map((item) => (
          <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2"
            style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
            <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
            <div className="text-sm" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</div>
          </div>
        ))}
      </div>
    </Card>
  ),
};

/* ── 6. Нагрузка ── */
export const Load: Story = {
  name: "6. Нагрузка",
  decorators: [(S) => <div style={{ minWidth: 320, maxWidth: 500, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
      <div className="space-y-2.5 mt-1">
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>CPU</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span></div>
          <ProgressBar value={12} size="sm" color="success" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>RAM</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span></div>
          <ProgressBar value={33} size="sm" color="accent" />
        </div>
      </div>
    </Card>
  ),
};

/* ── Все вместе — края упираются в контейнер ── */
export const AllCards: Story = {
  name: "Все карточки",
  decorators: [(S) => <div style={{ width: 1060, backgroundColor: "var(--color-bg-primary)", padding: 16 }}><S /></div>],
  render: () => (
    <div className="flex flex-col gap-3" style={{ width: "100%" }}>
      {/* Row 1: Статус + Версия + Скорость + Пользователи */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(270px, 1.5fr) minmax(230px, 1.2fr) minmax(300px, 2fr) minmax(195px, 1fr)" }}>
        {/* Статус */}
        <Card padding="md">
          <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
          <div className="flex items-center gap-2 mb-3">
            <StatusIndicator status="success" size="md" pulse />
            <span className="text-base font-[var(--font-weight-semibold)]" style={primary}>Работает</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Ping</span><span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-success-500)" }}>42ms</span></div>
            <div className="flex items-center justify-between"><span className="text-sm" style={muted}>IP</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>185.22.153.xx</span></div>
            <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Страна</span><span className="text-sm" style={primary}>🇩🇪 Германия</span></div>
            <div className="flex items-center justify-between"><span className="text-sm" style={muted}>Uptime</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span></div>
          </div>
        </Card>

        {/* Версия */}
        <Card padding="md">
          <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
          <div className="flex items-center justify-center py-3">
            <span style={bigNum}>1.0.49</span>
          </div>
        </Card>

        {/* Скорость */}
        <Card padding="md">
          <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
          <div className="flex items-center justify-center gap-6 py-2">
            <div className="flex items-center gap-2">
              <ArrowDown className="w-7 h-7 shrink-0" style={{ color: "var(--color-success-400)" }} />
              <span style={bigNum}>124</span>
              <span className="text-xs shrink-0" style={muted}>Мбит/с</span>
            </div>
            <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-2">
              <ArrowUp className="w-7 h-7 shrink-0" style={{ color: "var(--color-warning-500)" }} />
              <span style={bigNum}>98</span>
              <span className="text-xs shrink-0" style={muted}>Мбит/с</span>
            </div>
          </div>
        </Card>

        {/* Пользователей */}
        <Card padding="md">
          <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
          <div className="flex items-center justify-center py-3">
            <span style={bigNum}>2</span>
          </div>
        </Card>
      </div>

      {/* Row 2: Безопасность + Нагрузка — оба упираются в правый край */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {/* Безопасность */}
        <Card padding="md">
          <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: false, label: "Выключен" },
              { name: "SSH-ключ", ok: false, label: "Нет" },
              { name: "TLS", ok: true, label: "89 дн." },
            ].map((item) => (
              <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
                <div className="text-sm" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Нагрузка */}
        <Card padding="md">
          <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
          <div className="space-y-2.5 mt-1">
            <div>
              <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>CPU</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span></div>
              <ProgressBar value={12} size="sm" color="success" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>RAM</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span></div>
              <ProgressBar value={33} size="sm" color="accent" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  ),
};
