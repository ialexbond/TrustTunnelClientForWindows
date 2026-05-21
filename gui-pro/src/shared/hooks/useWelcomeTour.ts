import { useCallback, useState } from "react";

/**
 * Phase 18 — Welcome onboarding tour state hook (single-purpose localStorage encapsulation).
 *
 * Хранит флаг прохождения 3-step welcome-тура в `localStorage` под ключом
 * `tt_welcome_completed`. Значение строковое — `"true"` означает «тур завершён или
 * пропущен, больше не показывать». Любое другое значение (или отсутствие ключа)
 * трактуется как `completed === false`, и `App.tsx` смонтирует overlay.
 *
 * Поведение mirrors шаблон `tt_auth_method_<host>` из CLAUDE.md — literal string
 * `"true"` единственное valid completion-значение.
 *
 * @example
 * ```tsx
 * const { completed, complete } = useWelcomeTour();
 * if (!completed) return <WelcomeTour onComplete={complete} />;
 * ```
 *
 * @returns `completed` — boolean; true если тур уже пройден/пропущен.
 *          `complete()` — отмечает тур как завершённый (пишет localStorage + state).
 *          `reset()` — стирает флаг (для dev/debug, **НЕ exposed в UI**).
 */
export function useWelcomeTour(): {
  completed: boolean;
  complete: () => void;
  reset: () => void;
} {
  const [completed, setCompleted] = useState<boolean>(() => {
    return localStorage.getItem("tt_welcome_completed") === "true";
  });

  const complete = useCallback(() => {
    localStorage.setItem("tt_welcome_completed", "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem("tt_welcome_completed");
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}
