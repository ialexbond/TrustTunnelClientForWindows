#pragma once

#include <cstdlib>
#include <optional>
#include <string>

#include "vpn/internal/utils.h"

namespace ag {

struct BufferPeekResult {
    std::optional<std::string> err; // nullopt if successful, some error description otherwise
    U8View data;                    // peeked data chunk
};

class DataBuffer {
public:
    DataBuffer() = default;
    virtual ~DataBuffer() = default;

    /**
     * Initialize buffer
     * @return nullopt if successful, some error description otherwise
     */
    virtual std::optional<std::string> init() = 0;

    /**
     * Get current buffer size
     */
    virtual size_t size() const = 0;

    /**
     * Push data chunk in buffer
     * @return nullopt if successful, some error description otherwise
     */
    virtual std::optional<std::string> push(U8View data) = 0;
    virtual std::optional<std::string> push(std::vector<uint8_t> data) = 0;

    /**
     * Peek data chunk from buffer (may be less than the buffer size).
     * The next call of `peek` returns the same chunk, call to `drain` to advance the buffer.
     */
    virtual BufferPeekResult peek() = 0;

    /**
     * Remove data from buffer
     * @param length data length to remove
     */
    virtual void drain(size_t length) = 0;
};

} // namespace ag
