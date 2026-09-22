use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const VERSION: &str = "2.2.1";
const SERVICE_NAME: &str = "ClaudeUsageWidget";
const CREDENTIAL_ACCOUNT: &str = "claude-oauth";
const API_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES: &str = "user:profile user:inference";
const REFRESH_MARGIN_SECS: i64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scope: String,
    token_type: String,
}

#[derive(Debug, Clone, Serialize)]
struct AuthStatus {
    connected: bool,
    oauth_pending: bool,
    oauth_error: Option<String>,
    access_token_expires_in_seconds: Option<i64>,
    storage: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct LimitItem {
    key: String,
    label: String,
    percent_used: f64,
    percent_free: f64,
    resets_at: Option<String>,
    reset_in_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
struct CreditsInfo {
    enabled: bool,
    used: Option<f64>,
    limit: Option<f64>,
    balance: Option<f64>,
    currency: String,
    percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct UsageSnapshot {
    fetched_at: String,
    source_shape: String,
    limits: Vec<LimitItem>,
    credits: Option<CreditsInfo>,
    note: &'static str,
}

#[derive(Debug, Default)]
struct OAuthRuntime {
    pending: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WidgetSettings {
    remember_position: bool,
    hide_on_focus_loss: bool,
    x: Option<i32>,
    y: Option<i32>,
}

impl Default for WidgetSettings {
    fn default() -> Self {
        Self { remember_position: true, hide_on_focus_loss: false, x: None, y: None }
    }
}

#[derive(Clone)]
struct AppState {
    oauth: Arc<Mutex<OAuthRuntime>>,
    settings: Arc<Mutex<WidgetSettings>>,
    http: Client,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_widget_settings(app: &AppHandle) -> WidgetSettings {
    let Ok(path) = settings_path(app) else { return WidgetSettings::default(); };
    let Ok(text) = std::fs::read_to_string(path) else { return WidgetSettings::default(); };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_widget_settings(app: &AppHandle, settings: &WidgetSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn work_area_for_position(window: &WebviewWindow, x: i32, y: i32) -> Result<(i32, i32, u32, u32), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    if let Some(monitor) = monitors.iter().find(|m| {
        let a = m.work_area();
        let left = a.position.x;
        let top = a.position.y;
        let right = left + a.size.width as i32;
        let bottom = top + a.size.height as i32;
        x >= left && x < right && y >= top && y < bottom
    }) {
        let a = monitor.work_area();
        return Ok((a.position.x, a.position.y, a.size.width, a.size.height));
    }

    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Kein Monitor gefunden".to_string())?;
    let a = monitor.work_area();
    Ok((a.position.x, a.position.y, a.size.width, a.size.height))
}

fn clamp_to_work_area(window: &WebviewWindow, x: i32, y: i32) -> Result<PhysicalPosition<i32>, String> {
    let (area_x, area_y, area_width, area_height) = work_area_for_position(window, x, y)?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let min_x = area_x;
    let min_y = area_y;
    let max_x = area_x + area_width as i32 - size.width as i32;
    let max_y = area_y + area_height as i32 - size.height as i32;
    Ok(PhysicalPosition::new(
        x.clamp(min_x, max_x.max(min_x)),
        y.clamp(min_y, max_y.max(min_y)),
    ))
}

fn position_bottom_right(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Kein primärer Monitor gefunden".to_string())?;
    let area = monitor.work_area();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let margin = 12i32;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let pos = clamp_to_work_area(window, x, y)?;
    window.set_position(pos).map_err(|e| e.to_string())
}

fn apply_saved_or_default_position(app: &AppHandle, window: &WebviewWindow) {
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();

    if settings.remember_position {
        if let (Some(x), Some(y)) = (settings.x, settings.y) {
            if let Ok(pos) = clamp_to_work_area(window, x, y) {
                let _ = window.set_position(pos);
                return;
            }
        }
    }
    let _ = position_bottom_right(window);
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, CREDENTIAL_ACCOUNT).map_err(|e| e.to_string())
}

fn load_credentials() -> Result<Option<Credentials>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| format!("Credential-Daten beschädigt: {e}")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Windows Credential Manager: {e}")),
    }
}

fn save_credentials(creds: &Credentials) -> Result<(), String> {
    let payload = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    keyring_entry()?.set_password(&payload).map_err(|e| format!("Windows Credential Manager: {e}"))
}

fn clear_credentials() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Windows Credential Manager: {e}")),
    }
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn make_pkce() -> (String, String) {
    let verifier = random_urlsafe(32);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    token_type: Option<String>,
}

async fn token_request(http: &Client, body: Value) -> Result<OAuthTokenResponse, String> {
    let response = http
        .post(OAUTH_TOKEN_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("User-Agent", format!("claude-usage-widget/{VERSION}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OAuth-Netzwerkfehler: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error_description").or_else(|| v.get("message")).and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("OAuth-Token-Endpunkt: {detail}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Ungültige OAuth-Antwort: {e}"))
}

fn response_to_credentials(payload: OAuthTokenResponse, previous: Option<&Credentials>) -> Result<Credentials, String> {
    let refresh = payload
        .refresh_token
        .or_else(|| previous.map(|p| p.refresh_token.clone()))
        .ok_or_else(|| "Anthropic lieferte keinen Refresh-Token.".to_string())?;
    Ok(Credentials {
        access_token: payload.access_token,
        refresh_token: refresh,
        expires_at: now_unix() + payload.expires_in.unwrap_or(3600),
        scope: payload.scope.or_else(|| previous.map(|p| p.scope.clone())).unwrap_or_else(|| OAUTH_SCOPES.to_string()),
        token_type: payload.token_type.or_else(|| previous.map(|p| p.token_type.clone())).unwrap_or_else(|| "Bearer".to_string()),
    })
}

async fn refresh_credentials(state: &AppState, previous: &Credentials) -> Result<Credentials, String> {
    let payload = token_request(
        &state.http,
        serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": previous.refresh_token,
            "client_id": OAUTH_CLIENT_ID,
            "scope": previous.scope,
        }),
    )
    .await?;
    let creds = response_to_credentials(payload, Some(previous))?;
    save_credentials(&creds)?;
    Ok(creds)
}

async fn valid_credentials(state: &AppState, force_refresh: bool) -> Result<Credentials, String> {
    let creds = load_credentials()?.ok_or_else(|| "AUTH_REQUIRED".to_string())?;
    if force_refresh || creds.expires_at <= now_unix() + REFRESH_MARGIN_SECS {
        refresh_credentials(state, &creds).await
    } else {
        Ok(creds)
    }
}

async fn fetch_usage_payload(state: &AppState) -> Result<Value, String> {
    let mut creds = valid_credentials(state, false).await?;
    for attempt in 0..2 {
        let response = state
            .http
            .get(API_URL)
            .bearer_auth(&creds.access_token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("anthropic-version", "2023-06-01")
            .header("Accept", "application/json")
            .header("x-app", "cli")
            .header("User-Agent", format!("claude-usage-widget-tauri/{VERSION}"))
            .send()
            .await
            .map_err(|e| format!("Anthropic Usage API: {e}"))?;

        if (response.status().as_u16() == 401 || response.status().as_u16() == 403) && attempt == 0 {
            creds = valid_credentials(state, true).await?;
            continue;
        }
        let status = response.status();
        if status.as_u16() == 429 {
            return Err("Usage-Endpunkt ist vorübergehend rate-limited.".into());
        }
        if !status.is_success() {
            return Err(format!("Anthropic Usage API: HTTP {}", status.as_u16()));
        }
        return response.json::<Value>().await.map_err(|e| format!("Ungültige Usage-Antwort: {e}"));
    }
    Err("AUTH_REQUIRED".into())
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok())))
}

