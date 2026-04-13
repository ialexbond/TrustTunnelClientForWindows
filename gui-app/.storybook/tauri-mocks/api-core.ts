// Storybook mock for @tauri-apps/api/core
export const invoke = async (_command: string, _args?: unknown): Promise<unknown> => {
  console.warn(`[Storybook] Tauri invoke called: ${_command}`);
  return null;
};
