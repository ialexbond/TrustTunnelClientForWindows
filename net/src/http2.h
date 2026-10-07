#pragma once

#include "vpn/platform.h" // Unbreak Windows builddows

#include <khash.h>
#include <nghttp2/nghttp2.h>

#include "http_stream.h"
#include "net/http_session.h"

namespace ag {

Http2Session *http2_session_init(HttpSession *context);
int http2_session_input(HttpSession *context, const uint8_t *data, size_t length);
int http2_session_close(HttpSession *context);
int http2_session_send_headers(HttpSession *session, int32_t stream_id, const HttpHeaders *headers, bool eof);
int http2_session_send_data(HttpSession *session, int32_t stream_id, const uint8_t *data, size_t len, bool eof);

KHASH_MAP_INIT_INT(h2_streams_ht, HttpStream *);

struct Http2Session {
    nghttp2_session *ngsession;
    khash_t(h2_streams_ht) * streams;
};

} // namespace ag
