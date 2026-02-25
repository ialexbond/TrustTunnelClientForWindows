package com.adguard.trusttunnel

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

@RunWith(AndroidJUnit4::class)
class DeepLinkInstrumentedTest {
    init {
        System.loadLibrary("trusttunnel_android")
    }

    @Test
    fun decode_is_correct() {
        val uri: String =
            "tt://AQlsb2NhbGhvc3QFBHRlc3QGBHRlc3QCDjEyNy4wLjAuMTo0NDQzCwRhYWJiAwlsb2NhbGhvc3QIQVMwggFPMIH1oAMCAQICFGi8WMY2yFmtW2u_18hMQBa0T4VGMAoGCCqGSM49BAMCMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjAxMzAwMDAwMDBaFw0yNzAxMzAwMDAwMDBaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABB4ozK9KbqScCCTJ8CvTfW4W0r9OEsn4VcQswd-BbP9z-tdyfE5HT4uHLUSZRWUKfZjnRRkHWOwhp9KJhOE-LAWjJTAjMCEGA1UdEQQaMBiCCWxvY2FsaG9zdIILKi5sb2NhbGhvc3QwCgYIKoZIzj0EAwIDSQAwRgIhAO6gFBHDsgvWjPj39JNchcMF3X2ICgzycBwTyydxqpdiAiEAgybYwECuZopK1g6JX5tK0-5B3Of7n0NuPXRGSU5TtSc"

        val decodedConfig: String = DeepLink.decode(uri)

        fun getQuoted(name: String): String {
            val re = Regex("""(?m)^\s*$name\s*=\s*"([^"]*)"""")
            val v = re.find(decodedConfig)?.groupValues?.get(1)
                ?: fail("Field $name not found in:\n$decodedConfig")
            return v.toString()
        }

        fun getBool(name: String): Boolean {
            val re = Regex("""(?m)^\s*$name\s*=\s*(true|false)\s*$""")
            val v = re.find(decodedConfig)?.groupValues?.get(1)
                ?: fail("Field $name not found in:\n$decodedConfig")
            return v.toString().toBooleanStrict()
        }

        fun getArray(name: String): List<String> {
            val re = Regex("""\b$name\s*=\s*\[(.*?)]""", RegexOption.DOT_MATCHES_ALL)
            val inside = re.find(decodedConfig)?.groupValues?.get(1)
                ?: fail("Field $name not found in\n$decodedConfig")
            return Regex(""""([^"]*)"""").findAll(inside.toString()).map { it.groupValues[1] }
                .toList()
        }

        assertEquals("localhost", getQuoted("hostname"))
        assertEquals("test", getQuoted("username"))
        assertEquals("test", getQuoted("password"))
        assertEquals("aabb", getQuoted("client_random"))
        assertEquals("http2", getQuoted("upstream_protocol"))
        assertEquals("localhost", getQuoted("custom_sni"))

        assertTrue(getBool("has_ipv6"))
        assertFalse(getBool("skip_verification"))
        assertFalse(getBool("anti_dpi"))

        assertEquals(listOf("127.0.0.1:4443"), getArray("addresses"))
    }
}