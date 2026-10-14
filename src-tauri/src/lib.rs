use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

mod driver;
mod dsp;
mod secrets;
mod tray;
mod tts;

// ---------------------------------------------------------------------------
// cpal::Stream is !Send on Windows due to a conservative PhantomData marker.
// WASAPI streams are actually Send, so we safely assert that here.
// ---------------------------------------------------------------------------

#[allow(dead_code)]
struct SendStream(cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub key_binding: Option<u32>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub duration_ms: u32,
    #[serde(default)]
    pub group: Option<String>,
    /// Tauri accelerator string, e.g. "CommandOrControl+1" or "F5".
    #[serde(default)]
    pub hotkey: Option<String>,
}

/// Application settings persisted to disk.
/// Renamed from the legacy TTS-oriented config; unknown old fields are ignored.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub recordings_dir: Option<String>,
    pub enable_monitoring: bool,
    /// Persisted audio output device name (e.g. "VB-Audio Virtual Cable").
    pub output_device: Option<String>,
    /// Persisted audio input device name (microphone).
    pub input_device: Option<String>,
    pub playback_volume: f32,
    pub dsp: dsp::DspSettings,
    pub scenes: Vec<Scene>,
    pub active_scene: Option<String>,
    /// Provider settings only; API keys are kept in `secrets`, never here.
    pub tts: tts::TtsSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            recordings_dir: None,
            enable_monitoring: true,
            output_device: None,
            input_device: None,
            playback_volume: 1.0,
            dsp: dsp::DspSettings::default(),
            scenes: Vec::new(),
            active_scene: None,
            tts: tts::TtsSettings::default(),
        }
    }
}

/// A named preset of devices and audio settings, e.g. "客服" or "会议".
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub enable_monitoring: bool,
    pub playback_volume: f32,
    pub dsp: dsp::DspSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

const AUDIO_EXTENSIONS: &[&str] = &["webm", "wav", "mp3", "ogg", "flac", "aac", "m4a"];

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/// Flag for live microphone-to-output audio transfer.
static TRANSFER_RUNNING: AtomicBool = AtomicBool::new(false);

struct TransferHandles {
    _input_stream: SendStream,
    _output_stream: SendStream,
}

fn transfer_handles() -> &'static Mutex<Option<TransferHandles>> {
    static INSTANCE: OnceLock<Mutex<Option<TransferHandles>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(None))
}

/// Currently-playing audio stream and its per-instance stop flag.
struct ActivePlayback {
    stop_flag: Arc<AtomicBool>,
}

fn active_playback() -> &'static Mutex<Option<ActivePlayback>> {
    static INSTANCE: OnceLock<Mutex<Option<ActivePlayback>>> = OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn app_data_base_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir)
}

fn get_recordings_dir(recordings_dir: Option<String>) -> PathBuf {
    if let Some(dir) = recordings_dir {
        let p = PathBuf::from(&dir);
        if p.exists() {
            p.canonicalize().unwrap_or(p)
        } else {
            p
        }
    } else {
        app_data_base_dir().join("VirtualVoice").join("recordings")
    }
}

fn get_config_dir() -> PathBuf {
    app_data_base_dir().join("VirtualVoice").join("config")
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" | "m4a" => "audio/mp4",
        _ => "audio/webm",
    }
}

fn ext_from_data_url(audio_data: &str) -> (&str, &str) {
    // Returns (extension, base64 payload)
    if let Some(rest) = audio_data.strip_prefix("data:") {
        if let Some((meta, payload)) = rest.split_once(',') {
            let mime = meta.split(';').next().unwrap_or("audio/webm");
            let ext = match mime {
                "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
                "audio/mpeg" | "audio/mp3" => "mp3",
                "audio/ogg" => "ogg",
                "audio/flac" => "flac",
                "audio/aac" => "aac",
                "audio/mp4" | "audio/m4a" => "m4a",
                _ => "webm",
            };
            return (ext, payload);
        }
    }
    ("webm", audio_data)
}

