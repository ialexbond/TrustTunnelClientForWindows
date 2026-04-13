import { describe, it } from "vitest";

describe("useMtProtoState", () => {
  it.todo("loads status on mount via mtproto_get_status invoke (MTPROTO-05)");
  it.todo("install invokes mtproto_install with mtprotoPort param (MTPROTO-01)");
  it.todo("listens for mtproto-install-step events during install (MTPROTO-02)");
  it.todo("uninstall invokes mtproto_uninstall (MTPROTO-08)");
  it.todo("requestUninstall sets confirm dialog state");
  it.todo("retry resets error and calls install (MTPROTO-01)");
  it.todo("persists proxy_link and port to localStorage (MTPROTO-06)");
  it.todo("rehydrates proxy_link and port from localStorage on mount (MTPROTO-06)");
});
