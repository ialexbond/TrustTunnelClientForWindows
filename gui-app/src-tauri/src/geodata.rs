use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

// ─── Geodata directory (next to exe) ─────────────────────

fn geodata_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let base = exe.parent().unwrap_or(std::path::Path::new("."));
    base.join("geodata")
}

fn routing_rules_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let base = exe.parent().unwrap_or(std::path::Path::new("."));
    base.join("routing_rules.json")
}

// ─── Preset categories ──────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct GeodataSource {
    pub id: String,
    pub name: String,
    pub description: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: String, // "geoip" or "geosite"
}

fn preset_sources() -> Vec<GeodataSource> {
    vec![
        // GeoIP sources (CIDR lists)
        GeodataSource {
            id: "geoip-ru".into(),
            name: "🇷🇺 Все IP России".into(),
            description: "Полный список российских IP-подсетей (v2fly). Для режима «RU напрямую»".into(),
            url: "https://raw.githubusercontent.com/v2fly/geoip/release/text/ru.txt".into(),
            kind: "geoip".into(),
        },
        GeodataSource {
            id: "geoip-ru-blocked".into(),
            name: "🇷🇺 Заблокированные IP (РКН)".into(),
            description: "IP-адреса и подсети, заблокированные Роскомнадзором".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geoip/release/text/ru-blocked.txt".into(),
            kind: "geoip".into(),
        },
        GeodataSource {
            id: "geoip-ru-blocked-community".into(),
            name: "🇷🇺 Заблокированные IP (Community)".into(),
            description: "Расширенный community-список заблокированных IP".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geoip/release/text/ru-blocked-community.txt".into(),
            kind: "geoip".into(),
        },
        GeodataSource {
            id: "geoip-private".into(),
            name: "🏠 Локальные сети".into(),
            description: "Приватные/зарезервированные сети (192.168.x.x, 10.x.x.x и т.д.)".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geoip/release/text/private.txt".into(),
            kind: "geoip".into(),
        },
        // GeoSite sources (domain lists)
        GeodataSource {
            id: "geosite-ru-blocked".into(),
            name: "🇷🇺 Заблокированные домены (РКН)".into(),
            description: "Домены, заблокированные Роскомнадзором".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geosite/release/ru-blocked.txt".into(),
            kind: "geosite".into(),
        },
        GeodataSource {
            id: "geosite-category-ads-all".into(),
            name: "🚫 Реклама (все домены)".into(),
            description: "Полный список рекламных и трекинговых доменов".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geosite/release/category-ads-all.txt".into(),
            kind: "geosite".into(),
        },
        GeodataSource {
            id: "geosite-win-spy".into(),
            name: "🪟 Windows телеметрия".into(),
            description: "Домены слежки и сбора аналитики Windows".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geosite/release/win-spy.txt".into(),
            kind: "geosite".into(),
        },
        GeodataSource {
            id: "geosite-win-update".into(),
            name: "🪟 Windows обновления".into(),
            description: "Домены, используемые для обновлений Windows".into(),
            url: "https://raw.githubusercontent.com/runetfreedom/russia-blocked-geosite/release/win-update.txt".into(),
            kind: "geosite".into(),
        },
    ]
}

// ─── Geodata status ─────────────────────────────────────

#[derive(Serialize)]
pub struct GeodataFileStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub downloaded: bool,
    pub entry_count: usize,
    pub updated_at: Option<String>,
}

#[tauri::command]
pub fn get_geodata_status() -> Result<Vec<GeodataFileStatus>, String> {
    let dir = geodata_dir();
    let mut result = Vec::new();

    for source in preset_sources() {
        let file_path = dir.join(format!("{}.txt", source.id));
        let (downloaded, entry_count, updated_at) = if file_path.exists() {
            let content = std::fs::read_to_string(&file_path).unwrap_or_default();
            let count = content.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count();
            let meta = std::fs::metadata(&file_path).ok();
            let modified = meta
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                    let secs = duration.as_secs();
                    // Simple ISO-ish format
                    format!("{}", secs)
                });
            (true, count, modified)
        } else {
            (false, 0, None)
        };

        result.push(GeodataFileStatus {
            id: source.id,
            name: source.name,
            description: source.description,
            kind: source.kind,
            downloaded,
            entry_count,
            updated_at,
        });
    }

    Ok(result)
}

