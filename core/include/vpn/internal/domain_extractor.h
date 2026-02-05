#pragma once

#include <memory>
#include <string>

#include "common/logger.h"
#include "vpn/utils.h"

namespace ag {

enum DomainExtractorStatus {
    DES_NOTFOUND,  // gave up looking for a domain name
    DES_FOUND,     // found a domain name
    DES_PASS,      // pass current packet, check the next one (client hello -> server hello)
    DES_WANT_MORE, // need more data to parse (client hello pt.1 -> client hello pt.2)
};

struct DomainExtractorResult {
    DomainExtractorStatus status = DES_NOTFOUND;
    std::string domain;
};

enum DomainExtractorPacketDirection {
    DEPD_OUTGOING, // from client to server
    DEPD_INCOMING, // from server to client
};

class DomainExtractor {
public:
    DomainExtractor();
    ~DomainExtractor();

    DomainExtractor(const DomainExtractor &) = delete;
    DomainExtractor &operator=(const DomainExtractor &) = delete;

    DomainExtractor(DomainExtractor &&) noexcept = delete;
    DomainExtractor &operator=(DomainExtractor &&) noexcept = delete;

    DomainExtractorResult proceed(DomainExtractorPacketDirection dir, int proto, const uint8_t *data, size_t length);

    void reset();

private:
    struct Context;
    std::unique_ptr<Context> m_context;
};

} // namespace ag
