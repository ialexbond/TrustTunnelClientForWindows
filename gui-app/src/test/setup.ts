import "@testing-library/jest-dom";
import "./tauri-mock";
import "../shared/i18n";

// Synchronous RAF mock — makes Modal/animation double-RAF execute immediately in tests
global.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  cb(0);
  return 0;
};
global.cancelAnimationFrame = () => {};