fn reset_secs(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let dt = DateTime::parse_from_rfc3339(value).ok()?;
    Some((dt.timestamp() - Utc::now().timestamp()).max(0))
}

fn label_for_kind(kind: &str, item: Option<&Value>) -> String {
    if let Some(display) = item
        .and_then(|x| x.get("scope"))
        .and_then(|x| x.get("model"))
        .and_then(|x| x.get("display_name").or_else(|| x.get("name")))
        .and_then(Value::as_str)
    {
        return format!("Woche · {display}");
    }
    match kind {
        "session" => "Session".into(),
        "weekly_all" | "seven_day" => "Woche · gesamt".into(),
        "weekly_scoped" => "Woche · Modell".into(),
        "five_hour" => "5 Stunden".into(),
        "seven_day_sonnet" => "Woche · Sonnet".into(),
        "seven_day_opus" => "Woche · Opus".into(),
        "seven_day_oauth_apps" => "Woche · OAuth Apps".into(),
        "seven_day_cowork" => "Woche · Cowork".into(),
        _ => kind.replace('_', " "),
    }
}

fn money(value: Option<&Value>) -> Option<f64> {
    let v = value?;
    if let Some(n) = v.as_f64() {
        return Some(n / 100.0);
    }
    let obj = v.as_object()?;
    if let Some(amount) = num(obj.get("amount_minor")) {
        let exp = obj.get("exponent").and_then(Value::as_i64).unwrap_or(2);
        return Some(amount / 10f64.powi(exp as i32));
    }
    ["amount", "value", "credits"].iter().find_map(|k| num(obj.get(*k)))
}