fn find_audio_file(dir: &Path, id: u64) -> Option<(PathBuf, &'static str)> {
    for ext in AUDIO_EXTENSIONS {
        let path = dir.join(format!("audio_{}.{}", id, ext));
        if path.exists() {
            return Some((path, mime_for_ext(ext)));
        }
    }
    None
}

fn remove_audio_files(dir: &Path, id: u64) -> Result<(), String> {
    let dir_canon = if dir.exists() {
        dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
    } else {
        dir.to_path_buf()
    };
    for ext in AUDIO_EXTENSIONS {
        let path = dir.join(format!("audio_{}.{}", id, ext));
        if path.exists() {
            let canonical = path.canonicalize().map_err(|e| e.to_string())?;
            if !canonical.starts_with(&dir_canon) {
                return Err("Path traversal denied".to_string());
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_named_device(
    devices: impl Iterator<Item = cpal::Device>,
    name: &str,
) -> Option<cpal::Device> {
    let name_lower = name.to_lowercase();
    let list: Vec<_> = devices.collect();
    list.iter()
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
        .cloned()
        .or_else(|| {
            list.into_iter().find(|d| {
                d.name()
                    .map(|n| n.to_lowercase().contains(&name_lower))
                    .unwrap_or(false)
            })
        })
}

fn resolve_output_device(
    host: &cpal::Host,
    device_name: Option<&str>,
) -> Result<cpal::Device, String> {
    match device_name {
        Some(name) => {
            let devices = host.output_devices().map_err(|e| e.to_string())?;
            match find_named_device(devices, name) {
                Some(d) => Ok(d),
                None => {
                    write_log(&format!(
                        "WARN: Output device '{}' not found, falling back to default",
                        name
                    ));
                    host.default_output_device()
                        .ok_or_else(|| format!("Output device '{}' not found", name))
                }
            }
        }
        None => host
            .default_output_device()
            .ok_or_else(|| "No default output device".to_string()),
    }
}

fn resolve_input_device(
    host: &cpal::Host,
    device_name: Option<&str>,
) -> Result<cpal::Device, String> {
    match device_name {
        Some(name) => {
            let devices = host.input_devices().map_err(|e| e.to_string())?;
            match find_named_device(devices, name) {
                Some(d) => Ok(d),
                None => {
                    write_log(&format!(
                        "WARN: Input device '{}' not found, falling back to default",
                        name
                    ));
                    host.default_input_device()
                        .ok_or_else(|| format!("Input device '{}' not found", name))
                }
            }
        }
        None => host
            .default_input_device()
            .ok_or_else(|| "No default input device (microphone) found".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — recordings CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_recordings(recordings_dir: Option<String>) -> Result<Vec<Recording>, String> {
    let dir = get_recordings_dir(recordings_dir);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut recordings = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(rec) = serde_json::from_str::<Recording>(&content) {
                        recordings.push(rec);
                    }
                }
            }
        }
    }
    Ok(recordings)
}

#[tauri::command]
fn save_recording(recording: Recording, recordings_dir: Option<String>) -> Result<(), String> {
    let dir = get_recordings_dir(recordings_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("recording_{}.json", recording.id));
    let json = serde_json::to_string_pretty(&recording).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_recording(id: u64, recordings_dir: Option<String>) -> Result<(), String> {
    let dir = get_recordings_dir(recordings_dir);
    let json_path = dir.join(format!("recording_{}.json", id));

    if json_path.exists() {
        let canonical = json_path.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&dir) {
            return Err("Path traversal denied".to_string());
        }
        std::fs::remove_file(json_path).map_err(|e| e.to_string())?;
    }
    remove_audio_files(&dir, id)?;
    Ok(())
}

#[tauri::command]
fn save_audio(id: u64, audio_data: String, recordings_dir: Option<String>) -> Result<(), String> {
    let dir = get_recordings_dir(recordings_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (ext, b64) = ext_from_data_url(&audio_data);
    // Replace any previous format for this id so we don't leave orphans.
    let _ = remove_audio_files(&dir, id);
    let path = dir.join(format!("audio_{}.{}", id, ext));
    let decoded = base64_decode(b64)?;
    std::fs::write(path, decoded).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_audio(id: u64, recordings_dir: Option<String>) -> Result<String, String> {
    let dir = get_recordings_dir(recordings_dir);
    let (path, mime) = find_audio_file(&dir, id).ok_or_else(|| "Audio file not found".to_string())?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(format!("data:{};base64,{}", mime, base64_encode(&data)))
}

// ---------------------------------------------------------------------------
// Tauri commands — config
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    let config_path = get_config_dir().join("config.json");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    } else {
        Ok(AppConfig::default())
    }
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    let dir = get_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — audio devices
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    let devices = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .map(|name| AudioDevice {
            name: name.clone(),
            is_default: Some(&name) == default.as_ref(),
        })
        .collect();
    Ok(devices)
}

#[tauri::command]
fn get_default_audio_device() -> Result<Option<String>, String> {
    let host = cpal::default_host();
    Ok(host.default_output_device().and_then(|d| d.name().ok()))
}

#[tauri::command]
fn get_audio_input_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let devices = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .map(|name| AudioDevice {
            name: name.clone(),
            is_default: Some(&name) == default.as_ref(),
        })
        .collect();
    Ok(devices)
}

// ---------------------------------------------------------------------------
// Tauri commands — audio playback
// ---------------------------------------------------------------------------

#[tauri::command]
fn play_audio(
    pcm_samples_b64: String,
    sample_rate: u32,
    channels: u16,
    device_name: Option<String>,
    enable_monitoring: bool,
) -> Result<(), String> {
    let decoded = base64_decode(&pcm_samples_b64)?;
    play_audio_bytes(
        &decoded,
        sample_rate,
        channels,
        device_name,
        enable_monitoring,
    )
}

#[tauri::command]
fn play_audio_raw(
    _app_handle: tauri::AppHandle,
    pcm_bytes: Vec<u8>,
    sample_rate: u32,
    channels: u16,
    device_name: Option<String>,
    enable_monitoring: bool,
) -> Result<(), String> {
    play_audio_bytes(
        &pcm_bytes,
        sample_rate,
        channels,
        device_name,
        enable_monitoring,
    )
}

fn play_audio_bytes(
    pcm_bytes: &[u8],
    sample_rate: u32,
    channels: u16,
    device_name: Option<String>,
    enable_monitoring: bool,
) -> Result<(), String> {
    if pcm_bytes.len() % 4 != 0 {
        return Err("PCM data length must be a multiple of 4 (f32 = 4 bytes)".to_string());
    }

    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    if samples.is_empty() {
        return Err("No PCM samples received".to_string());
    }

    play_audio_to_device(
        &samples,
        sample_rate,
        channels as usize,
        device_name.as_deref(),
        enable_monitoring,
    )
}

fn play_audio_to_device(
    samples: &[f32],
    sample_rate: u32,
    _channels: usize,
    device_name: Option<&str>,
    enable_monitoring: bool,
) -> Result<(), String> {
    write_log(&format!(
        "play_audio_to_device called: device={}, sample_rate={}, samples_len={}, monitoring={}",
        device_name.unwrap_or("default"),
        sample_rate,
        samples.len(),
        enable_monitoring
    ));

    let host = cpal::default_host();
    let device = resolve_output_device(&host, device_name)?;
    let device_actual_name = device.name().unwrap_or_default();
    write_log(&format!("Using output device: {}", device_actual_name));

    let supported = device.default_output_config().map_err(|e| {
        write_log(&format!("ERROR: Failed to get device config: {}", e));
        e.to_string()
    })?;
    let config = supported.config();
    let device_rate = config.sample_rate.0;
    let channels = config.channels as usize;

    let resampled: Vec<f32> = if device_rate != sample_rate {
        linear_resample(samples, sample_rate, device_rate)
    } else {
        samples.to_vec()
    };
    let sample_count = resampled.len();
    let samples = Arc::new(resampled);

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut active = active_playback().lock().unwrap();
        if let Some(prev) = active.take() {
            prev.stop_flag.store(true, Ordering::SeqCst);
        }
        *active = Some(ActivePlayback {
            stop_flag: Arc::clone(&stop_flag),
        });
    }

    let s1 = Arc::clone(&samples);
    let p1 = Arc::new(AtomicUsize::new(0));
    let main_stop = Arc::clone(&stop_flag);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                if main_stop.load(Ordering::SeqCst) {
                    data.fill(0.0);
                    return;
                }
                let start = p1.fetch_add(data.len() / channels, Ordering::SeqCst);
                for (fi, frame) in data.chunks_mut(channels).enumerate() {
                    let val = s1.get(start + fi).copied().unwrap_or(0.0);
                    for ch in frame.iter_mut() {
                        *ch = val;
                    }
                }
            },
            |err| log::error!("Audio stream error: {}", err),
            None,
        )
        .map_err(|e| format!("Cannot build output stream: {}", e))?;
    stream.play().map_err(|e| {
        write_log(&format!(
            "ERROR: Failed to play audio stream on device '{}': {}",
            device_actual_name, e
        ));
        e.to_string()
    })?;
    write_log(&format!(
        "Audio stream started successfully on device '{}'",
        device_actual_name
    ));

    let _monitor: Option<cpal::Stream> = if enable_monitoring {
        if let Some(default_dev) = host.default_output_device() {
            let same = default_dev
                .name()
                .map(|n| n == device_actual_name)
                .unwrap_or(false);
            if !same {
                if let Ok(mon_cfg) = default_dev.default_output_config() {
                    let mc = mon_cfg.config().channels as usize;
                    let s2 = Arc::clone(&samples);
                    let p2 = Arc::new(AtomicUsize::new(0));
                    let mon_stop = Arc::clone(&stop_flag);
                    let mon_stream = default_dev
                        .build_output_stream(
                            &mon_cfg.config(),
                            move |data, _| {
                                if mon_stop.load(Ordering::SeqCst) {
                                    data.fill(0.0);
                                    return;
                                }
                                let start = p2.fetch_add(data.len() / mc, Ordering::SeqCst);
                                for (fi, frame) in data.chunks_mut(mc).enumerate() {
                                    let val = s2.get(start + fi).copied().unwrap_or(0.0);
                                    for ch in frame.iter_mut() {
                                        *ch = val;
                                    }
                                }
                            },
                            |err| log::error!("Monitor error: {}", err),
                            None,
                        )
                        .ok();
                    mon_stream.map(|s: cpal::Stream| {
                        let _ = s.play();
                        s
                    })
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let stream = SendStream(stream);
    let _monitor = _monitor.map(SendStream);
    std::thread::spawn(move || {
        let sleep_ms = ((sample_count as u64 * 1000) / (device_rate as u64).max(1)).min(300_000);
        let mut elapsed = 0u64;
        while elapsed < sleep_ms && !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            elapsed += 50;
        }
        drop(stream);
        drop(_monitor);
        if let Ok(mut active) = active_playback().lock() {
            if let Some(cur) = active.as_ref() {
                if Arc::ptr_eq(&cur.stop_flag, &stop_flag) {
                    *active = None;
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_audio() -> Result<(), String> {
    stop_playback_backend();
    Ok(())
}

pub(crate) fn stop_playback_backend() {
    if let Ok(mut active) = active_playback().lock() {
        if let Some(cur) = active.take() {
            cur.stop_flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Read an audio file chosen by the user for import.
/// Restricted to known audio extensions to avoid arbitrary filesystem reads.
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::fs;
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        return Err("仅允许导入音频文件".to_string());
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("读取文件失败: {}", e))?;
    if !canonical.is_file() {
        return Err("路径不是有效文件".to_string());
    }
    let bytes = fs::read(&canonical).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64_encode(&bytes))
}

// ---------------------------------------------------------------------------
// Real-time audio transfer (mic → output device) with mono + resampling
// ---------------------------------------------------------------------------

fn linear_resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if samples.is_empty() || from_rate == 0 || to_rate == 0 || from_rate == to_rate {
        return samples.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let new_len = ((samples.len() as f64) * ratio).ceil() as usize;
    let mut out = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src = i as f64 / ratio;
        let lo = src.floor() as usize;
        let hi = (lo + 1).min(samples.len() - 1);
        let frac = (src - lo as f64) as f32;
        out.push(samples[lo] * (1.0 - frac) + samples[hi] * frac);
    }
    out
}

#[tauri::command]
fn start_transfer(
    output_device: Option<String>,
    input_device: Option<String>,
    dsp: Option<dsp::DspSettings>,
) -> Result<(), String> {
    if let Some(settings) = &dsp {
        dsp::apply_settings(settings);
    }
    write_log(&format!(
        "start_transfer called with output_device: {:?}, input_device: {:?}",
        output_device, input_device
    ));

    if TRANSFER_RUNNING.load(Ordering::SeqCst) {
        write_log("Transfer already running, returning error");
        return Err("Transfer is already running".to_string());
    }

    let host = cpal::default_host();
    let input_dev = resolve_input_device(&host, input_device.as_deref())?;
    let input_name = input_dev.name().unwrap_or_default();
    write_log(&format!("Input device: {}", input_name));

    let input_config = input_dev.default_input_config().map_err(|e| {
        write_log(&format!("ERROR: Cannot get input config: {}", e));
        format!("Cannot get input config: {}", e)
    })?;

    let output_dev = resolve_output_device(&host, output_device.as_deref())?;
    let output_name = output_dev.name().unwrap_or_default();
    write_log(&format!("Output device selected: {}", output_name));

    let output_config = output_dev.default_output_config().map_err(|e| {
        write_log(&format!("ERROR: Cannot get output config: {}", e));
        format!("Cannot get output config: {}", e)
    })?;

    let in_rate = input_config.sample_rate().0;
    let out_rate = output_config.sample_rate().0;
    let in_channels = input_config.channels() as usize;
    let out_channels = output_config.channels() as usize;
    let resample_ratio = out_rate as f64 / in_rate as f64;

    // Bounded queue of mono frames at the *output* sample rate.
    let (tx, rx) = std::sync::mpsc::sync_channel::<f32>(32768);

    let running = Arc::new(AtomicBool::new(true));
    let inp_run = running.clone();
    let out_run = running.clone();

    // Shared fractional resampler state between input callbacks.
    let state = Arc::new(Mutex::new(InputState {
        phase: 0.0,
        dsp: dsp::Processor::new(in_rate),
    }));

    let input_stream = match input_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let cfg = input_config.clone().into();
            let tx = tx.clone();
            let state = Arc::clone(&state);
            let inp_run = Arc::clone(&inp_run);
            input_dev
                .build_input_stream(
                    &cfg,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !inp_run.load(Ordering::SeqCst) {
                            return;
                        }
                        push_resampled_mono(data, in_channels, resample_ratio, &state, &tx);
                    },
                    |err| log::error!("Input stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build input stream: {}", e))?
        }
        cpal::SampleFormat::I16 => {
            let cfg = input_config.clone().into();
            let tx = tx.clone();
            let state = Arc::clone(&state);
            let inp_run = Arc::clone(&inp_run);
            input_dev
                .build_input_stream(
                    &cfg,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if !inp_run.load(Ordering::SeqCst) {
                            return;
                        }
                        let f: Vec<f32> =
                            data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                        push_resampled_mono(&f, in_channels, resample_ratio, &state, &tx);
                    },
                    |err| log::error!("Input stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build input stream: {}", e))?
        }
        cpal::SampleFormat::U16 => {
            let cfg = input_config.clone().into();
            let tx = tx.clone();
            let state = Arc::clone(&state);
            let inp_run = Arc::clone(&inp_run);
            input_dev
                .build_input_stream(
                    &cfg,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        if !inp_run.load(Ordering::SeqCst) {
                            return;
                        }
                        let f: Vec<f32> = data
                            .iter()
                            .map(|&s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                            .collect();
                        push_resampled_mono(&f, in_channels, resample_ratio, &state, &tx);
                    },
                    |err| log::error!("Input stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build input stream: {}", e))?
        }
        _ => return Err("Unsupported input sample format".to_string()),
    };

    let output_stream = match output_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let cfg = output_config.clone().into();
            output_dev
                .build_output_stream(
                    &cfg,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        if !out_run.load(Ordering::SeqCst) {
                            data.fill(0.0);
                            return;
                        }
                        for frame in data.chunks_mut(out_channels) {
                            let sample = rx.try_recv().unwrap_or(0.0);
                            for ch in frame.iter_mut() {
                                *ch = sample;
                            }
                        }
                    },
                    |err| log::error!("Output stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build output stream: {}", e))?
        }
        cpal::SampleFormat::I16 => {
            let cfg = output_config.clone().into();
            output_dev
                .build_output_stream(
                    &cfg,
                    move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                        if !out_run.load(Ordering::SeqCst) {
                            data.fill(0);
                            return;
                        }
                        for frame in data.chunks_mut(out_channels) {
                            let f = rx.try_recv().unwrap_or(0.0);
                            let s = (f * i16::MAX as f32) as i16;
                            for ch in frame.iter_mut() {
                                *ch = s;
                            }
                        }
                    },
                    |err| log::error!("Output stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build output stream: {}", e))?
        }
        cpal::SampleFormat::U16 => {
            let cfg = output_config.clone().into();
            output_dev
                .build_output_stream(
                    &cfg,
                    move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                        if !out_run.load(Ordering::SeqCst) {
                            data.fill(u16::MAX / 2);
                            return;
                        }
                        for frame in data.chunks_mut(out_channels) {
                            let f = rx.try_recv().unwrap_or(0.0);
                            let s = ((f + 1.0) / 2.0 * u16::MAX as f32) as u16;
                            for ch in frame.iter_mut() {
                                *ch = s;
                            }
                        }
                    },
                    |err| log::error!("Output stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build output stream: {}", e))?
        }
        _ => return Err("Unsupported output sample format".to_string()),
    };

    input_stream.play().map_err(|e| {
        write_log(&format!("ERROR: Failed to start input stream: {}", e));
        e.to_string()
    })?;
    output_stream.play().map_err(|e| {
        write_log(&format!("ERROR: Failed to start output stream: {}", e));
        e.to_string()
    })?;

    *transfer_handles().lock().unwrap() = Some(TransferHandles {
        _input_stream: SendStream(input_stream),
        _output_stream: SendStream(output_stream),
    });
    TRANSFER_RUNNING.store(true, Ordering::SeqCst);

    write_log(&format!(
        "SUCCESS: Audio transfer started ({} @{}Hz → {} @{}Hz)",
        input_name, in_rate, output_name, out_rate
    ));
    log::info!(
        "Audio transfer started ({} → {})",
        input_name, output_name
    );
    Ok(())
}

