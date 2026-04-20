// Storybook mock for @tauri-apps/api/window
const windowMock = {
  minimize: async () => {},
  toggleMaximize: async () => {},
  close: async () => {},
  setTitle: async (_title: string) => {},
  show: async () => {},
  hide: async () => {},
  onCloseRequested: async (_handler: Function) => () => {},
  listen: async (_event: string, _handler: Function) => () => {},
};

export const getCurrentWindow = () => windowMock;
export class Window {
  static getCurrent() { return windowMock; }
  minimize = windowMock.minimize;
  toggleMaximize = windowMock.toggleMaximize;
  close = windowMock.close;
  setTitle = windowMock.setTitle;
  show = windowMock.show;
  hide = windowMock.hide;
  onCloseRequested = windowMock.onCloseRequested;
  listen = windowMock.listen;
}
