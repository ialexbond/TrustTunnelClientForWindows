// The one place that turns a `ReconnectProgress` into the sentence a person reads.
//
// WHY THIS FILE EXISTS. The choice used to be inlined at each render site. When the failover walk
// started carrying a different meaning in the same two integers, `StatusPanel` was taught the new
// sentence and `ConfigCard` was not — so the status line said «Пробуем сервер 2 из 4» while the card
// two rows below still said «Попытка 1 из 1» about the same event. The owner saw the card. A pure
// function both surfaces call cannot drift like that, and it can be unit-tested without rendering
// anything.
//
// WHAT THE BACKEND SENDS, AND WHY IT NEEDS INTERPRETING. `attempt`/`max` mean two different things
// depending on `failover`:
//   - failover false — retries of ONE server. «Попытка 3 из 10» is exactly what a person wants:
//     the server is known (it is the one on screen), the open question is how much patience is left.
//   - failover true — a position in the QUEUE of servers. Every candidate gets a single attempt, so
//     read as retries this said «Попытка 1 из 1» on server after server: a counter that never moves,
//     about a process the user cannot see. Two owner complaints came out of that (28-UAT tests 1 and
//     3): the counter is meaningless, AND «не видно, к какому серверу он пытается подключиться».
//
// So on a walk the SERVER is the headline and the position is the supporting detail — and the
// position is dropped entirely when there is only one candidate, because «1 из 1» is noise, which is
// the complaint in its purest form.
import type { ReconnectProgress } from "../types";

/** A translation key plus the variables it needs. The caller does the `t()` — this module stays
 *  free of the i18n instance so it is trivially testable. */
export interface ReconnectLabel {
  key: string;
  vars: Record<string, string | number>;
}

/**
 * Pick the sentence for one reconnect-progress snapshot.
 *
 * Four outcomes, in the order they are decided:
 *   1. plain reconnect            → `status.reconnect_attempt`   «Попытка 3 из 10»
 *   2. walk, name known, many     → `status.failover_to_of`      «Переключение на «X» — 2 из 4»
 *   3. walk, name known, single   → `status.failover_to`         «Переключение на «X»»
 *   4. walk, name unknown         → `status.failover_candidate` / `status.failover_next`
 *
 * Case 4 is the honest fallback: the config could not be read or carries no name, so the sentence
 * says what is happening without inventing a server. It keeps the position when there is one worth
 * showing, and drops to a bare «Переключение на другой сервер» when there is not.
 */
export function reconnectLabel(progress: ReconnectProgress): ReconnectLabel {
  const { attempt, max, failover, server } = progress;

  if (!failover) {
    return { key: "status.reconnect_attempt", vars: { attempt, max } };
  }

  // «N из 1» tells the user nothing they cannot already see, so the position is shown only when the
  // walk actually has somewhere else to go.
  const positionWorthShowing = max > 1;
  const name = server?.trim();

  if (name) {
    return positionWorthShowing
      ? { key: "status.failover_to_of", vars: { server: name, attempt, max } }
      : { key: "status.failover_to", vars: { server: name } };
  }

  return positionWorthShowing
    ? { key: "status.failover_candidate", vars: { attempt, max } }
    : { key: "status.failover_next", vars: {} };
}
