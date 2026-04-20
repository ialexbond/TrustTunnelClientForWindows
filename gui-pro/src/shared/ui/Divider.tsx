import { cn } from "../lib/cn";

interface DividerProps {
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export function Divider({ orientation = "horizontal", className }: DividerProps) {
  if (orientation === "vertical") {
    return (
      <div
        aria-hidden="true"
        className={cn("w-px self-stretch bg-[var(--color-border)]", className)}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={cn("h-px w-full bg-[var(--color-border)]", className)}
    />
  );
}
