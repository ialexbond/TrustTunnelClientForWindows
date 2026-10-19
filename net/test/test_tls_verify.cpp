#include <gtest/gtest.h>
#include <openssl/evp.h>
#include <openssl/x509v3.h>

#include <ctime>
#include <memory>
#include <vector>

#include "net/tls.h"

#ifdef _WIN32
#include "wincrypt_helper.h"
#include <wincrypt.h>
#undef X509_NAME
#endif

namespace {

using Key = ag::DeclPtr<EVP_PKEY, &EVP_PKEY_free>;
using Cert = ag::DeclPtr<X509, &X509_free>;
using Store = ag::DeclPtr<X509_STORE, &X509_STORE_free>;

Key make_key() {
    ag::DeclPtr<EVP_PKEY_CTX, &EVP_PKEY_CTX_free> ctx{EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr)};
    EVP_PKEY *key = nullptr;
    if (!ctx || EVP_PKEY_keygen_init(ctx.get()) != 1 || EVP_PKEY_CTX_set_rsa_keygen_bits(ctx.get(), 2048) != 1
            || EVP_PKEY_keygen(ctx.get(), &key) != 1) {
        return {};
    }
    return Key{key};
}

bool add_extension(X509 *cert, int nid, const char *value) {
    ag::DeclPtr<X509_EXTENSION, &X509_EXTENSION_free> extension{
            X509V3_EXT_nconf_nid(nullptr, nullptr, nid, const_cast<char *>(value))};
    return extension && X509_add_ext(cert, extension.get(), -1) == 1;
}

Cert make_cert(EVP_PKEY *key, X509 *issuer, EVP_PKEY *issuer_key, int from_days, int until_days, bool ca = false,
        bool server = true) {
    Cert cert{X509_new()};
    static long serial = 0;
    const long current_serial = ++serial;
    const std::string name = ca ? "Routing test CA " + std::to_string(current_serial) : "vpn.example.test";
    ag::DeclPtr<X509_NAME, &X509_NAME_free> subject{X509_NAME_new()};
    if (!cert || !X509_set_version(cert.get(), 2)
            || !ASN1_INTEGER_set(X509_get_serialNumber(cert.get()), current_serial) || !subject
            || !X509_NAME_add_entry_by_txt(
                    subject.get(), "CN", MBSTRING_ASC, reinterpret_cast<const unsigned char *>(name.c_str()), -1, -1, 0)
            || !X509_set_subject_name(cert.get(), subject.get())
            || !X509_set_issuer_name(
                    cert.get(), issuer ? X509_get_subject_name(issuer) : X509_get_subject_name(cert.get()))
            || !X509_set_pubkey(cert.get(), key)
            || !ASN1_TIME_adj(X509_getm_notBefore(cert.get()), std::time(nullptr), from_days, 0)
            || !ASN1_TIME_adj(X509_getm_notAfter(cert.get()), std::time(nullptr), until_days, 0)
            || !add_extension(cert.get(), NID_basic_constraints, ca ? "critical,CA:TRUE" : "critical,CA:FALSE")
            || !add_extension(cert.get(), NID_key_usage,
                    ca ? "critical,keyCertSign,cRLSign" : "critical,digitalSignature,keyEncipherment")
            || (!ca
                    && (!add_extension(cert.get(), NID_ext_key_usage, server ? "serverAuth" : "clientAuth")
                            || !add_extension(cert.get(), NID_subject_alt_name, "DNS:vpn.example.test")))
            || !X509_sign(cert.get(), issuer_key ? issuer_key : key, EVP_sha256())) {
        return {};
    }
    return cert;
}

class TlsVerify : public ::testing::Test {
protected:
    void SetUp() override {
        ca_key = make_key();
        leaf_key = make_key();
        ASSERT_TRUE(ca_key);
        ASSERT_TRUE(leaf_key);
        ca = make_cert(ca_key.get(), nullptr, nullptr, -30, 365, true);
        store.reset(X509_STORE_new());
        ASSERT_TRUE(ca);
        ASSERT_TRUE(store);
        ASSERT_EQ(X509_STORE_add_cert(store.get(), ca.get()), 1);
    }

