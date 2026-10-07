#pragma once

#include <stdint.h>

#include <zlib.h>

#include "common/logger.h"
#include "net/http_header.h"
#include "net/http_session.h"

namespace ag {

/**
 * Content-Encoding enum type.
 * Encoding supported by this library - `identity', `deflate' and `gzip'
 */
typedef enum {
    CONTENT_ENCODING_IDENTITY = 0,
    CONTENT_ENCODING_DEFLATE = 1,
    CONTENT_ENCODING_GZIP = 2,
    CONTENT_ENCODING_BROTLI = 3
} HttpContentEncoding;

typedef enum {
    // Need decode flag. true if decode is needed
    STREAM_NEED_DECODE = 0x01,
    STREAM_DONT_EXPECT_RESPONSE_BODY = 0x02,
    STREAM_REQ_SENT = 0x04,
    STREAM_BODY_DATA_STARTED = 0x08,
} HttpStreamFlags;

typedef struct BrotliStream BrotliStream;

typedef struct {
    int id;                               // Stream id
    HttpSession *session;                 // Parent HTTP session
    size_t client_window_size;            // client-side window size
    HttpStreamFlags flags;                // Flags for pending actions for the stream
    HttpHeaders headers;                  // Incoming HTTP message
    HttpContentEncoding content_encoding; // Content-Encoding of body - identity (no encoding), deflate, gzip.
                                          // Determined from headers.
    uint8_t *decode_in_buffer;  // Decompressor input buffer. Contains tail on previous input buffer which can't be
                                // processed right now
    uint8_t *decode_out_buffer; // Decompressor output buffer. Contains currently decompressed data
    // Decompressor stream
    union {
        struct z_stream_s *zlib_stream;
        BrotliStream *brotli_stream;
        void *decompress_stream;
    };
    char error_msg[256];      // Decompressor error
    void *data_source;        // HTTP/2 data source
    uint32_t processed_bytes; // Number of input bytes processed
} HttpStream;

/**
 * Create new HTTP stream
 * @param id Stream id
 * @return HTTP stream
 */
HttpStream *http_stream_new(HttpSession *session, int32_t id);

/**
 * Destroy HTTP stream
 * @param stream HTTP stream
 */
void http_stream_destroy(HttpStream *stream);

/*
 * Functions for body decompression.
 * Since decompression of one chunk of data may result on more than one output chunk, passing callback is needed.
 */

/**
 * Body data callback. Usually it is http_session_callbacks.http_request_body_data()
 */
typedef int (*BodyDataOutputCallback)(HttpStream *stream, const uint8_t *data, size_t length);

/**
 * Initializes decompress stream for current HTTP stream.
 * @param stream HTTP stream
 * @return 0 if success
 */
int http_stream_decompress_init(HttpStream *stream);

/**
 * Get Content-Encoding of stream from HTTP headers
 * @param headers HTTP headers
 * @return HTTP content encoding
 */
HttpContentEncoding http_stream_get_content_encoding(const HttpHeaders *headers);

/*
 * Inflate current input buffer and call body_data_output_impl for each decompressed chunk
 */

/**
 * Decompress current input buffer and call data callback for each decompressed chunk
 * @param stream HTTP stream
 * @param data Input data buffer
 * @param length Input data length
 * @param data_output Data output function
 * @return 0 if success
 */
int http_stream_decompress(HttpStream *stream, const uint8_t *data, size_t length, BodyDataOutputCallback data_output);

/**
 * Deinitializes decompress stream for current HTTP stream
 * @param stream HTTP stream
 * @return 0 if success
 */
int http_stream_decompress_end(HttpStream *stream);

/**
 * Reset stream state
 * @param stream HTTP stream
 */
void http_stream_reset_state(HttpStream *stream);

} // namespace ag
