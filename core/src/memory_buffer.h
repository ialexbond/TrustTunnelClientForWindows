#pragma once

#include <queue>
#include <vector>

#include "vpn/internal/data_buffer.h"

namespace ag {

class MemoryBuffer : public DataBuffer {
public:
    MemoryBuffer();
    ~MemoryBuffer() override;

private:
    size_t m_total_size = 0;
    std::queue<std::vector<uint8_t>> m_chunks;

    std::optional<std::string> init() override;
    [[nodiscard]] size_t size() const override;
    std::optional<std::string> push(U8View data) override;
    std::optional<std::string> push(std::vector<uint8_t> data) override;
    BufferPeekResult peek() override;
    void drain(size_t length) override;
};

} // namespace ag
