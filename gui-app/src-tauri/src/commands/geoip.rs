// GeoIP lookup for server IP via ipwho.is (Phase 13, D-04/D-05/D-07/D-08).
// Pattern source: gui-app/src-tauri/src/commands/network.rs:4-54 (speedtest_run).

use serde::{Deserialize, Serialize};

/// Публичная структура — форма ответа к фронту.
/// Поля совпадают с TS-интерфейсом GeoIpInfo в useServerGeoIp.ts.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct GeoIpInfo {
    pub country: String,
    pub country_code: String,
    pub flag_emoji: String,
}

/// ipwho.is response shape (partial — только нужные поля).
/// [VERIFIED 2026-04-17: live-запрос к https://ipwho.is/8.8.8.8 возвращает эти поля]
#[derive(Deserialize, Debug)]
struct IpWhoResponse {
    success: bool,
    message: Option<String>,
    country: Option<String>,
    country_code: Option<String>,
    flag: Option<IpWhoFlag>,
}

#[derive(Deserialize, Debug)]
struct IpWhoFlag {
    emoji: Option<String>,
}

/// Возвращает данные о стране для указанного IP/хоста сервера.
///
/// Errors (строковые коды, маппятся фронтом через translateSshError):
/// - GEOIP_TIMEOUT — reqwest timeout (>5s)
/// - GEOIP_NO_NETWORK — connect error (нет интернета)
/// - GEOIP_RATE_LIMITED — HTTP 429 от ipwho.is
/// - GEOIP_INVALID_RESPONSE|{detail} — parse fail или success=false от API
#[tauri::command]
pub async fn get_server_geoip(_host: String) -> Result<GeoIpInfo, String> {
    // RED phase placeholder — replaced with real implementation in GREEN commit.
    unimplemented!("get_server_geoip not yet implemented (RED phase)")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Чистый unit-тест без network I/O: проверяем, что serde корректно
    // разбирает ответ ipwho.is с emoji во вложенной структуре flag.
    // Используются Unicode escapes в строковых литералах Rust для
    // переносимости исходника (US flag = U+1F1FA + U+1F1F8).
    #[test]
    fn deserializes_ipwho_success_response() {
        let us_flag = "\u{1f1fa}\u{1f1f8}";
        let json = format!(
            r#"{{
                "success": true,
                "country": "United States",
                "country_code": "US",
                "flag": {{ "emoji": "{us_flag}" }}
            }}"#
        );
        let parsed: IpWhoResponse = serde_json::from_str(&json).expect("valid JSON");
        assert!(parsed.success);
        assert_eq!(parsed.country.as_deref(), Some("United States"));
        assert_eq!(parsed.country_code.as_deref(), Some("US"));
        assert_eq!(
            parsed.flag.and_then(|f| f.emoji).as_deref(),
            Some(us_flag)
        );
    }

    #[test]
    fn deserializes_ipwho_failure_response_with_message() {
        let json = r#"{
            "success": false,
            "message": "Reserved range"
        }"#;
        let parsed: IpWhoResponse = serde_json::from_str(json).expect("valid JSON");
        assert!(!parsed.success);
        assert_eq!(parsed.message.as_deref(), Some("Reserved range"));
    }

    #[test]
    fn geoip_info_roundtrips_serde() {
        let info = GeoIpInfo {
            country: "Germany".into(),
            country_code: "DE".into(),
            flag_emoji: "\u{1f1e9}\u{1f1ea}".into(),
        };
        let encoded = serde_json::to_string(&info).expect("serializable");
        let decoded: GeoIpInfo =
            serde_json::from_str(&encoded).expect("roundtrip");
        assert_eq!(decoded, info);
    }
}
