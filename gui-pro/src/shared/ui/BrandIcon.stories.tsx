import type { Meta, StoryObj } from "@storybook/react";

/**
 * Preview композитной program-icon: rounded square background + shield
 * внутри. Используется в installer / taskbar / Start menu вместо
 * plain-shield PNG.
 *
 * **Two editions** (bg color из accent scale в tokens.css):
 *   - **Pro**   → bg `#0b2221` (accent-900, dark teal) — для gui-pro/
 *   - **Light** → bg `#f0f4f4` (accent-50, light slate) — для gui-light/
 *
 * Shield (source: `public/logo/shield-dark.svg`) одинаковый в обоих
 * edition — меняется только фон под ним. Brand identity сохраняется.
 *
 * Radius ratio 0.25 (64 / 256) — «сильно закруглённый» Apple/iOS
 * app-icon стиль. Shield занимает 80% bounding box с центровкой.
 */

const BG_PRO = "#0b2221";    // accent-900 (darkest)
const BG_LIGHT = "#f0f4f4";  // accent-50 (lightest)

interface BrandIconProps {
  /** Final icon size in pixels. Preview рендерит scaled копию. */
  size: number;
  /** Background color. Default — token #0b2221 (darkest accent). */
  bg?: string;
  /** Shield SVG source. Dark-variant — читабельный на тёмном фоне. */
  shieldSrc?: string;
  /** Radius ratio относительно размера. 0.25 = Apple app-icon. */
  radiusRatio?: number;
  /** Shield size ratio — 0.7 = 70% от bounding box. */
  shieldRatio?: number;
}

function BrandIcon({
  size,
  bg = "#0b2221",
  shieldSrc = "/logo/shield-dark.svg",
  radiusRatio = 0.2,
  shieldRatio = 0.8,
}: BrandIconProps) {
  const shieldSize = Math.round(size * shieldRatio);
  const padding = Math.round((size - shieldSize) / 2);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * radiusRatio,
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <img
        src={shieldSrc}
        alt="TrustTunnel"
        width={shieldSize}
        height={shieldSize}
        draggable={false}
      />
    </div>
  );
}

