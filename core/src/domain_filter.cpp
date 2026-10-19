#include "vpn/internal/domain_filter.h"

#include <algorithm>
#include <cctype>

#include "common/defs.h"
#include "vpn/internal/utils.h"
#include "vpn/utils.h"

#define log_filter(f_, lvl_, fmt_, ...) lvl_##log((f_)->m_log, fmt_, ##__VA_ARGS__)

namespace ag {

static constexpr std::string_view WWW_PREFIX = "www.";
static constexpr std::string_view WILDCARD_PREFIX = "*.";

enum DomainFilter::MatchFlags : uint32_t {
    DFMM_EXACT,      // match the domain itself and www. + the domain
    DFMM_SUBDOMAINS, // match only subdomains and www. + the domain, but not the domain itself
};

DomainFilter::DomainFilter() = default;

DomainFilter::~DomainFilter() = default;

DomainFilterValidationStatus DomainFilter::validate_entry(std::string_view entry) {
    if (!entry.empty() && (entry.front() == '!' || entry.front() == '+' || entry.front() == '^')) {
        entry.remove_prefix(1);
    }
    ParseResult result = parse_entry(entry);
    static_assert(std::is_same_v<std::variant_alternative_t<DFVS_OK_ADDR, ParseResult>, SocketAddress>);
    static_assert(std::is_same_v<std::variant_alternative_t<DFVS_OK_CIDR, ParseResult>, CidrRange>);
    static_assert(std::is_same_v<std::variant_alternative_t<DFVS_OK_DOMAIN, ParseResult>, DomainEntryInfo>);
    static_assert(std::is_same_v<std::variant_alternative_t<DFVS_MALFORMED, ParseResult>, DomainEntryMalformed>);
    static_assert(std::is_same_v<std::variant_alternative_t<DFVS_OK_PORT, ParseResult>, PortOnlyEntry>);
    static_assert(std::variant_size_v<ParseResult> == 5);

    return DomainFilterValidationStatus(result.index());
}

DomainFilter::ParseResult DomainFilter::parse_entry(std::string_view entry) {
    SocketAddress addr{};
    Result split = utils::split_host_port(entry);
    if (!split.has_error()) {
        std::optional port = utils::to_integer<uint64_t>(split->second);
        if (port.has_value() && !split->second.empty()) {
            if (port > 0 && port <= USHRT_MAX) {
                if (split->first == "*") {
                    return PortOnlyEntry{static_cast<uint16_t>(port.value())};
                }
                addr = SocketAddress(split->first, port.value());
            }
        } else {
            addr = SocketAddress(split->first);
        }
        if (addr.valid()) {
            return addr;
        }
    }

    if (auto range = ag::CidrRange(entry); range.valid()) {
        return range;
    }

    std::string normalized(entry);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    entry = normalized;
    std::string_view domain = entry;
    if (domain.starts_with("*.")) {
        domain.remove_prefix(2);
    }
    if (domain.empty()) {
        return DomainEntryMalformed{};
    }
    for (char last_ch = '.'; char ch : domain) {
        if (!isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_' && ch != '.') {
            return DomainEntryMalformed{};
        }
        if (ch == '.' && last_ch == '.') {
            return DomainEntryMalformed{};
        }
        last_ch = ch;
    }

    MatchFlagsSet match_flags;

    if (starts_with(entry, WILDCARD_PREFIX)) {
        entry.remove_prefix(WILDCARD_PREFIX.length());
        match_flags.set(DFMM_SUBDOMAINS);
    } else {
        match_flags.set(DFMM_EXACT);
        if (starts_with(entry, WWW_PREFIX)) {
            entry.remove_prefix(WWW_PREFIX.length());
        }
    }

    return DomainEntryInfo{std::string(entry), match_flags};
}

bool DomainFilter::update_exclusions(VpnMode mode_, std::string_view exclusions) {
    m_mode = mode_;
    m_domains.clear();
    m_addresses.clear();
    m_ports_only.clear();
    m_exclusion_suspects.clear();
    m_cidr_ranges.clear();
    m_default_overrides.reset();
    m_explicit_exclusions.reset();
    m_explicit_defaults.reset();
    std::string overrides;
    std::string explicit_exclusions;
    std::string explicit_defaults;

    auto add_entry = [this, &overrides, &explicit_exclusions, &explicit_defaults](const std::string &entry) {
        if (entry.starts_with('!') || entry.starts_with('+') || entry.starts_with('^')) {
            if (std::holds_alternative<DomainEntryMalformed>(parse_entry(std::string_view(entry).substr(1)))) {
                log_filter(this, warn, "Malformed default-route override: {}", entry);
                return;
            }
            auto &target = entry.front() == '+' ? explicit_exclusions
                    : entry.front() == '^'      ? explicit_defaults
                                                : overrides;
            target.append(entry, 1);
            target.push_back('\n');
            return;
        }
        ParseResult result = parse_entry(entry);
        if (const auto *addr = std::get_if<SocketAddress>(&result); addr != nullptr) {
            log_filter(this, trace, "Entry added in address table: {}", entry);
            m_addresses.insert(*addr);
        } else if (auto *domain_info = std::get_if<DomainEntryInfo>(&result); domain_info != nullptr) {
            log_filter(this, trace, "Entry added in domain table: {}", domain_info->text);
            m_domains[std::move(domain_info->text)] |= domain_info->flags;
        } else if (auto *range = std::get_if<CidrRange>(&result); range != nullptr) {
            log_filter(this, trace, "Entry added in CIDR ranges table: {}", range->to_string());
            m_cidr_ranges.insert(*range);
        } else if (auto *port_only = std::get_if<PortOnlyEntry>(&result); port_only != nullptr) {
            log_filter(this, trace, "Entry added in ports only table: {}", port_only->port);
            m_ports_only.insert(port_only->port);
        } else {
            auto status = std::get<DomainEntryMalformed>(result);
            (void) status;
            log_filter(this, warn, "Malformed entry detected in exceptions list: {}", entry);
        }
    };

    std::string buffer;

    for (char ch : exclusions) {
        if (!isspace(ch)) {
            buffer.push_back(ch);
        } else if (!buffer.empty()) {
            add_entry(buffer);
            buffer.clear();
        }
    }

    if (!buffer.empty()) {
        add_entry(buffer);
    }

    if (!overrides.empty()) {
        m_default_overrides = std::make_unique<DomainFilter>();
        m_default_overrides->update_exclusions(mode_, overrides);
    }
    if (!explicit_exclusions.empty()) {
        m_explicit_exclusions = std::make_unique<DomainFilter>();
        m_explicit_exclusions->update_exclusions(mode_, explicit_exclusions);
    }
    if (!explicit_defaults.empty()) {
        m_explicit_defaults = std::make_unique<DomainFilter>();
        m_explicit_defaults->update_exclusions(mode_, explicit_defaults);
    }

    return true;
}

std::optional<size_t> DomainFilter::matched_domain_length(std::string_view domain) const {
    std::string normalized(domain);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    domain = normalized;
    bool www_prefixed = starts_with(domain, WWW_PREFIX);
    std::string seek = !www_prefixed ? std::string(domain) : std::string(domain.substr(WWW_PREFIX.length()));
    while (true) {
        auto i = m_domains.find(seek);
        if (i != m_domains.end()) {
            const auto flags = i->second;
            if ((flags.test(DFMM_EXACT)
                        && (seek.length() == domain.length()
                                || (www_prefixed && seek.length() + WWW_PREFIX.length() == domain.length())))
                    || (flags.test(DFMM_SUBDOMAINS) && seek.length() < domain.length())) {
                return seek.length();
            }
        }
        size_t next_dot = seek.find('.');
        if (next_dot == std::string::npos || next_dot + 1 == seek.length()) {
            break;
        }
        seek.erase(0, next_dot + 1);
    }
    return std::nullopt;
}

std::optional<DomainFilterMatchStatus> DomainFilter::match_explicit_domain(std::string_view domain) const {
    auto direct = m_explicit_exclusions ? m_explicit_exclusions->matched_domain_length(domain) : std::nullopt;
    auto defaults = m_explicit_defaults ? m_explicit_defaults->matched_domain_length(domain) : std::nullopt;
    if (!direct && !defaults) {
        return std::nullopt;
    }
    // User entries beat group entries; among overlapping user domains, the more specific wins.
    return defaults && (!direct || *defaults >= *direct) ? DFMS_DEFAULT_OVERRIDE : DFMS_EXCLUSION;
}

DomainFilterMatchStatus DomainFilter::match_domain(std::string_view domain) const {
    if (auto explicit_match = match_explicit_domain(domain)) {
        log_filter(this, dbg, "Explicit user rule matched domain: {}", domain);
        return *explicit_match;
    }
    if (m_default_overrides && m_default_overrides->match_domain(domain) == DFMS_EXCLUSION) {
        log_filter(this, dbg, "Default-route group override matched domain: {}", domain);
        return DFMS_DEFAULT_OVERRIDE;
    }
    if (matched_domain_length(domain)) {
        log_filter(this, dbg, "Matched excluded domain: {}", domain);
        return DFMS_EXCLUSION;
    }
    return DFMS_DEFAULT;
}

DomainFilterMatchResult DomainFilter::match_tag(const SockAddrTag &tag) const {
    DomainFilterMatchResult result{.status = DFMS_DEFAULT};

    std::optional<std::string> domain;
    if (auto cached = m_resolved_tags.get(tag)) {
        domain = *cached;
    }
    if (domain) {
        if (auto explicit_match = match_explicit_domain(*domain)) {
            return {.status = *explicit_match, .domain = domain};
        }
    }
    if (m_explicit_defaults && m_explicit_defaults->match_tag(tag).status == DFMS_EXCLUSION) {
        return {.status = DFMS_DEFAULT_OVERRIDE, .domain = domain};
    }
    bool explicit_address = m_explicit_exclusions && m_explicit_exclusions->match_tag(tag).status == DFMS_EXCLUSION;
    if (!explicit_address && m_default_overrides
            && ((domain && m_default_overrides->match_domain(*domain) == DFMS_EXCLUSION)
                    || m_default_overrides->match_tag(tag).status == DFMS_EXCLUSION)) {
        return {.status = DFMS_DEFAULT_OVERRIDE, .domain = domain};
    }

    SocketAddress addr_no_port = tag.addr;
    addr_no_port.set_port(0);

    bool found = explicit_address || m_addresses.contains(tag.addr);
    if (!found) {
        found = m_addresses.contains(addr_no_port);
    }

    if (!found) {
        const Uint8View addr = tag.addr.addr();
        ag::CidrRange addr_cidr(addr, addr.size() * 8);
        found = m_cidr_ranges.includes(addr_cidr);
    }

    if (!found) {
        found = m_ports_only.contains(tag.addr.port());
    }

    if (found) {
        log_filter(this, trace, "Address matched against exclusion list: {}", tag.addr);
        // With an unknown name, a broad IP exclusion must not preempt an explicit VPN domain.
        // The tunnel can inspect TLS/QUIC on scannable ports. An unidentifiable target is
        // conservatively tunnelled instead of assuming that a broad DIRECT rule is safe.
        bool has_domain_override = (!explicit_address && m_default_overrides && !m_default_overrides->m_domains.empty())
                || (m_explicit_defaults && !m_explicit_defaults->m_domains.empty());
        result.status = !domain && has_domain_override ? DFMS_SUSPECT_EXCLUSION : DFMS_EXCLUSION;
        result.domain = domain;
    } else if (domain) {
        log_filter(this, dbg, "Cache hit: {}#{} -> {}", tag.addr, tag.appname, *domain);
        result.status = match_domain(*domain);
        result.domain = *domain;
    } else if (m_exclusion_suspects.get(addr_no_port)) {
        result.status = DFMS_SUSPECT_EXCLUSION;
    }

    return result;
}

void DomainFilter::add_resolved_tag(SockAddrTag tag, std::string domain) {
    log_filter(this, dbg, "{}#{} -> {}", tag.addr, tag.appname, domain);

    m_resolved_tags.insert(std::move(tag), std::move(domain));
}

void DomainFilter::add_exclusion_suspect(const SocketAddress &addr_, std::chrono::seconds ttl) {
    SocketAddress addr = addr_;
    addr.set_port(0);
    log_filter(this, dbg, "{} / {}", addr.host_str(/*ipv6_brackets=*/true), ttl);

    m_exclusion_suspects.insert(addr, 0, ttl, /*preserve_longer_timeout=*/true);
}

std::vector<std::string_view> DomainFilter::get_resolvable_exclusions() const {
    std::vector<std::string_view> names;
    if (m_default_overrides) {
        names = m_default_overrides->get_resolvable_exclusions();
    }
    for (const auto *explicit_filter : {m_explicit_exclusions.get(), m_explicit_defaults.get()}) {
        if (explicit_filter) {
            auto extra = explicit_filter->get_resolvable_exclusions();
            names.insert(names.begin(), extra.begin(), extra.end());
        }
    }
    for (const auto &[name, flags] : m_domains) {
        if (flags.test(DFMM_EXACT)) {
            names.emplace_back(name);
        }
    }

    return names;
}

VpnMode DomainFilter::get_mode() const {
    return m_mode;
}

} // namespace ag
