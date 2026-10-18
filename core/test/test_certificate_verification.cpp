#include <gtest/gtest.h>
#include <openssl/evp.h>
#include <openssl/x509v3.h>

#include "vpn_manager.h"

namespace {

class CertificateVerification : public ::testing::Test {
protected:
    void SetUp() override {
        ag::DeclPtr<EVP_PKEY_CTX, &EVP_PKEY_CTX_free> key_ctx{EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, nullptr)};
        ASSERT_TRUE(key_ctx);
        ASSERT_EQ(EVP_PKEY_keygen_init(key_ctx.get()), 1);
        ASSERT_EQ(EVP_PKEY_CTX_set_rsa_keygen_bits(key_ctx.get(), 2048), 1);
        EVP_PKEY *raw_key = nullptr;
        ASSERT_EQ(EVP_PKEY_keygen(key_ctx.get(), &raw_key), 1);
        ag::DeclPtr<EVP_PKEY, &EVP_PKEY_free> key{raw_key};
        cert.reset(X509_new());
        ASSERT_TRUE(cert);
        ASSERT_EQ(X509_set_version(cert.get(), 2), 1);
        ASSERT_EQ(ASN1_INTEGER_set(X509_get_serialNumber(cert.get()), 1), 1);
        ag::DeclPtr<X509_NAME, &X509_NAME_free> subject{X509_NAME_new()};
        ASSERT_TRUE(subject);
        ASSERT_EQ(X509_NAME_add_entry_by_txt(subject.get(), "CN", MBSTRING_ASC,
                          reinterpret_cast<const unsigned char *>("vpn.example.test"), -1, -1, 0),
                1);
        ASSERT_EQ(X509_set_subject_name(cert.get(), subject.get()), 1);
        ASSERT_EQ(X509_set_issuer_name(cert.get(), subject.get()), 1);
        ASSERT_EQ(X509_set_pubkey(cert.get(), key.get()), 1);
        ASSERT_NE(X509_gmtime_adj(X509_getm_notBefore(cert.get()), 86400), nullptr);
        ASSERT_NE(X509_gmtime_adj(X509_getm_notAfter(cert.get()), 30 * 86400), nullptr);
        ag::DeclPtr<X509_EXTENSION, &X509_EXTENSION_free> san{X509V3_EXT_nconf_nid(
                nullptr, nullptr, NID_subject_alt_name, const_cast<char *>("DNS:vpn.example.test,IP:192.0.2.1"))};
        ASSERT_TRUE(san);
        ASSERT_EQ(X509_add_ext(cert.get(), san.get(), -1), 1);
        ASSERT_GT(X509_sign(cert.get(), key.get(), EVP_sha256()), 0);

        vpn.handler = {[](void *arg, ag::VpnEvent event, void *data) {
                           if (event == ag::VPN_EVENT_VERIFY_CERTIFICATE) {
                               static_cast<ag::VpnVerifyCertificateEvent *>(data)->result = *static_cast<int *>(arg);
                           }
                       },
                &application_result};
    }

    int verify(const char *host, const char *ip = nullptr) {
        ctx = {cert.get(), nullptr, nullptr, ag::VT_ENDPOINT};
        auto callback = vpn.make_client_parameters().cert_verify_handler;
        ag::SocketAddress address{ip ? ip : ""};
        return callback.func(host, ip ? address.c_sockaddr() : nullptr, ctx, callback.arg);
    }

    // This application cause stands for a chain already checked by the verifier.
    // Trust/date classification itself is covered by test_tls_verify.
    int application_result = ag::VPN_VCR_CERT_NOT_YET_VALID;
    ag::CertVerifyCtx ctx{};
    ag::DeclPtr<X509, &X509_free> cert;
    ag::Vpn vpn;
};

TEST_F(CertificateVerification, FutureCertificateWithMatchingHostnameKeepsSpecificCause) {
    EXPECT_EQ(verify("vpn.example.test"), 0);
    EXPECT_EQ(ctx.handler_result, ag::VPN_VCR_CERT_NOT_YET_VALID);
}

TEST_F(CertificateVerification, FutureCertificateWithWrongHostnameBecomesGeneric) {
    EXPECT_EQ(verify("other.example.test"), 0);
    EXPECT_EQ(ctx.handler_result, -1);
}

TEST_F(CertificateVerification, FutureCertificateWithWrongIpBecomesGeneric) {
    EXPECT_EQ(verify(nullptr, "192.0.2.2:443"), 0);
    EXPECT_EQ(ctx.handler_result, -1);
}

TEST_F(CertificateVerification, FutureCertificateWithMatchingIpKeepsSpecificCause) {
    EXPECT_EQ(verify(nullptr, "192.0.2.1:443"), 0);
    EXPECT_EQ(ctx.handler_result, ag::VPN_VCR_CERT_NOT_YET_VALID);
}

TEST_F(CertificateVerification, MatchingIpFallbackIsAnAcceptedIdentity) {
    EXPECT_EQ(verify("other.example.test", "192.0.2.1:443"), 0);
    EXPECT_EQ(ctx.handler_result, ag::VPN_VCR_CERT_NOT_YET_VALID);
}

TEST_F(CertificateVerification, SuccessfulChainWithWrongIdentityBecomesGeneric) {
    application_result = 0;
    EXPECT_EQ(verify("other.example.test"), 0);
    EXPECT_EQ(ctx.handler_result, -1);
}

TEST_F(CertificateVerification, SuccessfulChainWithMatchingIdentitySucceeds) {
    application_result = 0;
    EXPECT_EQ(verify("vpn.example.test"), 1);
    EXPECT_EQ(ctx.handler_result, 0);
}

TEST_F(CertificateVerification, ExplicitHostnameSkipRetainsExistingSemantics) {
    application_result = ag::VPN_VCR_SKIP_HOSTNAME_VERIFICATION;
    EXPECT_EQ(verify("other.example.test"), 1);
    EXPECT_EQ(ctx.handler_result, 0);
}

} // namespace