/// Input-callback state: resampler phase plus the DSP chain.
struct InputState {
    phase: f64,
    dsp: dsp::Processor,
}

/// Downmix to mono, run the DSP chain, then resample and push toward `tx`.
fn push_resampled_mono(
    interleaved: &[f32],
    in_channels: usize,
    resample_ratio: f64,
    state: &Mutex<InputState>,
    tx: &std::sync::mpsc::SyncSender<f32>,
) {
    let ch = in_channels.max(1);
    let mut mono = Vec::with_capacity(interleaved.len() / ch + 1);
    for frame in interleaved.chunks(ch) {
        let sum: f32 = frame.iter().copied().sum();
        mono.push(sum / frame.len() as f32);
    }
    if mono.is_empty() {
        return;
    }

    // Only the input callback locks this, so it is uncontended.
    let mut st = state.lock().unwrap();
    st.dsp.process(&mut mono);

    // ratio = out_rate / in_rate → how many output samples per input sample.
    if (resample_ratio - 1.0).abs() < f64::EPSILON {
        for s in mono {
            if tx.try_send(s).is_err() {
                break;
            }
        }
        return;
    }

    let mut idx = st.phase;
    while idx < mono.len() as f64 {
        let lo = idx.floor() as usize;
        let hi = (lo + 1).min(mono.len() - 1);
        let frac = (idx - lo as f64) as f32;
        let sample = mono[lo] * (1.0 - frac) + mono[hi] * frac;
        if tx.try_send(sample).is_err() {
            break;
        }
        idx += 1.0 / resample_ratio;
    }
    st.phase = idx - mono.len() as f64;
}