fn parse_snapshot(payload: &Value) -> UsageSnapshot {
    let mut limits = Vec::new();
    let mut source_shape = "legacy".to_string();

    if let Some(items) = payload.get("limits").and_then(Value::as_array) {
        source_shape = "limits[]".into();
        for (idx, item) in items.iter().enumerate() {
            let mut pct = num(item.get("percent")).or_else(|| num(item.get("utilization")));
            let Some(mut pct) = pct.take() else { continue };
            pct = pct.clamp(0.0, 100.0);
            let kind = item.get("kind").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("limit_{idx}"));
            let model = item.get("scope").and_then(|x| x.get("model")).and_then(|x| x.get("display_name")).and_then(Value::as_str);
            let key = model.map(|m| format!("{kind}:{m}")).unwrap_or_else(|| kind.clone());
            let resets = item.get("resets_at").and_then(Value::as_str).map(str::to_owned);
            limits.push(LimitItem {
                key,
                label: label_for_kind(&kind, Some(item)),
                percent_used: pct,
                percent_free: (100.0 - pct).max(0.0),
                reset_in_seconds: reset_secs(resets.as_deref()),
                resets_at: resets,
            });
        }
    }

    if limits.is_empty() {
        for key in ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "seven_day_oauth_apps", "seven_day_cowork"] {
            let Some(item) = payload.get(key) else { continue };
            let Some(mut pct) = num(item.get("utilization")) else { continue };
            pct = pct.clamp(0.0, 100.0);
            let resets = item.get("resets_at").and_then(Value::as_str).map(str::to_owned);
            limits.push(LimitItem {
                key: key.into(),
                label: label_for_kind(key, None),
                percent_used: pct,
                percent_free: (100.0 - pct).max(0.0),
                reset_in_seconds: reset_secs(resets.as_deref()),
                resets_at: resets,
            });
        }
    }

    let mut credits: Option<CreditsInfo> = None;
    if let Some(spend) = payload.get("spend").and_then(Value::as_object) {
        credits = Some(CreditsInfo {
            enabled: spend.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            used: money(spend.get("used")),
            limit: money(spend.get("limit")),
            balance: money(spend.get("balance")),
            currency: spend.get("currency").and_then(Value::as_str).unwrap_or("USD").into(),
            percent: num(spend.get("percent")),
        });
    }
    if let Some(extra) = payload.get("extra_usage").and_then(Value::as_object) {
        let ext = CreditsInfo {
            enabled: extra.get("is_enabled").and_then(Value::as_bool).unwrap_or(false),
            used: money(extra.get("used_credits")),
            limit: money(extra.get("monthly_limit")),
            balance: None,
            currency: extra.get("currency").and_then(Value::as_str).unwrap_or("USD").into(),
            percent: num(extra.get("utilization")),
        };
        match &mut credits {
            None => credits = Some(ext),
            Some(c) => {
                c.enabled |= ext.enabled;
                if c.used.is_none() { c.used = ext.used; }
                if c.limit.is_none() { c.limit = ext.limit; }
                if c.percent.is_none() { c.percent = ext.percent; }
            }
        }
    }

    UsageSnapshot {
        fetched_at: Utc::now().to_rfc3339(),
        source_shape,
        limits,
        credits,
        note: "Planlimits sind Prozentwerte der von Anthropic gemeldeten Usage-Quote; kein absoluter Rest-Tokenzähler.",
    }
}

