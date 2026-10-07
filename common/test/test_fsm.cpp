#include <gtest/gtest.h>

#include "vpn/fsm.h"

#ifndef NDEBUG

using namespace ag;

static bool dummy_condition(const void *, void *) {
    return true;
}

static void dummy_action(void *, void *) {
}

TEST(FSMValidation, TargetStateAnyState) {
    FsmTransitionTable transition_table = {
            {0, 0, dummy_condition, dummy_action, Fsm::ANY_SOURCE_STATE},
    };

    ASSERT_FALSE(Fsm::validate_transition_table(transition_table));
}

TEST(FSMValidation, Closed) {
    FsmTransitionTable transition_table = {
            {0, 0, Fsm::ANYWAY, dummy_action, 0},
            {0, 0, dummy_condition, dummy_action, 0},
    };

    ASSERT_FALSE(Fsm::validate_transition_table(transition_table));
}

#endif // NDEBUG