    Key ca_key;
    Key leaf_key;
    Cert ca;
    Store store;
};

TEST_F(TlsVerify, ValidCustomCaAndLegacyApiSucceed) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), -1, 30);
    ASSERT_TRUE(leaf);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, store.get());
    EXPECT_EQ(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
    EXPECT_EQ(ag::tls_verify_cert(leaf.get(), nullptr, store.get()), nullptr);
}

TEST_F(TlsVerify, TrustedFutureCertificateIsRejectedWithSpecificCause) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30);
    ASSERT_TRUE(leaf);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_TRUE(result.not_yet_valid);
    EXPECT_NE(ag::tls_verify_cert(leaf.get(), nullptr, store.get()), nullptr);
}

TEST_F(TlsVerify, ExpiredCertificateKeepsGenericCause) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), -30, -1);
    ASSERT_TRUE(leaf);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, UntrustedFutureCertificateDoesNotBecomeClockAdvice) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30);
    Store empty{X509_STORE_new()};
    ASSERT_TRUE(leaf);
    ASSERT_TRUE(empty);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, empty.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, FutureCertificateWithInvalidSignatureKeepsGenericCause) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), leaf_key.get(), 1, 30);
    ASSERT_TRUE(leaf);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, FutureCertificateWithWrongPurposeKeepsGenericCause) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30, false, false);
    ASSERT_TRUE(leaf);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, FutureLeafWithExpiredTrustedRootKeepsGenericCause) {
    auto expired_ca = make_cert(ca_key.get(), nullptr, nullptr, -60, -1, true);
    ASSERT_TRUE(expired_ca);
    auto leaf = make_cert(leaf_key.get(), expired_ca.get(), ca_key.get(), 1, 30);
    Store expired_store{X509_STORE_new()};
    ASSERT_TRUE(leaf);
    ASSERT_TRUE(expired_store);
    ASSERT_EQ(X509_STORE_add_cert(expired_store.get(), expired_ca.get()), 1);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), nullptr, expired_store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, FutureIntermediateInVerifiedChainIsRecognized) {
    auto intermediate = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 60, true);
    ASSERT_TRUE(intermediate);
    auto leaf = make_cert(leaf_key.get(), intermediate.get(), leaf_key.get(), -1, 30);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(leaf);
    ASSERT_TRUE(chain);
    ASSERT_NE(sk_X509_push(chain, intermediate.get()), 0);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), chain, store.get());
    sk_X509_free(chain);
    EXPECT_NE(result.error, nullptr);
    EXPECT_TRUE(result.not_yet_valid);
}

