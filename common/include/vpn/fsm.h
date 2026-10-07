#pragma once

#include <cstdint>
#include <vector>

#include "vpn/platform.h"

namespace ag {

using FsmState = uint32_t;
using FsmEvent = int;
using FsmCondition = bool (*)(const void *, void *);
using FsmAction = void (*)(void *, void *);

struct FsmTransitionEntry {
    FsmState src_state;          // transition source state
    FsmEvent event;              // event identifier
    FsmCondition condition;      // if returns true, an entry is considered matched
    FsmAction before_transition; // action to do before entering the target state
    FsmState target_state;       // transition target state
    FsmAction after_transition;  // action to do after entering the target state
};

using FsmTransitionTable = std::vector<FsmTransitionEntry>;

struct FsmParameters {
    FsmState initial_state;         // initial FSM state
    FsmTransitionTable table;       // transition table
    void *ctx;                      // user context
    const char *fsm_name;           // FSM name for logging
    const char *const *state_names; // state names table for logging
    const char *const *event_names; // event names table for logging
};

class Fsm {
private:
    FsmParameters m_params;
    FsmState m_current_state;
    bool m_recursive;
    int m_id;

public:
    /// Match such an entry if previous conditions failed (useful as default condition)
    static constexpr auto OTHERWISE = nullptr;
    /// Always match such an entry (useful as a single always matching condition)
    static constexpr auto ANYWAY = nullptr;
    /// Entry has no action to execute
    static constexpr auto DO_NOTHING = nullptr;
    /// Match such an entry in any state
    static constexpr auto ANY_SOURCE_STATE = UINT32_MAX;
    /// Leave such an entry in the same state
    static constexpr auto SAME_TARGET_STATE = UINT32_MAX - 1;

    /**
     * Create an FSM instance
     * @param params FSM parameters
     */
    explicit Fsm(FsmParameters params);

    Fsm(const Fsm &) = delete;
    Fsm &operator=(const Fsm &) = delete;

    Fsm(Fsm &&) noexcept = delete;
    Fsm &operator=(Fsm &&) noexcept = delete;

    ~Fsm();

    /**
     * Perform FSM transition on event
     * @param event event to process
     * @param data event data
     */
    void perform_transition(FsmEvent event, void *data);

    /**
     * Get current FSM state
     */
    [[nodiscard]] FsmState get_state() const;

    /**
     * Reset FSM to initial state
     */
    void reset();

    static bool validate_transition_table(const FsmTransitionTable &table);
};

} // namespace ag
