import { Skeleton } from "../../shared/ui/Skeleton";

// ═══════════════════════════════════════════════════════
// ServerPanelSkeleton — shown during first SSH connect
// ═══════════════════════════════════════════════════════
//
// Extracted VERBATIM from ControlPanelPage (Plan 04-08, PANEL-02 presentation
// layer). The rendered DOM/testids are byte-identical. The skeleton MUST mirror
// the loaded OverviewSection layout exactly (D-04 — the user treats a mismatch
// as a real bug). The 8-vs-10 / 3-vs-4 stub-count match is a Plan-12 fix with
// its own test — NOT touched here (Pitfall 2: never combine lift + fix).

// ── OverviewSkeletonCard — single card placeholder mirroring OverviewSection Card layout
function OverviewSkeletonCard({
  flex,
  maxWidth,
  body,
}: {
  flex: string;
  maxWidth?: number;
  body: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-[var(--space-4)]"
      style={{
        flex,
        maxWidth,
        backgroundColor: "var(--color-bg-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Title row — icon + label (left), refresh slot (right) — matches OverviewSection Title height */}
      <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
        <div className="flex items-center gap-2 h-full">
          <Skeleton variant="card" width={20} height={20} />
          <Skeleton variant="line" width={90} height={14} />
        </div>
        <Skeleton variant="card" width={32} height={32} />
      </div>
      {body}
    </div>
  );
}

export function ServerPanelSkeleton() {
  // Mirrors OverviewSection grid: flex-wrap, gap 12px, 10 cards in 3 rows.
  // Card flex/maxWidth values copied from OverviewSection.tsx so collapse points match.
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar skeleton — 5 tab pills + separator + disconnect icon (matches ServerTabs) */}
      <div className="px-6 shrink-0">
        <div
          className="flex items-center gap-1"
          style={{ borderBottom: "1px solid var(--color-border)", paddingTop: "4px", paddingBottom: "4px" }}
        >
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} variant="card" className="flex-1" height={32} />
          ))}
          <div className="shrink-0 mx-2 self-stretch my-1.5" style={{ width: "1px", backgroundColor: "var(--color-border)" }} />
          <Skeleton variant="card" width={32} height={32} className="shrink-0" />
        </div>
      </div>

      {/* Content area — mirrors OverviewSection 10-card layout */}
      <div className="flex-1 py-4 px-6 overflow-hidden">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

          {/* ── Row 1: Status | Ping | Speed | Users ── */}
          <OverviewSkeletonCard
            flex="1 1 220px"
            body={
              <div className="flex flex-col items-center justify-center gap-1.5 py-1">
                <Skeleton variant="card" width={120} height={28} />
                <Skeleton variant="line" width={60} height={12} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 140px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={70} height={32} />
              </div>
            }
          />
          {/* Speed skeleton — compact (Phase 13.UAT): меньше gap, более узкая карточка */}
          <OverviewSkeletonCard
            flex="1 1 280px"
            maxWidth={360}
            body={
              <div className="flex items-center justify-center gap-4 py-2" style={{ minHeight: 48 }}>
                <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
                  <Skeleton variant="circle" width={24} height={24} />
                  <Skeleton variant="line" width={60} height={28} />
                </div>
                <div className="h-7 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
                <div className="flex items-center gap-1.5" style={{ minWidth: 100 }}>
                  <Skeleton variant="circle" width={24} height={24} />
                  <Skeleton variant="line" width={60} height={28} />
                </div>
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 180px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={50} height={32} />
              </div>
            }
          />

          {/* ── Row 2: IP | Country | Uptime | Version ── */}
          <OverviewSkeletonCard
            flex="1 1 240px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={140} height={32} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 180px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={120} height={28} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 160px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={80} height={28} />
              </div>
            }
          />
          <OverviewSkeletonCard
            flex="1 1 220px"
            body={
              <div className="flex items-center justify-center py-2">
                <Skeleton variant="line" width={100} height={32} />
              </div>
            }
          />

          {/* ── Row 3: Security (3 sub-tiles) | Load (CPU + RAM bars) ── */}
          {/* G-09: flex-basis 300 каждая — Security+Load помещаются в одну строку
              даже при minWidth 800px контейнера. Раньше split в отдельный ряд.
              D-04 / H-03 (Plan 04-14): 3 sub-tiles (Firewall / Fail2Ban / TLS) to
              match the loaded OverviewSection layout EXACTLY — the SSH-key tile
              was removed in Phase 16, so a 4-tile skeleton produced a 4→3
              layout jump after data loaded. */}
          <OverviewSkeletonCard
            flex="1 1 300px"
            body={
              <div className="grid grid-cols-2 gap-2 mt-1">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    data-testid="security-skeleton-tile"
                    className="rounded-[var(--radius-md)] px-3 py-2"
                    style={{ backgroundColor: "var(--color-bg-elevated)" }}
                  >
                    <Skeleton variant="line" width={70} height={12} className="mb-1.5" />
                    <Skeleton variant="line" width={50} height={12} />
                  </div>
                ))}
              </div>
            }
          />
          {/* Load skeleton — matches Screens/Overview Cards 10c (no CPU/RAM text, full skeletons) */}
          <OverviewSkeletonCard
            flex="1 1 300px"
            body={
              <div className="space-y-2.5 mt-1">
                {[1, 2].map((i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1">
                      <Skeleton variant="line" width={30} height={20} />
                      <Skeleton variant="line" width={60} height={20} />
                    </div>
                    <Skeleton variant="line" width="100%" height={6} />
                  </div>
                ))}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