TEST_F(TlsVerify, UnrelatedFutureInputDoesNotChangeValidSelectedChain) {
    auto leaf = make_cert(leaf_key.get(), ca.get(), ca_key.get(), -1, 30);
    auto unrelated = make_cert(leaf_key.get(), nullptr, nullptr, 1, 30, true);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(leaf && unrelated);
    ASSERT_TRUE(chain);
    ASSERT_NE(sk_X509_push(chain, unrelated.get()), 0);
    auto result = ag::tls_verify_cert_detailed(leaf.get(), chain, store.get());
    sk_X509_free(chain);
    EXPECT_EQ(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

#ifdef _WIN32

class WindowsTrustEngine {
public:
    explicit WindowsTrustEngine(X509 *root) {
        roots = CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, 0, nullptr);
        if (roots == nullptr) {
            return;
        }
        std::vector<unsigned char> der(i2d_X509(root, nullptr));
        auto *data = der.data();
        if (der.empty() || i2d_X509(root, &data) <= 0
                || !CertAddEncodedCertificateToStore(
                        roots, X509_ASN_ENCODING, der.data(), DWORD(der.size()), CERT_STORE_ADD_ALWAYS, nullptr)) {
            return;
        }
        CERT_CHAIN_ENGINE_CONFIG config{};
        config.cbSize = sizeof(config);
        config.hExclusiveRoot = roots;
        config.dwFlags = CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL;
        CertCreateCertificateChainEngine(&config, &engine);
    }

    ~WindowsTrustEngine() {
        CertFreeCertificateChainEngine(engine);
        CertCloseStore(roots, 0);
    }

    HCERTCHAINENGINE engine = nullptr;

private:
    HCERTSTORE roots = nullptr;
};

TEST_F(TlsVerify, WindowsMemoryTrustEnginePreservesVerificationAndDistinguishesDates) {
    WindowsTrustEngine engine{ca.get()};
    ASSERT_NE(engine.engine, nullptr);
    auto valid = make_cert(leaf_key.get(), ca.get(), ca_key.get(), -1, 30);
    auto future = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30);
    auto expired = make_cert(leaf_key.get(), ca.get(), ca_key.get(), -30, -1);
    auto bad_signature = make_cert(leaf_key.get(), ca.get(), leaf_key.get(), 1, 30);
    auto wrong_purpose = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30, false, false);
    ASSERT_TRUE(valid && future && expired && bad_signature && wrong_purpose);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(chain);
    EXPECT_EQ(wcrypt_validate_cert(valid.get(), chain, engine.engine), WCRYPT_E_OK);
    EXPECT_EQ(wcrypt_validate_cert(future.get(), chain, engine.engine), WCRYPT_E_CERT_NOT_YET_VALID);
    auto expired_result = wcrypt_validate_cert(expired.get(), chain, engine.engine);
    EXPECT_NE(expired_result, WCRYPT_E_OK);
    EXPECT_NE(expired_result, WCRYPT_E_CERT_NOT_YET_VALID);
    EXPECT_NE(wcrypt_validate_cert(bad_signature.get(), chain, engine.engine), WCRYPT_E_CERT_NOT_YET_VALID);
    EXPECT_NE(wcrypt_validate_cert(wrong_purpose.get(), chain, engine.engine), WCRYPT_E_CERT_NOT_YET_VALID);
    sk_X509_free(chain);
}

TEST_F(TlsVerify, WindowsSystemStoreDoesNotTrustGeneratedFutureCertificate) {
    auto future = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 30);
    ASSERT_TRUE(future);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(chain);
    ASSERT_NE(sk_X509_push(chain, ca.get()), 0);
    auto result = ag::tls_verify_cert_detailed(future.get(), chain, nullptr);
    sk_X509_free(chain);
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(TlsVerify, WindowsFutureIntermediateInSelectedChainIsRecognized) {
    WindowsTrustEngine engine{ca.get()};
    ASSERT_NE(engine.engine, nullptr);
    auto intermediate = make_cert(leaf_key.get(), ca.get(), ca_key.get(), 1, 60, true);
    ASSERT_TRUE(intermediate);
    auto leaf = make_cert(leaf_key.get(), intermediate.get(), leaf_key.get(), -1, 30);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(leaf);
    ASSERT_TRUE(chain);
    ASSERT_NE(sk_X509_push(chain, intermediate.get()), 0);
    EXPECT_EQ(wcrypt_validate_cert(leaf.get(), chain, engine.engine), WCRYPT_E_CERT_NOT_YET_VALID);
    sk_X509_free(chain);
}

TEST_F(TlsVerify, WindowsFutureLeafWithExpiredTrustedRootKeepsGenericCause) {
    auto expired_ca = make_cert(ca_key.get(), nullptr, nullptr, -60, -1, true);
    ASSERT_TRUE(expired_ca);
    WindowsTrustEngine engine{expired_ca.get()};
    ASSERT_NE(engine.engine, nullptr);
    auto leaf = make_cert(leaf_key.get(), expired_ca.get(), ca_key.get(), 1, 30);
    ASSERT_TRUE(leaf);
    STACK_OF(X509) *chain = sk_X509_new_null();
    ASSERT_TRUE(chain);
    auto result = wcrypt_validate_cert(leaf.get(), chain, engine.engine);
    sk_X509_free(chain);
    EXPECT_NE(result, WCRYPT_E_OK);
    EXPECT_NE(result, WCRYPT_E_CERT_NOT_YET_VALID);
}

#endif

} // namespace