const meta: Meta<typeof BrandIcon> = {
  title: "Brand/AppIcon",
  component: BrandIcon,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    size: { control: { type: "range", min: 16, max: 512, step: 8 } },
    radiusRatio: { control: { type: "range", min: 0, max: 0.5, step: 0.01 } },
    shieldRatio: { control: { type: "range", min: 0.4, max: 0.9, step: 0.01 } },
    bg: { control: "color" },
    shieldSrc: {
      control: "select",
      options: ["/logo/shield-dark.svg", "/logo/shield-light.svg"],
      description: "dark — для светлого bg (high contrast); light — для тёмного bg",
    },
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

/** Pro edition — dark teal bg (accent-900) + shield-dark. Для gui-pro/. */
export const Pro: Story = {
  args: {
    size: 256,
    radiusRatio: 0.2,
    shieldRatio: 0.8,
    bg: BG_PRO,
    shieldSrc: "/logo/shield-dark.svg",
  },
};

/** Light edition — light slate bg (accent-50) + shield-light. Для gui-light/. */
export const Light: Story = {
  args: {
    size: 256,
    radiusRatio: 0.2,
    shieldRatio: 0.8,
    bg: BG_LIGHT,
    shieldSrc: "/logo/shield-light.svg",
  },
};

/**
 * Radius comparison — 0.15 / 0.20 / 0.25 на обоих editions.
 * Для final выбора corner rounding. Current canonical: 0.20.
 */
export const RadiusComparison: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {(["Pro", "Light"] as const).map((edition) => {
        const bg = edition === "Pro" ? BG_PRO : BG_LIGHT;
        const shield = edition === "Pro" ? "/logo/shield-dark.svg" : "/logo/shield-light.svg";
        return (
          <div key={edition}>
            <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>{edition} edition</div>
            <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
              {[0.15, 0.20, 0.25].map((r) => (
                <div key={r} style={{ textAlign: "center" }}>
                  <BrandIcon size={128} bg={bg} shieldSrc={shield} radiusRatio={r} />
                  <div style={{ marginTop: 8, fontSize: 11, fontFamily: "monospace" }}>radius {r}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  ),
};

/**
 * Side-by-side Pro (dark bg) и Light (light bg) — brand identity
 * check: одинаковый shield, два разных accent-контекста.
 */
export const ProVsLight: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 32, alignItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <BrandIcon size={256} bg={BG_PRO} shieldSrc="/logo/shield-dark.svg" />
        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>Pro edition</div>
        <div style={{ marginTop: 2, fontSize: 11, color: "#666", fontFamily: "monospace" }}>bg: {BG_PRO}</div>
        <div style={{ marginTop: 2, fontSize: 11, color: "#666" }}>shield-dark</div>
      </div>
      <div style={{ textAlign: "center" }}>
        <BrandIcon size={256} bg={BG_LIGHT} shieldSrc="/logo/shield-light.svg" />
        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>Light edition</div>
        <div style={{ marginTop: 2, fontSize: 11, color: "#666", fontFamily: "monospace" }}>bg: {BG_LIGHT}</div>
        <div style={{ marginTop: 2, fontSize: 11, color: "#666" }}>shield-light</div>
      </div>
    </div>
  ),
};

/**
 * Все реальные размеры bundle'а side-by-side — Pro + Light, смотришь
 * как выглядит в Start menu (32), Taskbar (32), Explorer large
 * thumbnail (128), .ico high-res (256).
 */
export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div>
        <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>Pro edition</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          {[16, 24, 32, 48, 64, 128, 256].map((s) => (
            <div key={s} style={{ textAlign: "center", fontSize: 11 }}>
              <BrandIcon size={s} bg={BG_PRO} />
              <div style={{ marginTop: 4, color: "#888" }}>{s}px</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 600 }}>Light edition (shield-light)</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          {[16, 24, 32, 48, 64, 128, 256].map((s) => (
            <div key={s} style={{ textAlign: "center", fontSize: 11 }}>
              <BrandIcon size={s} bg={BG_LIGHT} shieldSrc="/logo/shield-light.svg" />
              <div style={{ marginTop: 4, color: "#888" }}>{s}px</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};

/**
 * Как обе editions выглядят на реальных desktop backgrounds — 4 комбинации
 * (Pro+light-desktop, Pro+dark-desktop, Light+light-desktop, Light+dark-desktop).
 * Проверка что рамка/shield читаются в каждом контексте.
 */
export const DesktopContext: Story = {
  render: () => {
    const combos = [
      { label: "Pro on light desktop",  bgDesktop: "#f5f5f5", bgIcon: BG_PRO,   shield: "/logo/shield-dark.svg"  },
      { label: "Pro on dark desktop",   bgDesktop: "#202020", bgIcon: BG_PRO,   shield: "/logo/shield-dark.svg"  },
      { label: "Light on light desktop", bgDesktop: "#f5f5f5", bgIcon: BG_LIGHT, shield: "/logo/shield-light.svg" },
      { label: "Light on dark desktop",  bgDesktop: "#202020", bgIcon: BG_LIGHT, shield: "/logo/shield-light.svg" },
    ];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {combos.map(({ label, bgDesktop, bgIcon, shield }) => (
          <div key={label} style={{ background: bgDesktop, padding: 24, borderRadius: 8, textAlign: "center" }}>
            <BrandIcon size={128} bg={bgIcon} shieldSrc={shield} />
            <div style={{ marginTop: 12, fontSize: 11, color: bgDesktop === "#202020" ? "#aaa" : "#666" }}>{label}</div>
          </div>
        ))}
      </div>
    );
  },
};

