#pragma once

#include "vpn/utils.h"

#include <array>
#include <optional>
#include <vector>

#include "net/tls13_utils.h"

namespace ag::quic_utils {

/// maximum length of a connection ID
static constexpr size_t QUIC_MAX_CONN_ID_LEN = 20;
/// maximum token length, don't process too large token
static constexpr size_t QUIC_MAX_TOKEN_LEN = 128;
/// default port for QUIC traffic
static constexpr size_t DEFAULT_QUIC_PORT = 443;
/**
 * @struct
 * represents QUIC packet header.
 */
struct QuicPacketHeader {
    uint32_t version{};                               /**< QUIC version */
    uint8_t type{};                                   /** Type of packet */
    std::array<uint8_t, QUIC_MAX_CONN_ID_LEN> scid{}; /**< Source Connection ID */
    size_t scid_len = sizeof(scid);                   /**< Source Connection ID length */
    std::array<uint8_t, QUIC_MAX_CONN_ID_LEN> dcid{}; /**< Destination Connection ID */
    size_t dcid_len = sizeof(dcid);                   /**< Destination Connection ID length */
    std::array<uint8_t, QUIC_MAX_TOKEN_LEN> token{};  /**< Token */
    size_t token_len = sizeof(token);                 /**< Token bytes available for reading */
};

/**
 * @enum
 * represents QUIC packet header type
 * @note
 * order is different from RFC 9001 enumeration [Table 1]
 * to match type returned by quiche function (quiche_header_info)
 */
enum QuicPacketType {
    INITIAL = 1,
    RETRY,
    HANDSHAKE,
    ZERO_RTT,
    SHORT,
    VERSION_NEGOTIATION,
};

/**
 * Decrypt an initial packet. Initial packed is left unchanged.
 * Accepts already decoded header.
 * @param [in] initial_packet initial packet
 * @param [in] hd decoded header
 * @return the decrypted packet or std::nullopt if decryption failed
 */
[[nodiscard]] std::optional<std::vector<uint8_t>> decrypt_initial(U8View initial_packet, const QuicPacketHeader &hd);

/**
 * Find all CRYPTO frames in an initial QUIC packet payload and assemble them in order.
 * If the payload is malformed or doesn't contain CRYPTO frames, return std::nullopt.
 * @param payload decrypted payload of a QUIC packet.
 * @return content of all crypto frames in order, or std::nullopt on error.
 */
[[nodiscard]] std::optional<std::vector<uint8_t>> reassemble_initial_crypto_frames(U8View payload);

/**
 * Check if given packet is QUIC and extract QUIC packet header
 * @param initial_packet initial packet payload
 * @return QuicPacketHeader on success, or std::nullopt if packet doesn't have QUIC header
 */
[[nodiscard]] std::optional<QuicPacketHeader> parse_quic_header(U8View initial_packet);

/**
 * Convert QUIC data to TLS format
 * @param initial_packet initial packet payload
 * @param hd QUIC packet header
 * @return Converted data with SNI in it, std::nullopt if packet wasn't converted
 */
[[nodiscard]] std::optional<std::vector<uint8_t>> prepare_for_domain_lookup(
        U8View initial_packet, const QuicPacketHeader &hd);

} // namespace ag::quic_utils