// ─── Download geodata ───────────────────────────────────

#[tauri::command]
pub async fn download_geodata(app: tauri::AppHandle, source_id: String) -> Result<String, String> {
    let sources = preset_sources();
    let source = sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| format!("Unknown source: {source_id}"))?;

    let dir = geodata_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create geodata dir: {e}"))?;

    app.emit("geodata-progress", serde_json::json!({
        "source_id": source_id, "status": "downloading", "current": 0, "total": 1, "name": source.name
    })).ok();

    let response = reqwest::get(&source.url)
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        app.emit("geodata-progress", serde_json::json!({
            "source_id": source_id, "status": "error", "current": 0, "total": 1
        })).ok();
        return Err(format!(
            "Download failed: HTTP {} — URL may have changed: {}",
            response.status(),
            source.url
        ));
    }

    let content = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;

    let file_path = dir.join(format!("{}.txt", source.id));
    std::fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to save file: {e}"))?;

    let count = content.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count();

    app.emit("geodata-progress", serde_json::json!({
        "source_id": source_id, "status": "done", "current": 1, "total": 1, "entries": count
    })).ok();

    Ok(format!("Downloaded {count} entries"))
}

#[tauri::command]
pub async fn download_all_geodata(app: tauri::AppHandle) -> Result<String, String> {
    let sources = preset_sources();
    let dir = geodata_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create geodata dir: {e}"))?;

    let mut ok_count = 0;
    let mut err_count = 0;
    let total = sources.len();

    for (i, source) in sources.iter().enumerate() {
        app.emit("geodata-progress", serde_json::json!({
            "source_id": source.id, "status": "downloading",
            "current": i, "total": total, "name": source.name
        })).ok();

        match reqwest::get(&source.url).await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(content) = resp.text().await {
                    let file_path = dir.join(format!("{}.txt", source.id));
                    if std::fs::write(&file_path, &content).is_ok() {
                        ok_count += 1;
                        app.emit("geodata-progress", serde_json::json!({
                            "source_id": source.id, "status": "done",
                            "current": i + 1, "total": total
                        })).ok();
                        continue;
                    }
                }
                err_count += 1;
            }
            _ => {
                err_count += 1;
                app.emit("geodata-progress", serde_json::json!({
                    "source_id": source.id, "status": "error",
                    "current": i + 1, "total": total
                })).ok();
            }
        }
    }

    app.emit("geodata-progress", serde_json::json!({
        "source_id": "__all", "status": "complete",
        "current": total, "total": total
    })).ok();

    if err_count > 0 {
        Ok(format!("Downloaded {ok_count}/{total}, failed: {err_count}"))
    } else {
        Ok(format!("Downloaded all {ok_count} sources"))
    }
}

// ─── Resolve categories ─────────────────────────────────

#[tauri::command]
pub fn resolve_geodata_category(source_id: String) -> Result<Vec<String>, String> {
    let dir = geodata_dir();
    let file_path = dir.join(format!("{source_id}.txt"));

    if !file_path.exists() {
        return Err(format!("Geodata file not found: {source_id}. Download it first."));
    }

    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let entries: Vec<String> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            // Strip v2ray-style prefixes: "domain:example.com" → "example.com"
            let stripped = l.strip_prefix("domain:")
                .or_else(|| l.strip_prefix("full:"))
                .or_else(|| l.strip_prefix("keyword:"))
                .unwrap_or(l);
            stripped.to_string()
        })
        // Skip regexp entries — C++ sidecar doesn't support regex in exclusions
        .filter(|l| !l.starts_with("regexp:"))
        .collect();

    Ok(entries)
}

#[tauri::command]
pub fn list_geodata_sources() -> Vec<GeodataSource> {
    preset_sources()
}