fn parse_query(path: &str) -> HashMap<String, String> {
    let url = Url::parse(&format!("http://localhost{path}")).ok();
    url.map(|u| u.query_pairs().into_owned().collect()).unwrap_or_default()
}

fn read_request(stream: &mut TcpStream) -> Result<String, String> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

fn write_html(stream: &mut TcpStream, status: &str, title: &str, message: &str) {
    let safe = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let html = format!(r#"<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{}</title><style>body{{font:16px system-ui;background:#151413;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}}.c{{max-width:560px;padding:28px;background:#23211f;border:1px solid #3b3834;border-radius:18px}}h1{{font-size:21px}}p{{color:#bbb;line-height:1.5}}</style><div class="c"><h1>{}</h1><p>{}</p></div></html>"#, safe(title), safe(title), safe(message));
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.as_bytes().len(), html);
    let _ = stream.write_all(response.as_bytes());
}

async fn exchange_auth_code(state: &AppState, code: String, oauth_state: String, expected_state: String, redirect_uri: String, verifier: String) -> Result<(), String> {
    if oauth_state != expected_state {
        return Err("OAuth-State stimmt nicht überein. Anmeldung abgebrochen.".into());
    }
    let payload = token_request(
        &state.http,
        serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": OAUTH_CLIENT_ID,
            "code_verifier": verifier,
            "state": expected_state,
        }),
    ).await?;
    let creds = response_to_credentials(payload, None)?;
    save_credentials(&creds)
}

#[tauri::command]
fn auth_status(state: tauri::State<'_, AppState>) -> Result<AuthStatus, String> {
    let oauth = state.oauth.lock().map_err(|_| "OAuth-Status gesperrt".to_string())?;
    let creds = load_credentials()?;
    Ok(AuthStatus {
        connected: creds.is_some(),
        oauth_pending: oauth.pending,
        oauth_error: oauth.error.clone(),
        access_token_expires_in_seconds: creds.as_ref().map(|c| (c.expires_at - now_unix()).max(0)),
        storage: "Windows Credential Manager",
    })
}

#[tauri::command]
async fn get_usage(state: tauri::State<'_, AppState>) -> Result<UsageSnapshot, String> {
    let payload = fetch_usage_payload(&state).await?;
    Ok(parse_snapshot(&payload))
}

#[tauri::command]
fn disconnect(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    clear_credentials()?;
    if let Ok(mut oauth) = state.oauth.lock() {
        oauth.pending = false;
        oauth.error = None;
    }
    let _ = app.emit("auth-changed", ());
    Ok(())
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main").ok_or("Fenster fehlt")?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_remember_position(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state
        .settings
        .lock()
        .map(|s| s.remember_position)
        .map_err(|_| "Widget-Einstellungen gesperrt".to_string())
}

#[tauri::command]
fn set_remember_position(app: AppHandle, state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|_| "Widget-Einstellungen gesperrt".to_string())?;
    settings.remember_position = enabled;
    save_widget_settings(&app, &settings)
}

#[tauri::command]
fn get_hide_on_focus_loss(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state
        .settings
        .lock()
        .map(|s| s.hide_on_focus_loss)
        .map_err(|_| "Widget-Einstellungen gesperrt".to_string())
}

#[tauri::command]
fn set_hide_on_focus_loss(app: AppHandle, state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut settings = state.settings.lock().map_err(|_| "Widget-Einstellungen gesperrt".to_string())?;
    settings.hide_on_focus_loss = enabled;
    save_widget_settings(&app, &settings)
}

