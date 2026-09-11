import { useState } from "react";
import { ChangelogModal } from "./ChangelogModal";
import { AboutHero } from "./about/AboutHero";
import { AppInfoCard } from "./about/AppInfoCard";
import { FooterLinks } from "./about/FooterLinks";
import { UpdateCard } from "./about/UpdateCard";
import type { UpdateInfo } from "../shared/types";

interface AboutPanelProps {
  updateInfo: UpdateInfo;
  onCheckUpdates: () => void;
  onOpenDownload: () => void;
}

/**
 * The «О программе» tab: four blocks in one column, and nothing else.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT STOPPED BEING THAT.
 *
 * Before phase 30 this was 329 lines: the hero, the update block with its own `self_update` call,
 * its `update-progress` listener and its progress state, the description block, the footer row —
 * all inline, all in one file, and all wrapped in a 384px-capped column that was vertically centred
 * in the viewport. (The capping utility is not named here on purpose — this plan's acceptance check
 * is a blunt count of it in this file, and a comment that spells it out would trip the very rule it
 * explains.) Two things were wrong with that shape.
 *
 *  · It was the LAST screen in the application living by its own layout rules. «Настройки» and
 *    «Маршрутизация» are a full-height flex column with a hidden overflow, holding one scrolling
 *    region with the tab's own padding and a single full-width stack inside it. This tab now uses
 *    exactly that rhythm (see `AppSettingsPanel`), so the four blocks are as wide as the window
 *    allows instead of being pinned to a 384px ribbon floating in the middle of an empty screen.
 *  · Everything it drew inline is now a component with its own tests and its own showcase entry, so
 *    keeping a second copy here would mean two drawings of one screen, drifting apart quietly.
 *
 * WHAT IT OWNS NOW: the block order, and the changelog window's open/closed state. That is all.
 * The check callback, the download callback and the update state pass straight through to the card;
 * the self-update call, the progress listener and the progress bar live in the card because it is
 * the only thing that reads them.
 *
 * THE PROP CONTRACT WITH `App.tsx` IS UNCHANGED — `updateInfo`, `onCheckUpdates`, `onOpenDownload`.
 * In particular no second «retry» callback was threaded through: a retry IS a check, so the card
 * calls the same handler for both, and adding a parallel prop would have opened a second path into
 * the update machinery for no behaviour that does not already exist (T-30-30).
 *
 * THE STATUS-PANEL SLOT IS NOT OURS. `App.tsx` renders `statusPanelFor("about")` as this
 * component's SIBLING inside the tabpanel, above it in the same flex column — unlike «Настройки»,
 * which takes it as a prop and mounts it itself. Reimplementing it here would paint it twice.
 */
function AboutPanel({ updateInfo, onCheckUpdates, onOpenDownload }: AboutPanelProps) {
  const [changelogOpen, setChangelogOpen] = useState(false);

  // The single source of the displayed version: the value the update check reported, falling back
  // to the frozen product version when it has not answered yet. `AboutHero` deliberately takes no
  // default of its own, so this stays the one place the fallback is written.
  const version = updateInfo.currentVersion || "3.0.0";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* One scrolling region carrying the tab's own padding, and one column inside it with the
          design's gap — the same two-element shape `AppSettingsPanel` uses, so the two tabs cannot
          disagree about the screen's margins. `scroll-overlay` keeps the scrollbar off the layout,
          which is what lets the widest block measure the full 968px the screen contract names. */}
      <div className="flex-1 scroll-overlay py-3 px-4 flex flex-col gap-[var(--space-4)]">
        <AboutHero version={version} buildHash={__BUILD_HASH__} />

        {/* The panel supplies the state it already receives from App.tsx plus the one callback the
            card cannot own: opening the changelog window that this panel mounts below. */}
        <UpdateCard
          updateInfo={updateInfo}
          onCheck={onCheckUpdates}
          onOpenDownload={onOpenDownload}
          onOpenChangelog={() => setChangelogOpen(true)}
        />

        <AppInfoCard />

        <FooterLinks />
      </div>

      {/* Окно «Что нового» (фаза 30). Раньше сюда передавалась ОДНА строка заметок — та, что
          приехала с проверкой обновлений, — и потому окно могло рассказать только про версию,
          которой у пользователя ещё нет. Теперь у окна два источника, и установленную порцию оно
          достаёт само из вложенного в сборку файла: панель не разбирает файл за него и не передаёт
          готовое тело, иначе источник установленной порции размазался бы по двум местам.

          Порция новой версии передаётся ТОЛЬКО когда обновление действительно найдено: `available`,
          а не просто непустая строка заметок — ответ проверки может нести текст выпуска и тогда,
          когда установлена уже самая свежая версия. */}
      <ChangelogModal
        isOpen={changelogOpen}
        onClose={() => setChangelogOpen(false)}
        installedVersion={version}
        availableVersion={updateInfo.available ? updateInfo.latestVersion : undefined}
        availableNotes={updateInfo.available ? updateInfo.releaseNotes || undefined : undefined}
      />
    </div>
  );
}

export default AboutPanel;