// ─── Routing rules (JSON) ───────────────────────────────

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct RoutingRules {
    pub mode: String, // "general" or "selective"
    pub rules: Vec<RoutingRule>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RoutingRule {
    #[serde(rename = "type")]
    pub kind: String, // "ip", "domain", "geoip", "geosite", "process"
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
}

#[tauri::command]
pub fn load_routing_rules() -> Result<RoutingRules, String> {
    let path = routing_rules_path();
    if !path.exists() {
        return Ok(RoutingRules {
            mode: "general".into(),
            rules: Vec::new(),
        });
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read routing rules: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse routing rules: {e}"))
}

#[tauri::command]
pub fn save_routing_rules(rules: RoutingRules) -> Result<(), String> {
    let path = routing_rules_path();
    let content = serde_json::to_string_pretty(&rules)
        .map_err(|e| format!("Failed to serialize routing rules: {e}"))?;
    std::fs::write(&path, &content)
        .map_err(|e| format!("Failed to write routing rules: {e}"))
}

// ─── Auto-download missing geodata ──────────────────────

async fn ensure_geodata_downloaded(source_id: &str) -> Result<(), String> {
    let dir = geodata_dir();
    let file_path = dir.join(format!("{source_id}.txt"));
    if file_path.exists() {
        return Ok(());
    }

    // Find matching preset source and download
    let sources = preset_sources();
    if let Some(source) = sources.iter().find(|s| s.id == source_id) {
        eprintln!("[routing] Auto-downloading missing geodata: {source_id}");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create geodata dir: {e}"))?;
        let response = reqwest::get(&source.url)
            .await
            .map_err(|e| format!("Download failed for {source_id}: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Download failed for {source_id}: HTTP {}", response.status()));
        }
        let content = response.text().await
            .map_err(|e| format!("Failed to read response for {source_id}: {e}"))?;
        std::fs::write(&file_path, &content)
            .map_err(|e| format!("Failed to save {source_id}: {e}"))?;
        let count = content.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count();
        eprintln!("[routing] Downloaded {source_id}: {count} entries");
    } else {
        return Err(format!("Unknown geodata source: {source_id}"));
    }
    Ok(())
}

// ─── Apply routing to TOML config ───────────────────────

#[tauri::command]
pub async fn apply_routing_to_config(config_path: String) -> Result<(), String> {
    let rules = load_routing_rules()?;

    if rules.rules.is_empty() {
        eprintln!("[routing] No routing rules configured, skipping");
        return Ok(());
    }

    // Read existing TOML config (with recovery for corrupted files)
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: toml::Table = match content.parse() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[routing] TOML parse error: {e}. Attempting recovery...");
            // Try to fix corrupted config by removing all lines starting with "exclusions"
            // and the subsequent array content if the issue is a duplicate key
            let mut fixed_lines: Vec<&str> = Vec::new();
            let mut skip_array = false;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("exclusions") && trimmed.contains('[') {
                    skip_array = true;
                    continue;
                }
                if skip_array {
                    if trimmed == "]" { skip_array = false; continue; }
                    if trimmed.starts_with('"') || trimmed.starts_with("\"") { continue; }
                    skip_array = false;
                }
                fixed_lines.push(line);
            }
            let fixed = fixed_lines.join("\n");
            fixed.parse().map_err(|e2| {
                format!("Не удалось восстановить конфигурацию: {e2}. Удалите файл {config_path} и пересоздайте его.")
            })?
        }
    };

    // Resolve all rules into IP CIDRs and domains
    // Auto-download missing geodata files first
    let mut ip_rules: Vec<String> = Vec::new();
    let mut domain_rules: Vec<String> = Vec::new();

    for rule in &rules.rules {
        if !rule.enabled {
            continue;
        }
        match rule.kind.as_str() {
            "ip" => {
                ip_rules.push(rule.value.clone());
            }
            "domain" => {
                domain_rules.push(rule.value.clone());
            }
            "geoip" => {
                // Auto-download if missing
                if let Err(e) = ensure_geodata_downloaded(&rule.value).await {
                    eprintln!("[routing] Warning: {e}");
                }
                match resolve_geodata_category(rule.value.clone()) {
                    Ok(entries) => {
                        eprintln!("[routing] Resolved geoip:{} → {} CIDRs", rule.value, entries.len());
                        ip_rules.extend(entries);
                    }
                    Err(e) => eprintln!("[routing] Failed to resolve geoip:{}: {e}", rule.value),
                }
            }
            "geosite" => {
                // Auto-download if missing
                if let Err(e) = ensure_geodata_downloaded(&rule.value).await {
                    eprintln!("[routing] Warning: {e}");
                }
                match resolve_geodata_category(rule.value.clone()) {
                    Ok(entries) => {
                        eprintln!("[routing] Resolved geosite:{} → {} domains", rule.value, entries.len());
                        domain_rules.extend(entries);
                    }
                    Err(e) => eprintln!("[routing] Failed to resolve geosite:{}: {e}", rule.value),
                }
            }
            "process" => {
                eprintln!("[routing] Process routing not yet implemented: {}", rule.value);
            }
            _ => {}
        }
    }

    eprintln!("[routing] Total: {} IP rules, {} domain rules, mode={}", ip_rules.len(), domain_rules.len(), rules.mode);

    // Set vpn_mode
    doc.insert("vpn_mode".into(), toml::Value::String(rules.mode.clone()));

    // Update tun section routes
    if let Some(listener) = doc.get_mut("listener") {
        if let Some(tun) = listener.as_table_mut().and_then(|t| t.get_mut("tun")) {
            if let Some(tun_table) = tun.as_table_mut() {
                // Clean up stale keys from previous buggy versions
                tun_table.remove("exclusions");

                match rules.mode.as_str() {
                    "general" => {
                        // General mode: rules are EXCLUSIONS (bypass VPN)
                        tun_table.insert(
                            "included_routes".into(),
                            toml::Value::Array(vec![toml::Value::String("0.0.0.0/0".into())]),
                        );
                        let excluded: Vec<toml::Value> = ip_rules
                            .iter()
                            .map(|r| toml::Value::String(r.clone()))
                            .collect();
                        tun_table.insert("excluded_routes".into(), toml::Value::Array(excluded));
                    }
                    "selective" => {
                        // Selective mode: rules are INCLUSIONS (only these through VPN)
                        let included: Vec<toml::Value> = if ip_rules.is_empty() {
                            vec![toml::Value::String("0.0.0.0/0".into())]
                        } else {
                            ip_rules.iter().map(|r| toml::Value::String(r.clone())).collect()
                        };
                        tun_table.insert("included_routes".into(), toml::Value::Array(included));
                        tun_table.insert(
                            "excluded_routes".into(),
                            toml::Value::Array(Vec::new()),
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    // Remove exclusions from doc — we will serialize them manually
    doc.remove("exclusions");

    // Serialize the main config (without exclusions)
    let main_output = toml::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize TOML: {e}"))?;

    // Build final output: exclusions PREPENDED at the very top (before any [section])
    // This guarantees they are unambiguously top-level keys in TOML spec.
    let mut output = String::new();
    if !domain_rules.is_empty() {
        output.push_str("# Domain exclusions (auto-generated from routing rules)\n");
        output.push_str("exclusions = [\n");
        for domain in &domain_rules {
            // Escape any quotes in domain names
            let escaped = domain.replace('\\', "\\\\").replace('"', "\\\"");
            output.push_str(&format!("  \"{escaped}\",\n"));
        }
        output.push_str("]\n\n");
    }
    output.push_str(&main_output);

    // Verify the output parses correctly before writing
    let verify: Result<toml::Table, _> = output.parse();
    if let Err(e) = &verify {
        eprintln!("[routing] WARNING: Generated TOML fails to parse: {e}");
        eprintln!("[routing] Output length: {} bytes, {} lines", output.len(), output.lines().count());
        return Err(format!("Ошибка генерации конфигурации: {e}"));
    }

    std::fs::write(&config_path, &output)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!("[routing] Config written to {config_path} ({} bytes, {} lines)",
        output.len(), output.lines().count());
    Ok(())
}

// ─── List running processes (for future process-based routing) ─

#[derive(Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
}

#[tauri::command]
pub fn list_running_processes() -> Result<Vec<ProcessInfo>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Failed to run tasklist: {e}"))?;

        let text = String::from_utf8_lossy(&output.stdout);
        let mut seen = std::collections::HashSet::new();
        let mut processes = Vec::new();

        for line in text.lines() {
            let parts: Vec<&str> = line.split(',').collect();
            if parts.len() >= 2 {
                let name = parts[0].trim_matches('"').to_string();
                let pid: u32 = parts[1].trim_matches('"').parse().unwrap_or(0);
                if !name.is_empty() && seen.insert(name.clone()) {
                    processes.push(ProcessInfo { pid, name });
                }
            }
        }
        processes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(processes)
    }
    #[cfg(not(windows))]
    {
        Err("Process listing not supported on this platform".into())
    }
}
