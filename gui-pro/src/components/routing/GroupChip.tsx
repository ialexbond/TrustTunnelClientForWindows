import { useTranslation } from "react-i18next";
import { Layers, Trash2, ArrowRight } from "lucide-react";
import { IconButton } from "../../shared/ui/IconButton";
import type { RuleEntry, RouteAction } from "./useRoutingState";

interface GroupChipProps {
  entry: RuleEntry;
  currentAction: RouteAction;
  /** Локализованное отображаемое имя группы (для iplist_group — из iplistGroups, для geosite — value). */
  label: string;
  onRemove: (id: string) => void;
  onMove: (id: string, toAction: RouteAction) => void;
}

// Тинт пилюли и цвет глифа наследуют цвет блока-цели (успех/акцент/опасность). Глиф — ПЕРЕДНИЙ план,
// поэтому берём тема-зависимый -fg токен (не сырой -500: на светлой теме -500 слишком светлый и
// проваливает контраст — см. 22-DESIGN-AUDIT §1). Тинт — заливка, остаётся -tint.
const chipTint: Record<RouteAction, string> = {
  direct: "var(--color-success-tint-12)",
  proxy: "var(--color-accent-tint-10)",
  block: "var(--color-danger-tint-10)",
};

const chipColor: Record<RouteAction, string> = {
  direct: "var(--color-success-fg)",
  proxy: "var(--color-accent-fg)",
  block: "var(--color-danger-fg)",
};

// Куда можно перенести элемент из текущего блока. Та же карта и тот же порядок, что в RuleEntryRow.tsx
// (одиночные правила) — держать в синхроне: у чипа-группы и у обычной строки ОДИН контрол переноса.
// block перечисляет оба направления для целостности данных, хотя блок-карта block скрыта.
const moveTargets: Record<RouteAction, RouteAction[]> = {
  direct: ["proxy"],
  proxy: ["direct"],
  block: ["direct", "proxy"],
};

// Цвет стрелки-цели = цвет блока назначения (тема-зависимый -fg, как глиф). Совпадает с RuleEntryRow.
const arrowColor: Record<RouteAction, string> = {
  direct: "var(--color-success-fg)",
  proxy: "var(--color-accent-fg)",
  block: "var(--color-danger-fg)",
};

/**
 * Строка группы ВНУТРИ блока: глиф-«слои» + локализованное имя (пилюля в цвете блока) + перенос
 * между блоками СТРЕЛКАМИ (та же анатомия, что у одиночного правила RuleEntryRow — один паттерн на всю
 * вкладку, без «многоточия»/OverflowMenu) + всегда видимое удаление (Trash2).
 *
 * Перенос: по одной кнопке-стрелке ArrowRight на каждую цель (proxy→direct: одна; block→direct+proxy:
 * две), появляются при наведении на строку (opacity-0 group-hover), tooltip/aria = «Переместить в …»,
 * клик зовёт onMove(entry.id, target) → moveEntry (дедуп на цели живёт в moveEntry, новой логики нет).
 * Клавиатуро-доступно: каждая стрелка — обычная фокусируемая кнопка (D-02: без мышиного drag).
 */
export function GroupChip({ entry, currentAction, label, onRemove, onMove }: GroupChipProps) {
  const { t } = useTranslation();
  const targets = moveTargets[currentAction];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg group hover:bg-[var(--color-bg-hover)] transition-colors">
      {/* Пилюля группы: глиф-«слои» отличает набор от одиночного правила-адреса; тинт = цвет блока. */}
      <span
        className="inline-flex items-center gap-1.5 rounded-full border py-1 pl-2.5 pr-3 min-w-0"
        style={{ backgroundColor: chipTint[currentAction], borderColor: "var(--color-border)" }}
      >
        <Layers
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: chipColor[currentAction] }}
          aria-hidden="true"
        />
        <span
          className="text-xs font-medium truncate"
          style={{ color: "var(--color-text-primary)" }}
        >
          {label}
        </span>
      </span>

      {/* Спейсер уводит управление к правому краю, не растягивая пилюлю. */}
      <span className="flex-1" />

      {/* Перенос между блоками — стрелки ArrowRight (по одной на цель), появляются при наведении.
          Тот же контрол, что у одиночного правила RuleEntryRow (D-1: единый паттерн, без «...»). */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {targets.map((target) => (
          <IconButton
            key={target}
            aria-label={t(`routing.moveTo_${target}`, { defaultValue: target })}
            tooltip={t(`routing.moveTo_${target}`, { defaultValue: target })}
            icon={<ArrowRight className="w-3 h-3" style={{ color: arrowColor[target] }} />}
            onClick={() => onMove(entry.id, target)}
          />
        ))}
      </div>

      {/* Удаление — всегда видно (canon «Удаление всегда видно»): без opacity-0/hover-гейта. */}
      <IconButton
        aria-label={t("routing.removeEntry")}
        tooltip={t("routing.removeEntry")}
        icon={<Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-fg)" }} />}
        onClick={() => onRemove(entry.id)}
        className="hover:bg-[var(--color-danger-tint-10)]"
      />
    </div>
  );
}
