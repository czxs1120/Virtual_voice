//! Text-to-speech through providers the user configures themselves. The app
//! ships no keys or hosted model: requests go straight from this machine to
//! the chosen provider using the user's own credentials.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Duration;

const MAX_TEXT_CHARS: usize = 5000;
const MAX_AUDIO_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TtsProvider {
    #[default]
    Sapi,
    OpenAi,
    Azure,
}

impl TtsProvider {
    fn secret_name(self) -> Option<&'static str> {
        match self {
            TtsProvider::Sapi => None,
            TtsProvider::OpenAi => Some("openai"),
            TtsProvider::Azure => Some("azure"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SapiSettings {
    pub voice: Option<String>,
    /// -10 (slowest) ..= 10 (fastest).
    pub rate: i32,
}

/// Any server exposing the OpenAI `POST {base_url}/audio/speech` endpoint,
/// including self-hosted ones (Kokoro-FastAPI, openedai-speech, ...).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenAiSettings {
    pub base_url: String,
    pub model: String,
    pub voice: String,
    pub speed: f32,
}

impl Default for OpenAiSettings {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            model: "tts-1".into(),
            voice: "alloy".into(),
            speed: 1.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AzureSettings {
    pub region: String,
    pub voice: String,
    /// Percent relative to normal speed, e.g. -20 or 15.
    pub rate_percent: i32,
}

impl Default for AzureSettings {
    fn default() -> Self {
        Self {
            region: "eastasia".into(),
            voice: "zh-CN-XiaoxiaoNeural".into(),
            rate_percent: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TtsSettings {
    pub provider: TtsProvider,
    pub sapi: SapiSettings,
    pub openai: OpenAiSettings,
    pub azure: AzureSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TtsVoice {
    pub id: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tts_synthesize(text: String, settings: TtsSettings) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio = synthesize(&text, &settings)?;
        let mime = sniff_mime(&audio).unwrap_or("audio/mpeg");
        Ok(format!("data:{};base64,{}", mime, crate::base64_encode(&audio)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tts_list_voices(settings: TtsSettings) -> Result<Vec<TtsVoice>, String> {
    tauri::async_runtime::spawn_blocking(move || match settings.provider {
        TtsProvider::Sapi => sapi::list_voices(),
        TtsProvider::Azure => azure_list_voices(&settings.azure, &require_key(TtsProvider::Azure)?),
        TtsProvider::OpenAi => Ok(OPENAI_VOICES
            .iter()
            .map(|v| TtsVoice { id: v.to_string(), label: v.to_string() })
            .collect()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tts_set_api_key(provider: TtsProvider, key: Option<String>) -> Result<(), String> {
    let name = provider.secret_name().ok_or("该服务商不需要 API Key")?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => crate::secrets::set(name, &k),
        None => crate::secrets::delete(name),
    }
}

#[tauri::command]
pub fn tts_has_api_key(provider: TtsProvider) -> Result<bool, String> {
    match provider.secret_name() {
        Some(name) => Ok(crate::secrets::get(name)?.is_some()),
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

const OPENAI_VOICES: &[&str] = &["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

fn synthesize(text: &str, settings: &TtsSettings) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("请输入要合成的文字".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("文字过长，单次最多 {MAX_TEXT_CHARS} 字"));
    }
    match settings.provider {
        TtsProvider::Sapi => sapi::synthesize(text, &settings.sapi),
        TtsProvider::OpenAi => {
            let key = crate::secrets::get("openai")?;
            let req = openai_request(text, &settings.openai, key.as_deref())?;
            send(req)
        }
        TtsProvider::Azure => {
            let key = require_key(TtsProvider::Azure)?;
            send(azure_request(text, &settings.azure, &key)?)
        }
    }
}

fn require_key(provider: TtsProvider) -> Result<String, String> {
    let name = provider.secret_name().ok_or("该服务商不需要 API Key")?;
    crate::secrets::get(name)?.ok_or_else(|| "尚未配置 API Key，请在 设置 → 语音合成 中填写".into())
}

/// A provider-agnostic description of an HTTP call, kept separate from the
/// transport so request construction can be unit-tested.
#[derive(Debug)]
struct HttpRequest {
    url: String,
    headers: Vec<(&'static str, String)>,
    body: String,
}

fn openai_request(text: &str, s: &OpenAiSettings, key: Option<&str>) -> Result<HttpRequest, String> {
    let base = s.base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("接口地址需以 http:// 或 https:// 开头".into());
    }
    if s.model.trim().is_empty() || s.voice.trim().is_empty() {
        return Err("请填写模型和音色".into());
    }
    let body = serde_json::json!({
        "model": s.model.trim(),
        "input": text,
        "voice": s.voice.trim(),
        "response_format": "wav",
        "speed": s.speed.clamp(0.25, 4.0),
    });
    let mut headers = vec![("Content-Type", "application/json".to_string())];
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        headers.push(("Authorization", format!("Bearer {k}")));
    }
    Ok(HttpRequest { url: format!("{base}/audio/speech"), headers, body: body.to_string() })
}

fn azure_region(s: &AzureSettings) -> Result<&str, String> {
    let region = s.region.trim();
    if region.is_empty() || !region.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Azure 区域格式不正确（例如 eastasia）".into());
    }
    Ok(region)
}

fn azure_request(text: &str, s: &AzureSettings, key: &str) -> Result<HttpRequest, String> {
    let region = azure_region(s)?;
    let voice = s.voice.trim();
    if voice.is_empty() {
        return Err("请填写 Azure 音色名称".into());
    }
    // Voice names look like "zh-CN-XiaoxiaoNeural"; the first two segments are the locale.
    let lang = voice.splitn(3, '-').take(2).collect::<Vec<_>>().join("-");
    let rate = s.rate_percent.clamp(-50, 100);
    let ssml = format!(
        "<speak version='1.0' xml:lang='{lang}' xmlns='http://www.w3.org/2001/10/synthesis'>\
         <voice name='{voice}'><prosody rate='{rate:+}%'>{text}</prosody></voice></speak>",
        lang = xml_escape(&lang),
        voice = xml_escape(voice),
        text = xml_escape(text),
    );
    Ok(HttpRequest {
        url: format!("https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"),
        headers: vec![
            ("Content-Type", "application/ssml+xml".into()),
            ("X-Microsoft-OutputFormat", "riff-24khz-16bit-mono-pcm".into()),
            ("Ocp-Apim-Subscription-Key", key.to_string()),
            ("User-Agent", "VirtualVoice".into()),
        ],
        body: ssml,
    })
}

fn azure_list_voices(s: &AzureSettings, key: &str) -> Result<Vec<TtsVoice>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct AzureVoice {
        short_name: String,
        local_name: Option<String>,
        locale: Option<String>,
    }
    let region = azure_region(s)?;
    let resp = agent()
        .get(&format!("https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list"))
        .set("Ocp-Apim-Subscription-Key", key)
        .call()
        .map_err(describe_error)?;
    let voices: Vec<AzureVoice> = resp.into_json().map_err(|e| e.to_string())?;
    Ok(voices
        .into_iter()
        .map(|v| TtsVoice {
            label: match (&v.local_name, &v.locale) {
                (Some(n), Some(l)) => format!("{n} ({l})"),
                _ => v.short_name.clone(),
            },
            id: v.short_name,
        })
        .collect())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .try_proxy_from_env(true)
        .build()
}

fn send(req: HttpRequest) -> Result<Vec<u8>, String> {
    let mut call = agent().post(&req.url);
    for (k, v) in &req.headers {
        call = call.set(k, v);
    }
    let resp = call.send_string(&req.body).map_err(describe_error)?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_AUDIO_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_AUDIO_BYTES {
        return Err("返回的音频过大".into());
    }
    if sniff_mime(&buf).is_none() {
        return Err("服务商返回的不是可识别的音频数据".into());
    }
    Ok(buf)
}

fn describe_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let snippet: String = body.chars().take(300).collect();
            let hint = match code {
                401 | 403 => "（API Key 无效或无权限）",
                404 => "（接口地址、模型或音色不存在）",
                429 => "（请求过于频繁或额度不足）",
                _ => "",
            };
            format!("服务商返回 {code}{hint}: {snippet}")
        }
        ureq::Error::Transport(t) => format!("网络请求失败: {t}"),
    }
}

fn sniff_mime(data: &[u8]) -> Option<&'static str> {
    match data {
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => Some("audio/wav"),
        [b'I', b'D', b'3', ..] => Some("audio/mpeg"),
        [0xFF, b, ..] if b & 0xE0 == 0xE0 => Some("audio/mpeg"),
        [b'O', b'g', b'g', b'S', ..] => Some("audio/ogg"),
        [b'f', b'L', b'a', b'C', ..] => Some("audio/flac"),
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("audio/mp4"),
        _ => None,
    }
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Windows built-in voices (System.Speech via PowerShell)
// ---------------------------------------------------------------------------

mod sapi {
    use super::{SapiSettings, TtsVoice};

    #[cfg(windows)]
    fn run_powershell(script: &str, envs: &[(&str, &str)]) -> Result<String, String> {
        // -EncodedCommand takes UTF-16LE base64, which avoids any quoting issues.
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
            .arg(crate::base64_encode(&utf16));
        for (k, v) in envs {
            cmd.env(k, v);
        }
        crate::driver::hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("无法启动 PowerShell: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("系统语音合成失败: {}", err.trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[cfg(windows)]
    pub fn list_voices() -> Result<Vec<TtsVoice>, String> {
        let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;\
            Add-Type -AssemblyName System.Speech;\
            $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;\
            $s.GetInstalledVoices()|?{$_.Enabled}|%{$_.VoiceInfo.Name+'|'+$_.VoiceInfo.Culture.Name};\
            $s.Dispose()";
        let out = run_powershell(script, &[])?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let (name, culture) = l.trim().split_once('|')?;
                Some(TtsVoice { id: name.to_string(), label: format!("{name} ({culture})") })
            })
            .collect())
    }

    #[cfg(windows)]
    pub fn synthesize(text: &str, s: &SapiSettings) -> Result<Vec<u8>, String> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("virtualvoice_tts_{nonce}"));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let text_path = dir.join("input.txt");
        let wav_path = dir.join("output.wav");
        let result = (|| {
            std::fs::write(&text_path, text).map_err(|e| e.to_string())?;
            let script = "$ErrorActionPreference='Stop';\
                Add-Type -AssemblyName System.Speech;\
                $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;\
                if($env:VV_TTS_VOICE){$s.SelectVoice($env:VV_TTS_VOICE)};\
                $s.Rate=[int]$env:VV_TTS_RATE;\
                $s.SetOutputToWaveFile($env:VV_TTS_OUT);\
                $s.Speak([IO.File]::ReadAllText($env:VV_TTS_TEXT,[Text.Encoding]::UTF8));\
                $s.Dispose()";
            let rate = s.rate.clamp(-10, 10).to_string();
            run_powershell(
                script,
                &[
                    ("VV_TTS_VOICE", s.voice.as_deref().unwrap_or("")),
                    ("VV_TTS_RATE", &rate),
                    ("VV_TTS_OUT", &wav_path.to_string_lossy()),
                    ("VV_TTS_TEXT", &text_path.to_string_lossy()),
                ],
            )?;
            std::fs::read(&wav_path).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[cfg(not(windows))]
    pub fn list_voices() -> Result<Vec<TtsVoice>, String> {
        Err("系统语音仅支持 Windows".into())
    }

    #[cfg(not(windows))]
    pub fn synthesize(_text: &str, _s: &SapiSettings) -> Result<Vec<u8>, String> {
        Err("系统语音仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_request_targets_speech_endpoint() {
        let s = OpenAiSettings { base_url: "http://localhost:8880/v1/".into(), ..Default::default() };
        let req = openai_request("你好", &s, Some("sk-test")).unwrap();
        assert_eq!(req.url, "http://localhost:8880/v1/audio/speech");
        assert!(req.headers.contains(&("Authorization", "Bearer sk-test".into())));
        let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["input"], "你好");
        assert_eq!(body["response_format"], "wav");
    }

    #[test]
    fn openai_request_without_key_omits_auth() {
        let req = openai_request("hi", &OpenAiSettings::default(), None).unwrap();
        assert!(req.headers.iter().all(|(k, _)| *k != "Authorization"));
    }

    #[test]
    fn openai_rejects_non_http_urls() {
        let s = OpenAiSettings { base_url: "file:///etc".into(), ..Default::default() };
        assert!(openai_request("hi", &s, None).is_err());
    }

    #[test]
    fn azure_request_escapes_text_and_sets_locale() {
        let s = AzureSettings { rate_percent: -10, ..Default::default() };
        let req = azure_request("a<b & 'c'", &s, "k").unwrap();
        assert_eq!(req.url, "https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
        assert!(req.body.contains("xml:lang='zh-CN'"));
        assert!(req.body.contains("rate='-10%'"));
        assert!(req.body.contains("a&lt;b &amp; &apos;c&apos;"));
    }

    #[test]
    fn azure_rejects_bad_region() {
        let s = AzureSettings { region: "evil.com/x".into(), ..Default::default() };
        assert!(azure_request("hi", &s, "k").is_err());
    }

    #[test]
    fn sniff_detects_common_formats() {
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WAVEfmt "), Some("audio/wav"));
        assert_eq!(sniff_mime(b"ID3\x04"), Some("audio/mpeg"));
        assert_eq!(sniff_mime(&[0xFF, 0xF3, 0x00]), Some("audio/mpeg"));
        assert_eq!(sniff_mime(b"{\"error\":1}"), None);
    }

    #[test]
    fn rejects_empty_and_oversized_text() {
        let s = TtsSettings { provider: TtsProvider::OpenAi, ..Default::default() };
        assert!(synthesize("   ", &s).is_err());
        assert!(synthesize(&"字".repeat(MAX_TEXT_CHARS + 1), &s).is_err());
    }

    #[test]
    fn provider_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&TtsProvider::OpenAi).unwrap(), "\"openai\"");
    }
}
