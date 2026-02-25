package com.adguard.trusttunnel

object DeepLink {
    /**
     * Decode a `tt://` deep-link URI into a `[endpoint]` TOML section string.
     *
     * @param uri The `tt://...` deep-link URI to decode.
     * @return A TOML string beginning with `[endpoint]` that can be embedded
     *         in the full client configuration.
     * @throws RuntimeException if the URI is invalid or missing required fields.
     */
    @JvmStatic
    external fun decode(uri: String): String
}
