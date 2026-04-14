// Storybook mock for @tauri-apps/plugin-dialog
export const open = async (_options?: unknown): Promise<string | string[] | null> => {
  console.warn("[Storybook] Tauri plugin-dialog open called");
  return null;
};

export const save = async (_options?: unknown): Promise<string | null> => {
  console.warn("[Storybook] Tauri plugin-dialog save called");
  return null;
};
