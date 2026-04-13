import { describe, it } from "vitest";

describe("MtProtoSection", () => {
  it.todo("renders not_installed state with port input and Install button (MTPROTO-01)");
  it.todo("renders installing state with StepProgress (MTPROTO-02)");
  it.todo("renders installed state with proxy link and Copy button (MTPROTO-05, MTPROTO-06)");
  it.todo("renders error state with error message and Retry button");
  it.todo("Copy button writes proxy_link to clipboard");
  it.todo("Uninstall button calls requestUninstall (MTPROTO-08)");
  it.todo("port input accepts values 1024-65535 (MTPROTO-03)");
});
