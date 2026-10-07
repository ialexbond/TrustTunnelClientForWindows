#include "net/http_header.h"

#include "common/utils.h"
#include "vpn/utils.h"

namespace ag {

bool HttpHeaders::contains_field(std::string_view name) const {
    return fields.end() != std::find_if(fields.begin(), fields.end(), [name](const HttpHeaderField &field) {
        return case_equals(field.name, name);
    });
}

std::optional<std::string_view> HttpHeaders::get_field(std::string_view name) const {
    if (auto it = std::find_if(fields.begin(), fields.end(),
                [name](const HttpHeaderField &field) {
                    return case_equals(field.name, name);
                });
            it != fields.end()) {
        return it->value;
    }
    return std::nullopt;
}

void HttpHeaders::put_field(std::string name, std::string value) {
    if (!name.empty() && name.front() == ':') {
        if (case_equals(name, METHOD_PH_FIELD)) {
            this->method = std::move(value);
            return;
        }
        if (case_equals(name, SCHEME_PH_FIELD)) {
            this->scheme = std::move(value);
            return;
        }
        if (case_equals(name, AUTHORITY_PH_FIELD)) {
            this->authority = std::move(value);
            return;
        }
        if (case_equals(name, PATH_PH_FIELD)) {
            this->path = std::move(value);
            return;
        }
        if (case_equals(name, STATUS_PH_FIELD)) {
            this->status_code = ag::utils::to_integer<int>(value).value_or(0);
            return;
        }
    }
    this->fields.emplace_back(std::move(name), std::move(value));
}

void HttpHeaders::remove_field(std::string_view name) {
    fields.erase(std::remove_if(fields.begin(), fields.end(),
                         [name](const HttpHeaderField &f) {
                             return case_equals(f.name, name);
                         }),
            fields.end());
}

HttpHeaderField::HttpHeaderField() = default;

HttpHeaderField::HttpHeaderField(std::string name, std::string value)
        : name(std::move(name))
        , value(std::move(value)) {
}

} // namespace ag