#[tauri::command]
fn set_transfer_dsp(settings: dsp::DspSettings) -> Result<(), String> {
    dsp::apply_settings(&settings);
    Ok(())
}

#[tauri::command]
fn get_transfer_levels() -> Result<dsp::Levels, String> {
    Ok(dsp::take_levels())
}

#[tauri::command]
fn stop_transfer() -> Result<(), String> {
    stop_transfer_backend();
    Ok(())
}

pub(crate) fn stop_transfer_backend() {
    if !TRANSFER_RUNNING.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut handles) = transfer_handles().lock() {
        *handles = None;
    }
    TRANSFER_RUNNING.store(false, Ordering::SeqCst);
    log::info!("Audio transfer stopped");
}

#[tauri::command]
fn is_transfer_running() -> Result<bool, String> {
    Ok(TRANSFER_RUNNING.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as usize
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as usize
        } else {
            0
        };

        result.push(ALPHABET[b0 >> 2] as char);
        result.push(ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] as char);

        if i + 1 < data.len() {
            result.push(ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            result.push('=');
        }

        if i + 2 < data.len() {
            result.push(ALPHABET[b2 & 0x3f] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }
    result
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const DECODE_TABLE: [i8; 128] = [
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1,
        -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4, 5,
        6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1,
        -1, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46,
        47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
    ];

    let input = if let Some(comma_pos) = input.find(',') {
        &input[comma_pos + 1..]
    } else {
        input
    };

    let input = input.trim_end_matches('=');
    let mut result = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in input.chars() {
        let val = if c.is_ascii() {
            DECODE_TABLE[c as usize]
        } else {
            -1
        };
        if val < 0 {
            return Err("Invalid base64 character".to_string());
        }
        buffer = (buffer << 6) | (val as u32);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Simple file logger
// ---------------------------------------------------------------------------

use std::io::Write;

fn get_log_file_path() -> PathBuf {
    app_data_base_dir().join("VirtualVoice").join("debug.log")
}

fn write_log(msg: &str) {
    let path = get_log_file_path();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let _ = file.write_all(format!("[{}] {}\n", timestamp, msg).as_bytes());
    }
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    write_log("Virtual Voice application starting");
    write_log(&format!(
        "Log file location: {}",
        get_log_file_path().display()
    ));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());

    // Global shortcuts are Windows-only in this project (see Cargo.toml).
    #[cfg(windows)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .setup(|app| {
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(tray::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            get_recordings,
            save_recording,
            delete_recording,
            save_audio,
            get_audio,
            get_config,
            save_config,
            get_audio_devices,
            get_default_audio_device,
            get_audio_input_devices,
            play_audio,
            play_audio_raw,
            stop_audio,
            read_file_base64,
            start_transfer,
            stop_transfer,
            is_transfer_running,
            set_transfer_dsp,
            get_transfer_levels,
            tts::tts_synthesize,
            tts::tts_list_voices,
            tts::tts_set_api_key,
            tts::tts_has_api_key,
            driver::is_vbcable_installed,
            driver::install_vbcable_driver,
            driver::uninstall_vbcable_driver,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_loads_with_defaults() {
        let cfg: AppConfig =
            serde_json::from_str(r#"{"recordings_dir":null,"enable_monitoring":false,"tts_voice":"x"}"#)
                .unwrap();
        assert!(!cfg.enable_monitoring);
        assert_eq!(cfg.playback_volume, 1.0);
        assert!(cfg.scenes.is_empty());
        assert!(cfg.dsp.limiter_enabled);
    }

    #[test]
    fn scenes_round_trip() {
        let mut cfg = AppConfig::default();
        cfg.scenes.push(Scene {
            id: "s1".into(),
            name: "会议".into(),
            input_device: Some("Mic".into()),
            output_device: Some("CABLE Input".into()),
            enable_monitoring: false,
            playback_volume: 0.5,
            dsp: dsp::DspSettings { gain_db: 6.0, gate_enabled: true, ..Default::default() },
        });
        cfg.active_scene = Some("s1".into());
        let back: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(back.scenes.len(), 1);
        assert_eq!(back.scenes[0].output_device.as_deref(), Some("CABLE Input"));
        assert_eq!(back.scenes[0].dsp.gain_db, 6.0);
        assert!(back.scenes[0].dsp.gate_enabled);
        assert_eq!(back.active_scene.as_deref(), Some("s1"));
    }

    #[test]
    fn base64_round_trip() {
        for data in [&b""[..], b"a", b"ab", b"abc", b"hello world \x00\xff"] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
    }

    #[test]
    fn data_url_extension_detection() {
        assert_eq!(ext_from_data_url("data:audio/wav;base64,AAAA"), ("wav", "AAAA"));
        assert_eq!(ext_from_data_url("data:audio/mpeg;base64,BB"), ("mp3", "BB"));
        assert_eq!(ext_from_data_url("data:audio/webm;codecs=opus;base64,CC"), ("webm", "CC"));
        assert_eq!(ext_from_data_url("RAW"), ("webm", "RAW"));
    }

    #[test]
    fn linear_resample_scales_length() {
        let src: Vec<f32> = (0..480).map(|i| i as f32 / 480.0).collect();
        let up = linear_resample(&src, 48_000, 96_000);
        assert_eq!(up.len(), 960);
        let down = linear_resample(&src, 48_000, 24_000);
        assert_eq!(down.len(), 240);
        assert!((down[120] - src[240]).abs() < 1e-3);
    }

    #[test]
    fn transfer_path_downmixes_and_resamples() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<f32>(10_000);
        let state = Mutex::new(InputState {
            phase: 0.0,
            dsp: dsp::Processor::new(48_000),
        });
        dsp::apply_settings(&dsp::DspSettings {
            limiter_enabled: false,
            ..Default::default()
        });
        // Stereo frames (L=0.2, R=0.4) → mono 0.3, 48k → 24k halves the count.
        let stereo: Vec<f32> = (0..2_000).flat_map(|_| [0.2f32, 0.4f32]).collect();
        push_resampled_mono(&stereo, 2, 0.5, &state, &tx);
        let out: Vec<f32> = rx.try_iter().collect();
        assert_eq!(out.len(), 1_000);
        assert!(out.iter().all(|s| (s - 0.3).abs() < 1e-5));
    }
}
