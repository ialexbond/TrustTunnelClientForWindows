// Storybook mock for @tauri-apps/api/event
export const listen = async (_event: string, _handler: Function): Promise<() => void> => {
  return () => {};
};

export const emit = async (_event: string, _payload?: unknown): Promise<void> => {
  return undefined;
};