#[tauri::command]
fn start_oauth(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    {
        let mut runtime = state.oauth.lock().map_err(|_| "OAuth-Status gesperrt".to_string())?;
        if runtime.pending {
            return Err("Eine Claude-Anmeldung läuft bereits.".into());
        }
        runtime.pending = true;
        runtime.error = None;
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("Lokaler OAuth-Port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{port}/callback");
    let (verifier, challenge) = make_pkce();
    let expected_state = random_urlsafe(32);

    let mut auth_url = Url::parse(OAUTH_AUTHORIZE_URL).map_err(|e| e.to_string())?;
    auth_url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", OAUTH_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", OAUTH_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &expected_state);

    app.opener().open_url(auth_url.as_str(), None::<&str>).map_err(|e| {
        if let Ok(mut runtime) = state.oauth.lock() { runtime.pending = false; runtime.error = Some(e.to_string()); }
        e.to_string()
    })?;

    let app2 = app.clone();
    let app_state = state.inner().clone();
    thread::spawn(move || {
        let result: Result<(), String> = (|| {
            listener.set_nonblocking(false).map_err(|e| e.to_string())?;
            let (mut stream, _) = listener.accept().map_err(|e| format!("OAuth-Callback: {e}"))?;
            let request = read_request(&mut stream)?;
            let first = request.lines().next().ok_or("Leere OAuth-Anfrage")?;
            let path = first.split_whitespace().nth(1).ok_or("Ungültige OAuth-Anfrage")?;
            let query = parse_query(path);
            let code = query.get("code").cloned().ok_or("OAuth-Callback ohne Code")?;
            let returned_state = query.get("state").cloned().ok_or("OAuth-Callback ohne State")?;

            let rt = tauri::async_runtime::block_on(exchange_auth_code(
                &app_state,
                code,
                returned_state,
                expected_state,
                redirect_uri,
                verifier,
            ));
            match rt {
                Ok(_) => {
                    write_html(&mut stream, "200 OK", "Claude verbunden", "Die Anmeldung war erfolgreich. Dieses Fenster kann geschlossen werden.");
                    Ok(())
                }
                Err(e) => {
                    write_html(&mut stream, "400 Bad Request", "Anmeldung fehlgeschlagen", &e);
                    Err(e)
                }
            }
        })();

        if let Ok(mut runtime) = app_state.oauth.lock() {
            runtime.pending = false;
            runtime.error = result.err();
        }
        let _ = app2.emit("auth-changed", ());
        if let Some(window) = app2.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    Ok(())
}

fn show_widget(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let remember = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|s| s.remember_position)
                .unwrap_or(true);
            if !remember {
                let _ = position_bottom_right(&window);
            } else {
                apply_saved_or_default_position(app, &window);
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        oauth: Arc::new(Mutex::new(OAuthRuntime::default())),
        settings: Arc::new(Mutex::new(WidgetSettings::default())),
        http: Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("HTTP client"),
    };

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            auth_status,
            get_usage,
            start_oauth,
            disconnect,
            hide_window,
            quit_app,
            get_autostart,
            set_autostart,
            get_remember_position,
            set_remember_position,
            get_hide_on_focus_loss,
            set_hide_on_focus_loss
        ])
        .setup(|app| {
            let loaded_settings = load_widget_settings(app.handle());
            if let Ok(mut settings) = app.state::<AppState>().settings.lock() {
                *settings = loaded_settings;
            }

            let open = MenuItemBuilder::with_id("open", "Dashboard öffnen").build(app)?;
            let refresh = MenuItemBuilder::with_id("refresh", "Jetzt aktualisieren").build(app)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItemBuilder::with_id("autostart", "Mit Windows starten")
                .checked(autostart_enabled)
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Beenden").build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open, &refresh, &autostart, &sep, &quit])
                .build()?;

            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Claude Usage Widget")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_widget(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_widget(app),
                    "refresh" => { let _ = app.emit("manual-refresh", ()); show_widget(app); }
                    "autostart" => {
                        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                        let _ = if enabled { app.autolaunch().disable() } else { app.autolaunch().enable() };
                        let now = app.autolaunch().is_enabled().unwrap_or(false);
                        let _ = autostart.set_checked(now);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = icon { tray_builder = tray_builder.icon(icon); }
            tray_builder.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                apply_saved_or_default_position(app.handle(), &window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            if let WindowEvent::Moved(position) = event {
                let app = window.app_handle();
                let settings_store = app.state::<AppState>().settings.clone();
                if let Ok(mut settings) = settings_store.lock() {
                    if settings.remember_position {
                        settings.x = Some(position.x);
                        settings.y = Some(position.y);
                        let snapshot = settings.clone();
                        drop(settings);
                        let _ = save_widget_settings(app, &snapshot);
                    }
                };
            }
            if let WindowEvent::Focused(false) = event {
                let hide_on_focus_loss = window
                    .app_handle()
                    .state::<AppState>()
                    .settings
                    .lock()
                    .map(|s| s.hide_on_focus_loss)
                    .unwrap_or(false);
                if hide_on_focus_loss {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Claude Usage Widget");
}
