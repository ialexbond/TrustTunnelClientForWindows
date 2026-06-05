/**
 * Shared test fixtures barrel (Phase 3 safety-net, Wave 0).
 *
 * One import path for every Wave-1 stream test:
 *
 *   import { makeState, makeBundle } from "../../test/fixtures";
 *
 * Keeps the seven parallel per-surface plans off the same shared source files
 * (RESEARCH §4.1 / §6.2 worktree-isolation merge-conflict avoidance).
 */
export { makeState } from "./server-state";
export { makeBundle } from "./config";
export {
  makeCertRaw,
  makeCertState,
  mockSecurityFactory,
  type CertRawFixture,
} from "./security";
export { captureListeners, emitEvent, type CapturedListeners } from "./events";
export {
  activityLogSpy,
  expectNoSecretLogged,
  installActivityLogSpy,
  type ActivityLogSpyHandle,
} from "./activity-log-spy";
