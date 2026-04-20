import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const skeletonVariants = cva(
  "animate-[skeleton-pulse_var(--pulse-duration)_var(--pulse-easing)_infinite] bg-[var(--color-bg-elevated)]",
  {
    variants: {
      variant: {
        line: "rounded-[var(--radius-md)] h-3",
        circle: "rounded-full",
        card: "rounded-[var(--radius-lg)]",
      },
    },
    defaultVariants: { variant: "line" },
  }
);

export interface SkeletonProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof skeletonVariants> {
  width?: number | string;
  height?: number | string;
  rounded?: boolean;
}

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ variant, width, height, rounded, className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(skeletonVariants({ variant }), rounded && "rounded-full", className)}
      style={{ width, height, ...style }}
      aria-hidden="true"
      {...props}
    />
  )
);
Skeleton.displayName = "Skeleton";
