import "@testing-library/jest-dom";
import "./tauri-mock";
import "../shared/i18n";

declare const global: typeof globalThis;

// Synchronous RAF mock — makes Modal/animation double-RAF execute immediately in tests
global.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  cb(0);
  return 0;
};
global.cancelAnimationFrame = () => {};

// jsdom не реализует matchMedia — useTheme использует его для
// `prefers-color-scheme` detection когда theme mode = "system". Минимальный
// stub: всегда light, без listener'ов.
if (!window.matchMedia) {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
