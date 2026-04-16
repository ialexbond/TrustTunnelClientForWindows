import type { Meta, StoryObj } from "@storybook/react";
import {
  HeartPulse,
  Package,
  Zap,
  Users,
  Shield,
  Gauge,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  RefreshCw,
  ArrowUpCircle,
} from "lucide-react";
import { StatusIndicator } from "./StatusIndicator";
import { ProgressBar } from "./ProgressBar";
import { Card } from "./Card";

/* ═══════════════════════════════════════════════════════
   StatCard Overview Variants v2

   Каждая карточка:
   - Тайтл с иконкой ВВЕРХУ (как в Overview Mockup All Data)
   - Крупные цифры clamp() (как в прошлом макете)
   - Индивидуальный размер — width: fit-content, нет фиксированного grid
   - Стилистика StatCard (icon accent, Card wrapper)
   ═══════════════════════════════════════════════════════ */

const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const accent = { color: "var(--color-accent-interactive)" };
const bigNum = { fontSize: "clamp(2rem, 4vw, 2.8rem)", fontWeight: 600, lineHeight: 1, color: "var(--color-text-primary)" } as const;

function Title({ icon, text, onRefresh, clickable }: { icon: React.ReactNode; text: string; onRefresh?: boolean; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between" style={{ height: 32 }}>
      <div className="flex items-center gap-2 h-full">
        <span className="flex items-center justify-center w-5 h-5 shrink-0" style={accent}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{text}</span>
      </div>
      <div className="flex items-center gap-1 h-full">
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
  decorators: [(S) => <div style={{ width: 260, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
      <div className="flex items-center gap-2 mt-3 mb-3">
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
          <span className="text-sm" style={primary}>🇩🇪 Германия</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm" style={muted}>Uptime</span>
          <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span>
        </div>
      </div>
    </Card>
  ),
};

/* ── 2. Версия протокола ── */
export const Version: Story = {
  name: "2. Версия протокола",
  decorators: [(S) => <div style={{ width: 220, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center mt-4">
        <span style={bigNum}>1.0.49</span>
      </div>
    </Card>
  ),
};

export const VersionUpdate: Story = {
  name: "2b. Версия (обновление)",
  decorators: [(S) => <div style={{ width: 220, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center gap-2 mt-4">
        <span style={bigNum}>1.0.47</span>
        <ArrowUpCircle className="w-6 h-6" style={{ color: "var(--color-warning-500)" }} />
      </div>
    </Card>
  ),
};

/* ── 3. Скорость (как прошлый дизайн — стрелки + separator) ── */
export const Speed: Story = {
  name: "3. Скорость",
  decorators: [(S) => <div style={{ width: 340, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center mt-3">
        <div className="flex items-center gap-2">
          <ArrowDown className="w-8 h-8" style={{ color: "var(--color-success-400)" }} />
          <span style={bigNum}>124</span>
          <span className="text-xs" style={muted}>Мбит/с</span>
        </div>
        <div className="mx-4 h-8" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
        <div className="flex items-center gap-2">
          <ArrowUp className="w-8 h-8" style={{ color: "var(--color-warning-500)" }} />
          <span style={bigNum}>98</span>
          <span className="text-xs" style={muted}>Мбит/с</span>
        </div>
      </div>
    </Card>
  ),
};

export const SpeedNotMeasured: Story = {
  name: "3b. Скорость (не замерена)",
  decorators: [(S) => <div style={{ width: 340, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center mt-4">
        <span className="text-sm" style={muted}>Не замерена</span>
      </div>
    </Card>
  ),
};

/* ── 4. Пользователей ── */
export const UsersCount: Story = {
  name: "4. Пользователей",
  decorators: [(S) => <div style={{ width: 180, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
      <div className="flex items-center justify-center mt-3">
        <span style={bigNum}>2</span>
      </div>
    </Card>
  ),
};

/* ── 5. Безопасность ── */
export const Security: Story = {
  name: "5. Безопасность",
  decorators: [(S) => <div style={{ width: 260, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {[
          { name: "Firewall", ok: true, label: "Активен" },
          { name: "Fail2Ban", ok: false, label: "Выключен" },
          { name: "SSH-ключ", ok: false, label: "Нет" },
          { name: "TLS", ok: true, label: "89 дн." },
        ].map((item) => (
          <div
            key={item.name}
            className="rounded-[var(--radius-sm)] px-2.5 py-1.5"
            style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}
          >
            <div className="text-xs font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
            <div className="text-xs" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</div>
          </div>
        ))}
      </div>
    </Card>
  ),
};

/* ── 6. Нагрузка ── */
export const Load: Story = {
  name: "6. Нагрузка",
  decorators: [(S) => <div style={{ width: 300, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>],
  render: () => (
    <Card padding="md">
      <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
      <div className="mt-3 space-y-2.5">
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm" style={muted}>CPU</span>
            <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span>
          </div>
          <ProgressBar value={12} size="sm" color="success" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm" style={muted}>RAM</span>
            <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
          </div>
          <ProgressBar value={33} size="sm" color="accent" />
        </div>
      </div>
    </Card>
  ),
};

/* ── Все вместе — разноразмерные ── */
export const AllCards: Story = {
  name: "Все карточки",
  decorators: [(S) => <div style={{ width: 900, backgroundColor: "var(--color-bg-primary)", padding: 16 }}><S /></div>],
  render: () => (
    <div className="flex flex-col gap-3">
      {/* Row 1 */}
      <div className="flex gap-3">
        {/* Статус — широкий */}
        <Card padding="md" className="flex-[2]">
          <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" onRefresh />
          <div className="flex items-center gap-2 mt-3 mb-3">
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
              <span className="text-sm" style={primary}>🇩🇪 Германия</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={muted}>Uptime</span>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>14д 7ч</span>
            </div>
          </div>
        </Card>

        {/* Версия */}
        <Card padding="md" className="flex-[1]">
          <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
          <div className="flex items-center justify-center mt-4">
            <span style={bigNum}>1.0.49</span>
          </div>
        </Card>

        {/* Скорость — самый широкий */}
        <Card padding="md" className="flex-[2.5]">
          <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
          <div className="flex items-center justify-center mt-3">
            <div className="flex items-center gap-2">
              <ArrowDown className="w-8 h-8" style={{ color: "var(--color-success-400)" }} />
              <span style={bigNum}>124</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
            <div className="mx-4 h-8" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
            <div className="flex items-center gap-2">
              <ArrowUp className="w-8 h-8" style={{ color: "var(--color-warning-500)" }} />
              <span style={bigNum}>98</span>
              <span className="text-xs" style={muted}>Мбит/с</span>
            </div>
          </div>
        </Card>

        {/* Пользователей — узкий */}
        <Card padding="md" className="flex-[0.7]">
          <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
          <div className="flex items-center justify-center mt-3">
            <span style={bigNum}>2</span>
          </div>
        </Card>
      </div>

      {/* Row 2 */}
      <div className="flex gap-3">
        {/* Безопасность */}
        <Card padding="md" className="flex-[1]">
          <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {[
              { name: "Firewall", ok: true, label: "Активен" },
              { name: "Fail2Ban", ok: false, label: "Выключен" },
              { name: "SSH-ключ", ok: false, label: "Нет" },
              { name: "TLS", ok: true, label: "89 дн." },
            ].map((item) => (
              <div key={item.name} className="rounded-[var(--radius-sm)] px-2.5 py-1.5"
                style={{ backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)" }}>
                <div className="text-xs font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
                <div className="text-xs" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Нагрузка — шире */}
        <Card padding="md" className="flex-[1.5]">
          <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
          <div className="mt-3 space-y-2.5">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm" style={muted}>CPU</span>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span>
              </div>
              <ProgressBar value={12} size="sm" color="success" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm" style={muted}>RAM</span>
                <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span>
              </div>
              <ProgressBar value={33} size="sm" color="accent" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  ),
};
