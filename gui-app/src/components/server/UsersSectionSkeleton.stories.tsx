import type { Meta, StoryObj } from "@storybook/react";
import { UsersSectionSkeleton } from "./UsersSectionSkeleton";

/**
 * UsersSectionSkeleton preview story. Placeholder shown while
 * `loadServerInfo()` fetches the users list on tab activation (M-04).
 * Mirrors the real rows: Card header + 3 rows × (username + 3 action
 * icons) — так silhouette совпадает с финальным UI.
 */
const meta: Meta<typeof UsersSectionSkeleton> = {
  title: "Screens/UsersSection/Skeleton",
  component: UsersSectionSkeleton,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
