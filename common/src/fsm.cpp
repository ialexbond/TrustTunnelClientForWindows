#include <assert.h>
#include <atomic>
#include <stdlib.h>

#include "common/logger.h"
#include "vpn/fsm.h"

namespace ag {

static ag::Logger g_logger{"FSM"};

#define log_fsm(lvl_, fmt_, ...) lvl_##log(g_logger, "[{}/{}] " fmt_, m_id, m_params.fsm_name, ##__VA_ARGS__)

static std::atomic_int g_next_id = 0;

bool validate_fsm_transition_table(FsmTransitionTable table);

static const char *state_name(const FsmParameters &params, FsmState state) {
    return params.state_names[state];
}

static const char *event_name(const FsmParameters &params, FsmEvent event) {
    return params.event_names[event];
}

Fsm::Fsm(FsmParameters params) // NOLINT(performance-unnecessary-value-param)
        : m_params{std::move(params)}
        , m_current_state{m_params.initial_state}
        , m_recursive{false}
        , m_id{g_next_id.fetch_add(1)} {
    if (!validate_transition_table(m_params.table)) {
        abort();
    }
}

Fsm::~Fsm() = default;

void Fsm::perform_transition(FsmEvent event, void *data) {
    log_fsm(trace, "Before transition: state={} event={}", state_name(m_params, m_current_state),
            event_name(m_params, event));

    if (m_recursive) {
        log_fsm(err, "Recursive fsm run is prohibited: state={} event={}", state_name(m_params, m_current_state),
                event_name(m_params, event));
        assert(0);
        return;
    }

    m_recursive = true;

    for (auto &entry : m_params.table) {
        if (m_current_state != entry.src_state && entry.src_state != Fsm::ANY_SOURCE_STATE) {
            continue;
        }

        if (event != entry.event) {
            continue;
        }

        if (entry.condition != Fsm::ANYWAY && entry.condition != Fsm::OTHERWISE
                && !entry.condition(m_params.ctx, data)) {
            continue;
        }

        if (entry.before_transition != Fsm::DO_NOTHING) {
            entry.before_transition(m_params.ctx, data);
        }

        if (entry.target_state != Fsm::SAME_TARGET_STATE) {
            m_current_state = entry.target_state;
        }
        m_recursive = false;
        log_fsm(trace, "After transition: state={}", state_name(m_params, m_current_state));

        if (entry.after_transition != Fsm::DO_NOTHING) {
            entry.after_transition(m_params.ctx, data);
        }
        break;
    }

    m_recursive = false;
}

FsmState Fsm::get_state() const {
    return m_current_state;
}

void Fsm::reset() {
    m_current_state = m_params.initial_state;
    m_recursive = false;
}

} // namespace ag
