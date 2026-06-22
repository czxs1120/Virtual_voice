use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

mod driver;

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
    pub key_binding: Option<u32>,
    pub path: String,
    pub duration_ms: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct TtsConfig {
    pub api_url: String,
    pub api_key: String,
    pub model: String,
    pub recordings_dir: Option<String>,
    pub enable_monitoring: bool,
    /// Persisted audio output device name (e.g. "VB-Audio Virtual Cable").
    pub output_device: Option<String>,
    /// Persisted audio input device name (microphone).
    pub input_device: Option<String>,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            api_url: String::new(),
            api_key: String::new(),
            model: String::from("tts-1"),
            recordings_dir: None,
            enable_monitoring: false,
            output_device: None,
            input_device: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

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

// A writable base directory for app data. Falls back to the system temp dir
// (instead of ".", which may resolve to a read-only Program Files under the
// installed app) when the local data dir cannot be determined.
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

// ---------------------------------------------------------------------------
// API key obfuscation — prevents accidental plaintext on disk.
// Uses XOR + base64 (non-cryptographic, same crate-less approach as
// the existing codebase).
// ---------------------------------------------------------------------------

fn obfuscate_key(key: &str) -> String {
    let bytes: Vec<u8> = key.bytes().enumerate().map(|(i, b)| b ^ (i as u8)).collect();
    base64_encode(&bytes)
}

fn deobfuscate_key(encoded: &str) -> String {
    let bytes = base64_decode(encoded).unwrap_or_default();
    String::from_utf8(bytes.into_iter().enumerate().map(|(i, b)| b ^ (i as u8)).collect())
        .unwrap_or_default()
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
    let audio_path = dir.join(format!("audio_{}.webm", id));

    // Path traversal guard: resolved path must stay under the recordings directory.
    for p in [&json_path, &audio_path] {
        if p.exists() {
            let canonical = p.canonicalize().map_err(|e| e.to_string())?;
            if !canonical.starts_with(&dir) {
                return Err("Path traversal denied".to_string());
            }
        }
    }

    if json_path.exists() {
        std::fs::remove_file(json_path).map_err(|e| e.to_string())?;
    }
    if audio_path.exists() {
        std::fs::remove_file(audio_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_audio(id: u64, audio_data: String, recordings_dir: Option<String>) -> Result<(), String> {
    let dir = get_recordings_dir(recordings_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("audio_{}.webm", id));
    let b64 = audio_data
        .strip_prefix("data:audio/webm;base64,")
        .unwrap_or(&audio_data);
    let decoded = base64_decode(b64)?;
    std::fs::write(path, decoded).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_audio(id: u64, recordings_dir: Option<String>) -> Result<String, String> {
    let dir = get_recordings_dir(recordings_dir);
    let path = dir.join(format!("audio_{}.webm", id));
    if !path.exists() {
        return Err("Audio file not found".to_string());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(format!("data:audio/webm;base64,{}", base64_encode(&data)))
}

// ---------------------------------------------------------------------------
// Tauri commands — config (API key obfuscated on disk)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_config() -> Result<TtsConfig, String> {
    let config_path = get_config_dir().join("config.json");
    let mut config = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    } else {
        TtsConfig::default()
    };

    // De-obfuscate the stored key.
    if !config.api_key.is_empty() {
        config.api_key = deobfuscate_key(&config.api_key);
    }
    Ok(config)
}

#[tauri::command]
fn save_config(config: TtsConfig) -> Result<(), String> {
    let dir = get_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut file_config = config;
    if !file_config.api_key.is_empty() {
        file_config.api_key = obfuscate_key(&file_config.api_key);
    }

    let path = dir.join("config.json");
    let json = serde_json::to_string_pretty(&file_config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command — TTS (OpenAI-compatible API)
// ---------------------------------------------------------------------------

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
//
// The frontend decodes audio via Web Audio API and sends raw PCM f32 samples
// (base64-encoded) along with sample rate and channel count.
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
    play_audio_bytes(&decoded, sample_rate, channels, device_name, enable_monitoring)
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
    play_audio_bytes(&pcm_bytes, sample_rate, channels, device_name, enable_monitoring)
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
    write_log(&format!("play_audio_to_device called: device={}, sample_rate={}, samples_len={}, monitoring={}", 
        device_name.unwrap_or("default"), sample_rate, samples.len(), enable_monitoring));
    
    let host = cpal::default_host();
    // Device lookup is tolerant across environments:
    //   1) exact match, 2) case-insensitive substring match (handles locale/
    //      renamed devices where the name differs slightly), 3) fall back to
    //      the default output device instead of erroring out — so playback
    //      never hard-fails just because the exact device name changed.
    let device = match device_name {
        Some(name) => {
            let name_lower = name.to_lowercase();
            let mut devices = host.output_devices().map_err(|e| {
                write_log(&format!("ERROR: Failed to enumerate output devices: {}", e));
                e.to_string()
            })?;
            // 1) exact match
            let mut exact = devices.find(|d| d.name().map(|n| n == name).unwrap_or(false));
            // 2) case-insensitive substring match (re-enumerate if exact failed)
            if exact.is_none() {
                let mut devices2 = host.output_devices().map_err(|e| e.to_string())?;
                exact = devices2.find(|d| {
                    d.name()
                        .map(|n| n.to_lowercase().contains(&name_lower))
                        .unwrap_or(false)
                });
            }
            // 3) fall back to default output device
            match exact {
                Some(d) => {
                    write_log(&format!("Device found (exact or substring match): {:?}", d.name()));
                    d
                },
                None => {
                    write_log(&format!("WARN: Device '{}' not found, falling back to default", name));
                    host.default_output_device()
                        .ok_or_else(|| format!("Output device '{}' not found", name))?
                }
            }
        }
        None => host.default_output_device().ok_or("No default output device")?,
    };
    let device_actual_name = device.name().unwrap_or_default();
    write_log(&format!("Using output device: {}", device_actual_name));
    
    let supported = device.default_output_config().map_err(|e| {
        write_log(&format!("ERROR: Failed to get device config: {}", e));
        e.to_string()
    })?;
    let config = supported.config();
    let device_rate = config.sample_rate.0;
    let channels = config.channels as usize;

    // Resample mono PCM to device's native sample rate
    let resampled: Vec<f32> = if device_rate != sample_rate {
        let ratio = device_rate as f64 / sample_rate as f64;
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
    } else {
        samples.to_vec()
    };
    let sample_count = resampled.len();
    let samples = Arc::new(resampled);

    // Per-instance stop flag. A new playback replaces any prior one.
    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut active = active_playback().lock().unwrap();
        if let Some(prev) = active.take() {
            // Signal the previous playback to stop.
            prev.stop_flag.store(true, Ordering::SeqCst);
        }
        *active = Some(ActivePlayback {
            stop_flag: Arc::clone(&stop_flag),
        });
    }

    // Build main output stream: mono samples duplicated to all device channels
    let s1 = Arc::clone(&samples);
    let p1 = Arc::new(AtomicUsize::new(0));
    let main_stop = Arc::clone(&stop_flag);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                if main_stop.load(Ordering::SeqCst) { data.fill(0.0); return; }
                let start = p1.fetch_add(data.len() / channels, Ordering::SeqCst);
                for (fi, frame) in data.chunks_mut(channels).enumerate() {
                    let val = s1.get(start + fi).copied().unwrap_or(0.0);
                    for ch in frame.iter_mut() { *ch = val; }
                }
            },
            |err| log::error!("Audio stream error: {}", err),
            None,
        )
        .map_err(|e| format!("Cannot build output stream: {}", e))?;
    stream.play().map_err(|e| {
        write_log(&format!("ERROR: Failed to play audio stream on device '{}': {}", device_actual_name, e));
        e.to_string()
    })?;
    write_log(&format!("Audio stream started successfully on device '{}'", device_actual_name));

    // Monitor: also play through default speakers (optional)
    let _monitor: Option<cpal::Stream> = if enable_monitoring {
        if let Some(default_dev) = host.default_output_device() {
            if let Ok(mon_cfg) = default_dev.default_output_config() {
                let mc = mon_cfg.config().channels as usize;
                let s2 = Arc::clone(&samples);
                let p2 = Arc::new(AtomicUsize::new(0));
                let mon_stop = Arc::clone(&stop_flag);
                let mon_stream = default_dev.build_output_stream(
                    &mon_cfg.config(),
                    move |data, _| {
                        if mon_stop.load(Ordering::SeqCst) { data.fill(0.0); return; }
                        let start = p2.fetch_add(data.len() / mc, Ordering::SeqCst);
                        for (fi, frame) in data.chunks_mut(mc).enumerate() {
                            let val = s2.get(start + fi).copied().unwrap_or(0.0);
                            for ch in frame.iter_mut() { *ch = val; }
                        }
                    },
                    |err| log::error!("Monitor error: {}", err),
                    None,
                ).ok();
                mon_stream.map(|s: cpal::Stream| { let _ = s.play(); s })
            } else { None }
        } else { None }
    } else { None };

    // Spawn a reaper thread that owns the streams and tears them down when
    // playback finishes or when this instance's stop flag is set. This keeps
    // the command non-blocking and allows stop/switch to take effect at once.
    // cpal::Stream is !Send on paper, but WASAPI streams are Send in practice;
    // the SendStream wrapper (defined above) asserts that.
    let stream = SendStream(stream);
    let _monitor = _monitor.map(SendStream);
    std::thread::spawn(move || {
        let sleep_ms = ((sample_count as u64 * 1000) / (device_rate as u64).max(1)).min(300_000);
        let mut elapsed = 0u64;
        while elapsed < sleep_ms && !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
            elapsed += 50;
        }
        // Dropping the streams stops audio output immediately.
        drop(stream);
        drop(_monitor);
        // Clear the global handle only if it still points at this instance.
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
    if let Ok(mut active) = active_playback().lock() {
        if let Some(cur) = active.take() {
            cur.stop_flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::fs;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64_encode(&bytes))
}

// ---------------------------------------------------------------------------
// Tauri commands — real-time audio transfer (mic → output device)
// ---------------------------------------------------------------------------

#[tauri::command]
fn start_transfer(output_device: Option<String>) -> Result<(), String> {
    write_log(&format!("start_transfer called with output_device: {:?}", output_device));
    
    if TRANSFER_RUNNING.load(Ordering::SeqCst) {
        write_log("Transfer already running, returning error");
        return Err("Transfer is already running".to_string());
    }

    let host = cpal::default_host();

    // Input: default microphone.
    let input_device = host
        .default_input_device()
        .ok_or_else(|| {
            write_log("ERROR: No default input device found");
            "No default input device (microphone) found".to_string()
        })?;
    let input_name = input_device.name().unwrap_or_default();
    write_log(&format!("Input device: {}", input_name));
    
    let input_config = input_device
        .default_input_config()
        .map_err(|e| {
            write_log(&format!("ERROR: Cannot get input config: {}", e));
            format!("Cannot get input config: {}", e)
        })?;

    // Output device - use tolerant matching (same as play_audio_to_device):
    //   1) exact match, 2) case-insensitive substring match, 3) fall back to default
    let output_device = match &output_device {
        Some(name) => {
            let name_lower = name.to_lowercase();
            let mut devices = host.output_devices().map_err(|e| e.to_string())?;
            // 1) exact match
            let mut exact = devices.find(|d| d.name().map(|n| n.as_str() == name.as_str()).unwrap_or(false));
            // 2) case-insensitive substring match (re-enumerate if exact failed)
            if exact.is_none() {
                let mut devices2 = host.output_devices().map_err(|e| e.to_string())?;
                exact = devices2.find(|d| {
                    d.name()
                        .map(|n| n.to_lowercase().contains(&name_lower))
                        .unwrap_or(false)
                });
            }
            // 3) fall back to default output device
            match exact {
                Some(d) => d,
                None => {
                    log::warn!("Output device '{}' not found, falling back to default", name);
                    host.default_output_device()
                        .ok_or_else(|| format!("Output device '{}' not found and no default device available", name))?
                }
            }
        }
        None => host.default_output_device().ok_or_else(|| {
            write_log("ERROR: No default output device available");
            "No default output device".to_string()
        })?,
    };
    let output_name = output_device.name().unwrap_or_default();
    write_log(&format!("Output device selected: {}", output_name));
    
    let output_config = output_device
        .default_output_config()
        .map_err(|e| {
            write_log(&format!("ERROR: Cannot get output config: {}", e));
            format!("Cannot get output config: {}", e)
        })?;

    let _sample_rate = input_config.sample_rate().0.min(output_config.sample_rate().0);
    let _channels = input_config.channels().min(output_config.channels()) as usize;

    // Channel for sample transfer between audio callbacks (try_send / try_recv to avoid blocking).
    let (tx, rx) = std::sync::mpsc::sync_channel::<f32>(16384);

    let running = std::sync::Arc::new(AtomicBool::new(true));
    let inp_run = running.clone();
    let out_run = running.clone();

    // --- Input stream (mic capture) ---
    let inp_tx = tx.clone();
    let input_stream = match input_config.sample_format() {
        cpal::SampleFormat::F32 => input_device
            .build_input_stream(
                &input_config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !inp_run.load(Ordering::SeqCst) {
                        return;
                    }
                    for &s in data {
                        if inp_tx.try_send(s).is_err() {
                            break;
                        }
                    }
                },
                |err| log::error!("Input stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Cannot build input stream: {}", e))?,
        cpal::SampleFormat::I16 => {
            let inp_tx = tx.clone();
            input_device
                .build_input_stream(
                    &input_config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        if !inp_run.load(Ordering::SeqCst) {
                            return;
                        }
                        for &s in data {
                            if inp_tx.try_send(s as f32 / i16::MAX as f32).is_err() {
                                break;
                            }
                        }
                    },
                    |err| log::error!("Input stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build input stream: {}", e))?
        }
        cpal::SampleFormat::U16 => {
            let inp_tx = tx.clone();
            input_device
                .build_input_stream(
                    &input_config.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        if !inp_run.load(Ordering::SeqCst) {
                            return;
                        }
                        for &s in data {
                            let f = (s as f32 / u16::MAX as f32) * 2.0 - 1.0;
                            if inp_tx.try_send(f).is_err() {
                                break;
                            }
                        }
                    },
                    |err| log::error!("Input stream error: {}", err),
                    None,
                )
                .map_err(|e| format!("Cannot build input stream: {}", e))?
        }
        _ => return Err("Unsupported input sample format".to_string()),
    };

    // --- Output stream (playback via selected device) ---
    let output_stream = match output_config.sample_format() {
        cpal::SampleFormat::F32 => output_device
            .build_output_stream(
                &output_config.into(),
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if !out_run.load(Ordering::SeqCst) {
                        data.fill(0.0);
                        return;
                    }
                    for s in data.iter_mut() {
                        *s = rx.try_recv().unwrap_or(0.0);
                    }
                },
                |err| log::error!("Output stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Cannot build output stream: {}", e))?,
        cpal::SampleFormat::I16 => output_device
            .build_output_stream(
                &output_config.into(),
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    if !out_run.load(Ordering::SeqCst) {
                        data.fill(0);
                        return;
                    }
                    for s in data.iter_mut() {
                        let f = rx.try_recv().unwrap_or(0.0);
                        *s = (f * i16::MAX as f32) as i16;
                    }
                },
                |err| log::error!("Output stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Cannot build output stream: {}", e))?,
        cpal::SampleFormat::U16 => output_device
            .build_output_stream(
                &output_config.into(),
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                    if !out_run.load(Ordering::SeqCst) {
                        data.fill(u16::MAX / 2);
                        return;
                    }
                    for s in data.iter_mut() {
                        let f = rx.try_recv().unwrap_or(0.0);
                        *s = ((f + 1.0) / 2.0 * u16::MAX as f32) as u16;
                    }
                },
                |err| log::error!("Output stream error: {}", err),
                None,
            )
            .map_err(|e| format!("Cannot build output stream: {}", e))?,
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

    write_log(&format!("SUCCESS: Audio transfer started ({} → {})", input_name, output_name));
    log::info!("Audio transfer started ({} → {})", input_name, output_name);
    Ok(())
}

