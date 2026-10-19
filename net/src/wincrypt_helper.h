#pragma once

#include <openssl/stack.h>
#include <openssl/x509.h>

enum WinCryptValidateError {
    WCRYPT_E_OK,
    WCRYPT_E_CERT_OPEN_STORE,
    WCRYPT_E_I2D_X509,
    WCRYPT_E_CERT_ADD_ENCODED_CERTIFICATE_TO_STORE,
    WCRYPT_E_CERT_GET_CERTIFICATE_CHAIN,
    WCRYPT_E_TRUST_STATUS,
    WCRYPT_E_CERT_VERIFY_CERTIFICATE_CHAIN_POLICY,
    WCRYPT_E_POLICY_STATUS,
    WCRYPT_E_CERT_NOT_YET_VALID,
};

// An optional private chain engine permits tests to use in-memory trust roots.
WinCryptValidateError wcrypt_validate_cert(X509 *leaf, STACK_OF(X509) * chain, void *chain_engine = nullptr);
