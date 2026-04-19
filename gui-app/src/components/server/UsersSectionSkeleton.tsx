import { Card } from "../../shared/ui/Card";
import { Skeleton } from "../../shared/ui/Skeleton";

/**
 * UsersSectionSkeleton — shown while loadServerInfo is in-flight on the
 * Users tab (M-04 refresh flow). Mirrors the real UsersSection structure:
 * a Card header with title + plus-icon, and 3 user rows with
 * username + 3 inline icons (FileText, Settings, Trash). The skeleton
 * gives the operator a predictable silhouette — exactly the widgets they
 * expect, just lagging instead of rearranging.
 *
 * Kept intentionally static (no `pulse` variance) so the rendered DOM is
 * deterministic for snapshot tests and Storybook.
 */
export function UsersSectionSkeleton() {
  return (
    <Card>
      {/* Header — "Пользователи" title + plus-icon (matches UsersSection
          CardHeader action button). */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <Skeleton variant="line" width={120} height={16} />
        <Skeleton variant="card" width={32} height={32} />
      </div>

      {/* 3 user rows — 16px vertical each (matches py-2) with a 56px row
          height. Each row: username placeholder (flex-1) + 3 inline icons. */}
      <ul className="mb-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <div className="flex items-center justify-between px-3 py-2">
              <Skeleton variant="line" width={140} height={14} />
              <div className="flex items-center gap-[var(--space-0\.5)] shrink-0 ml-2">
                <Skeleton variant="card" width={32} height={32} />
                <Skeleton variant="card" width={32} height={32} />
                <Skeleton variant="card" width={32} height={32} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