#[tauri::command]
fn stop_transfer() -> Result<(), String> {
    if !TRANSFER_RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }
    *transfer_handles().lock().unwrap() = None;
    TRANSFER_RUNNING.store(false, Ordering::SeqCst);
    log::info!("Audio transfer stopped");
    Ok(())
}

#[tauri::command]
fn is_transfer_running() -> Result<bool, String> {
    Ok(TRANSFER_RUNNING.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Base64 helpers (manual implementation, kept for zero extra dependencies)
// ---------------------------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = if i + 1 < data.len() { data[i + 1] as usize } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as usize } else { 0 };

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
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1, -1, 63,
        52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1,
        -1,  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14,
        15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1, -1,
        -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
        41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
    ];

    // Strip data:-URL prefix if present.
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
        let val = if c.is_ascii() { DECODE_TABLE[c as usize] } else { -1 };
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
// Simple file logger for debugging production issues
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
        let timestamp = chrono_timestamp();
        let _ = file.write_all(format!("[{}] {}\n", timestamp, msg).as_bytes());
    }
}

fn chrono_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize env_logger (for console output in dev mode)
    env_logger::init();
    
    // Write startup log to file
    write_log("Virtual Voice application starting");
    write_log(&format!("Log file location: {}", get_log_file_path().display()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            driver::is_vbcable_installed,
            driver::install_vbcable_driver,
            driver::uninstall_vbcable_driver,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
