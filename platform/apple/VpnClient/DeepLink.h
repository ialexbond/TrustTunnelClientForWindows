#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Provides deep-link decoding for TrustTunnel endpoint configurations.
 */
@interface TrustTunnelDeepLink : NSObject

/**
 * Decode a `tt://` deep-link URI into a `[endpoint]` TOML section string.
 *
 * @param uri   The `tt://...` deep-link URI to decode.
 * @param error On failure, populated with a descriptive error.
 * @return A TOML string beginning with `[endpoint]` ready to be embedded in
 *         the full client configuration, or nil on error.
 */
+ (nullable NSString *)decodeDeeplink:(NSString *)uri error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
