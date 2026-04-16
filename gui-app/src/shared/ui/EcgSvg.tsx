/**
 * EcgSvg — анимированная ECG-линия с 12-слойным градиентным хвостом.
 *
 * Используется в карточке «Статус» таба «Обзор».
 * - Работает: зелёный пульс (ecgHeartbeat path)
 * - Остановлен: красная плоская линия (ecgFlatline path)
 * - Каждый слой — stroke-dasharray с animationDelay,
 *   opacity нарастает экспоненциально от хвоста к голове.
 * - CSS @keyframes инжектируется внутри SVG <style>.
 */

/** ECG path — двойной зигзаг на 30% и 70% пути */
export const ecgHeartbeat =
  "M0,18 L36,18 L40,18 L44,4 L48,32 L52,10 L56,22 L60,18 L100,18 L104,18 L108,4 L112,32 L116,10 L120,22 L124,18 L160,18";

/** Плоская линия — для состояния «Остановлен» */
export const ecgFlatline = "M0,18 L160,18";

/** 12 слоёв градиентного хвоста */
const layers = [
  { dash: "36 184", opacity: 0.02, delay: "0s" },
  { dash: "33 187", opacity: 0.04, delay: "-0.05s" },
  { dash: "30 190", opacity: 0.07, delay: "-0.1s" },
  { dash: "27 193", opacity: 0.10, delay: "-0.15s" },
  { dash: "24 196", opacity: 0.14, delay: "-0.2s" },
  { dash: "21 199", opacity: 0.20, delay: "-0.25s" },
  { dash: "18 202", opacity: 0.28, delay: "-0.3s" },
  { dash: "15 205", opacity: 0.38, delay: "-0.35s" },
  { dash: "12 208", opacity: 0.50, delay: "-0.4s" },
  { dash: "9 211",  opacity: 0.65, delay: "-0.45s" },
  { dash: "6 214",  opacity: 0.82, delay: "-0.5s" },
  { dash: "3 217",  opacity: 1.0,  delay: "-0.55s" },
];

interface EcgSvgProps {
  /** CSS color — var(--color-success-500) или var(--color-danger-500) */
  color: string;
  /** SVG path data — ecgHeartbeat или ecgFlatline */
  path: string;
  /** Уникальное имя @keyframes (для изоляции в DOM) */
  anim: string;
}

export function EcgSvg({ color, path, anim }: EcgSvgProps) {
  return (
    <svg width="160" height="36" viewBox="0 0 160 36" fill="none">
      <style>{`@keyframes ${anim} { from { stroke-dashoffset: 20; } to { stroke-dashoffset: -100; } }`}</style>
      <path
        d={path}
        stroke={color}
        strokeWidth="1.5"
        fill="none"
        opacity="0.15"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
      />
      {layers.map((l, i) => (
        <path
          key={i}
          d={path}
          stroke={color}
          strokeWidth="2"
          fill="none"
          opacity={l.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          style={{
            strokeDasharray: l.dash,
            animation: `${anim} 2s linear infinite`,
            animationDelay: l.delay,
          }}
        />
      ))}
    </svg>
  );
}
