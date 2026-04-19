import { Card } from "../../shared/ui/Card";
import { Divider } from "../../shared/ui/Divider";
import { Skeleton } from "../../shared/ui/Skeleton";

/**
 * UsersSectionSkeleton — placeholder для таба «Пользователи» пока
 * идёт refresh (M-04 flow). Mirror'ит реальный UsersSection:
 *   1. 3 row × (username line + 3 inline action icons).
 *   2. Divider.
 *   3. Full-width «Добавить пользователя» button (secondary entry).
 *
 * Header-card и title-skeleton опущены — в UsersSection их нет,
 * секция начинается сразу со списка. Skeleton rendered in-place
 * (Card wrapper), без pulse — DOM детерминистичен для снапшот
 * тестов и Storybook preview.
 */
export function UsersSectionSkeleton() {
  return (
    <Card>
      {/* 3 user rows — совпадают с реальным UsersSection layout:
          username занимает остаток ширины, справа — 3 action icons
          (FileText / Settings / Trash). */}
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

      <Divider className="my-3" />

      {/* «Добавить пользователя» — kbd full-width button silhouette.
          Высота 36px совпадает с Button size="md" + fullWidth. */}
      <Skeleton variant="card" height={36} />
    </Card>
  );
}
