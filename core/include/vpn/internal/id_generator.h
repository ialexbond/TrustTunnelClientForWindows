#pragma once

#include <cstdint>

namespace ag {

class IdGenerator {
public:
    explicit IdGenerator(size_t step = 1)
            : m_step(step) {
    }

    size_t get() {
        size_t id = m_next_id;
        m_next_id += m_step;
        return id;
    }

    void reset() {
        m_next_id = 1;
    }

private:
    size_t m_step;
    size_t m_next_id = 1;
};

} // namespace ag
