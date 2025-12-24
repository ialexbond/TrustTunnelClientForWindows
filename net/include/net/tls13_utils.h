#pragma once

#include "common/defs.h"
#include <span>

namespace ag::tls13_utils {

/**
 * This is standard HKDF-Extract() implementation
 * It derives 256-bit key from salt and secret, to be used as secret in HKDF-Expand-Label().
 */
bool hkdf_extract(std::span<uint8_t> dest, std::span<const uint8_t> secret, std::span<const uint8_t> salt);

/**
 * HKDF-Expand-Label is wrapper around HKDF-Expand(secret, info) which builds info from several input parameters
 */
bool hkdf_expand_label(std::span<uint8_t> dest, std::span<const uint8_t> secret, std::string_view label,
        std::span<const uint8_t> context = {});

} // namespace ag::tls13_utils
