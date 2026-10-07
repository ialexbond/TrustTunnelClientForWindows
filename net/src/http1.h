#pragma once

#include <stddef.h>
#include <stdint.h>

#include "net/http_session.h"

namespace ag {

Http1Session *http1_session_init(HttpSession *context);
int http1_session_input(HttpSession *context, const uint8_t *data, size_t length);
int http1_session_close(HttpSession *h12_context);
int http1_session_send_headers(HttpSession *h12_session, int32_t stream_id, const HttpHeaders *headers);
int http1_session_send_data(HttpSession *h12_session, int32_t stream_id, const uint8_t *data, size_t len, bool eof);

} // namespace ag
