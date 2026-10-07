#pragma once

#include <cstddef>
#include <cstdint>

#include "common/logger.h"
#include "net/http_header.h"
#include "net/utils.h"

namespace ag {

typedef struct Http1Session Http1Session;
typedef struct Http2Session Http2Session;

typedef enum {
    HTTP_ERROR_AUTH_REQUIRED = 0x64,
} HttpCustomError;

typedef enum {
    HTTP_EVENT_HEADERS,          /**< Raised after HTTP headers received (raised with `http_headers_event_t`) */
    HTTP_EVENT_DATA,             /**< Raised after some HTTP body chunk received (raised with `http_data_event_t`) */
    HTTP_EVENT_DATA_FINISHED,    /**< Raised after HTTP data frame with set end stream flag received (raised with stream
                                    id) */
    HTTP_EVENT_STREAM_PROCESSED, /**< Raised after a peer has closed HTTP stream (raised with
                                    `http_stream_processed_event_t`) */
    HTTP_EVENT_DATA_SENT,        /**< Raised after some data has been sent (raised with `http_data_sent_event_t`) */
    HTTP_EVENT_GOAWAY,           /** Raised after HTTP session has been closed (raised with `http_goaway_event_t`) */
    HTTP_EVENT_OUTPUT, /** Raised when HTTP protocol has some data to send (raised with `http_output_event_t`) */
} HttpEventId;

typedef struct {
    HttpHeaders *headers;
    int stream_id;
} HttpHeadersEvent;

typedef struct {
    int stream_id;
    const uint8_t *data;
    size_t length;
    int result;
} HttpDataEvent;

typedef struct {
    int stream_id;
    int error_code;
} HttpStreamProcessedEvent;

typedef struct {
    int stream_id;
    size_t length; // if 0, then stream polls for send resuming
} HttpDataSentEvent;

typedef struct {
    int last_stream_id;
    int error_code;
} HttpGoawayEvent;

typedef struct {
    const uint8_t *data;
    size_t length;
} HttpOutputEvent;

typedef struct {
    void (*handler)(void *arg, HttpEventId id, void *data);
    void *arg;
} HttpSessionHandler;

typedef struct {
    uint64_t id;                // session id for logging
    HttpSessionHandler handler; // session events handler
    size_t stream_window_size;  // initial stream local window size
    HttpVersion version;        // protocol version
} HttpSessionParams;

typedef struct {
    union {
        Http1Session *h1;
        Http2Session *h2;
    };
    HttpSessionParams params;
} HttpSession;

/**
 * Parser error type
 */
typedef enum {
    HTTP_SESSION_OK = 0,
    HTTP_SESSION_UPGRADE = -1,
    HTTP_SESSION_PARSE_ERROR = -2,
    HTTP_SESSION_DECOMPRESS_ERROR = -3,
    HTTP_SESSION_INVALID_ARGUMENT_ERROR = -4,
    HTTP_SESSION_INVALID_STATE_ERROR = -5,
} HttpError;

/**
 * Open new HTTP session
 * @param id Id for logging
 * @param callbacks Callbacks
 * @return 0 if success
 */
HttpSession *http_session_open(const HttpSessionParams *params);

/**
 * Process input data of HTTP protocol
 * @param session HTTP session
 * @param data Pointer to input data
 * @param length Input data length
 * @return number of processed bytes if successful, < 0 if failed
 */
int http_session_input(HttpSession *session, const uint8_t *data, size_t length);

/**
 * Close HTTP session
 * @param session HTTP session
 * @return 0 if success
 */
int http_session_close(HttpSession *session);

/**
 * Send HTTP headers
 * @param session HTTP session
 * @param stream_id Stream ID
 * @param headers HTTP headers
 * @param eof EOF flag. If true, END_STREAM flag is set
 * @return 0 if success
 */
int http_session_send_headers(HttpSession *session, int32_t stream_id, const HttpHeaders *headers, bool eof);

/**
 * Send HTTP Data
 * @param session HTTP session
 * @param stream_id Stream ID
 * @param data Pointer to plain data to send
 * @param len Length of data
 * @param eof EOF flag. If true, END_STREAM flag is set
 * @return 0 if success
 */
int http_session_send_data(HttpSession *session, int32_t stream_id, const uint8_t *data, size_t len, bool eof);

/**
 * Send HTTP/2 settings
 * @param session HTTP session
 * @return 0 if success
 */
int http_session_send_settings(HttpSession *session);

/**
 * Reset stream
 * @param session HTTP session
 * @param stream_id Stream ID
 * @param error_code HTTP/2 error code
 * @return 0 if success
 */
int http_session_reset_stream(HttpSession *session, int32_t stream_id, int error_code);

/**
 * Shutdown HTTP session with the following error code
 * @param session HTTP session
 * @param last_stream_id Last processed stream ID or -1 for auto-detect
 * @param error_code HTTP/2 error code
 * @return 0 if success
 */
int http_session_send_goaway(HttpSession *session, int last_stream_id, int error_code);

/**
 * Notify HTTP2 module that input data was consumed by application.
 * @param session HTTP session
 * @param stream_id Stream ID
 * @param length Data length
 * @return 0 if success
 */
int http_session_data_consume(HttpSession *session, int32_t stream_id, size_t length);

/**
 * Set HTTP2 receive window size
 * @param session HTTP session
 * @param stream_id Stream ID
 * @param size Window size
 * @return 0 if success
 */
int http_session_set_recv_window(HttpSession *session, int32_t stream_id, size_t size);

/**
 * Get number of bytes available to send through stream/session
 * @param session HTTP session
 * @param stream_id Stream ID (if 0 return value is session-wide)
 */
size_t http_session_available_to_write(HttpSession *session, int32_t stream_id);

/**
 * Get number of bytes stream/session can receive
 *
 * @param session HTTP session
 * @param stream_id Stream ID (if 0 return value is session-wide)
 */
size_t http_session_available_to_read(HttpSession *session, int32_t stream_id);

} // namespace ag
