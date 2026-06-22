import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

interface Recording {
  id: number;
  name: string;
  key_binding: number | null;
  path: string;
  duration_ms: number;
}

interface TtsConfig {
  api_url: string;
  api_key: string;
  model: string;
  recordings_dir: string | null;
  enable_monitoring: boolean;
  output_device: string | null;
  input_device: string | null;
}

interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

type DriverStatus = "Installed" | "NotInstalled" | "Unknown";

// Minimal global audio state

function App() {
  // ---- State ----
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"storage" | "audio">("storage");
  const [config, setConfig] = useState<TtsConfig>({
    api_url: "",
    api_key: "",
    model: "",
    recordings_dir: null,
    enable_monitoring: false,
    output_device: null,
    input_device: null,
  });
  const [newRecordingName, setNewRecordingName] = useState("");
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedOutputDevice, setSelectedOutputDevice] = useState("");
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [selectedInputDevice, setSelectedInputDevice] = useState("");
  const [inputDeviceIdMap, setInputDeviceIdMap] = useState<Record<string, string>>({});
  const [driverStatus, setDriverStatus] = useState<DriverStatus>("Unknown");
  const [isCompactMode, setIsCompactMode] = useState(false);
  const [currentlyPlayingId, setCurrentlyPlayingId] = useState<number | null>(null);
  const [playbackVolume, setPlaybackVolume] = useState(1.0);
  const playbackVolumeRef = useRef(1.0);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  // ---- Refs ----
  const compactTransitionRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const configRef = useRef<TtsConfig>(config);
  const recordingsRef = useRef<Recording[]>(recordings);
  const playRecordingRef = useRef<Function>(() => {});
  const recordingStartTimeRef = useRef(0);

  // Keep refs in sync with state
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    recordingsRef.current = recordings;
  }, [recordings]);

  // ---- Status messages ----
  let statusTimeout: ReturnType<typeof setTimeout> | null = null;
  const showStatus = (msg: string, duration = 2000) => {
    setStatusMessage(msg);
    if (statusTimeout) clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => setStatusMessage(""), duration);
  };

  // ---- Compact mode toggle ----
  const toggleCompactMode = async () => {
    if (compactTransitionRef.current) return;
    compactTransitionRef.current = true;
    const appWindow = getCurrentWindow();
    const nextCompact = !isCompactMode;
    try {
      if (nextCompact) {
        await appWindow.setSize(new LogicalSize(600, 70));
        await appWindow.setMinSize(new LogicalSize(600, 70));
        await appWindow.setAlwaysOnTop(true);
        await appWindow.setResizable(false);
      } else {
        await appWindow.setSize(new LogicalSize(1000, 700));
        await appWindow.setMinSize(new LogicalSize(400, 100));
        await appWindow.setAlwaysOnTop(false);
        await appWindow.setResizable(true);
        await appWindow.center();
      }
      setIsCompactMode(nextCompact);
    } catch (e) {
      console.error("Failed to resize window:", e);
    }
    compactTransitionRef.current = false;
  };

  // ---- Load recordings ----
  const loadRecordings = useCallback(async () => {
    try {
      const list = await invoke<Recording[]>("get_recordings", {
        recordingsDir: configRef.current.recordings_dir || null,
      });
      setRecordings(list);
    } catch (e) {
      console.error("Failed to load recordings:", e);
    }
  }, []);

  // ---- Play recording ----
  // Use AudioBufferSourceNode (not <audio> + createMediaElementSource) because
  // source.stop() halts audio immediately and reliably, while MediaElementSource
  // playback cannot be stopped reliably inside WebView2.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const currentGainRef = useRef<GainNode | null>(null);
  const bufferCacheRef = useRef<Map<number, AudioBuffer>>(new Map());
  const activeIdRef = useRef<number | null>(null);
  const playTokenRef = useRef(0);

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  const stopPlayback = () => {
    playTokenRef.current++; // invalidate any pending doPlay
    const src = currentSourceRef.current;
    if (src) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch (_) {}
      currentSourceRef.current = null;
    }
    if (currentGainRef.current) {
      try { currentGainRef.current.disconnect(); } catch (_) {}
      currentGainRef.current = null;
    }
    activeIdRef.current = null;
    setCurrentlyPlayingId(null);
    invoke("stop_audio").catch(() => {});
  };

  const handlePlayClick = (id: number) => {
    // Clicking the same recording that is active (or loading) stops playback.
    if (activeIdRef.current === id) {
      stopPlayback();
      return;
    }
    // Otherwise stop whatever is playing and start the new one (instant switch).
    stopPlayback();
    activeIdRef.current = id;
    setCurrentlyPlayingId(id);
    doPlay(id);
  };

  const doPlay = async (id: number) => {
    const my = ++playTokenRef.current;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();
      if (playTokenRef.current !== my || activeIdRef.current !== id) return; // cancelled

      // Resolve the decoded AudioBuffer (with caching to avoid re-decode).
      let buffer = bufferCacheRef.current.get(id);
      if (!buffer) {
        const dataUrl = await invoke<string>("get_audio", {
          id,
          recordingsDir: configRef.current.recordings_dir || null,
        });
        if (playTokenRef.current !== my || activeIdRef.current !== id) return; // cancelled
        // Decode base64 data URL to ArrayBuffer directly — avoids fetch()
        // which is blocked by CSP connect-src in production (tauri:// scheme).
        const base64 = dataUrl.split(",", 2)[1] || "";
        const binary = atob(base64);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        if (playTokenRef.current !== my || activeIdRef.current !== id) return; // cancelled
        buffer = await ctx.decodeAudioData(arr.buffer);
        bufferCacheRef.current.set(id, buffer);
      }

      const gain = ctx.createGain();
      gain.gain.value = playbackVolumeRef.current;
      gain.connect(ctx.destination);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      currentSourceRef.current = source;
      currentGainRef.current = gain;

      source.onended = () => {
        // Only react if this is still the active source (not a stale callback).
        if (playTokenRef.current !== my || activeIdRef.current !== id) return;
        activeIdRef.current = null;
        currentSourceRef.current = null;
        try { gain.disconnect(); } catch (_) {}
        currentGainRef.current = null;
        setCurrentlyPlayingId(null);
      };

      source.start();
      if (playTokenRef.current !== my || activeIdRef.current !== id) {
        // Cancelled right after start — stop the source we just kicked off.
        try { source.onended = null; source.stop(); source.disconnect(); } catch (_) {}
        currentSourceRef.current = null;
        return;
      }

      // Route the same buffer to VB-CABLE via the backend (raw PCM).
      const vbcable = vbcableDeviceRef.current;
      if (vbcable) {
        console.log("Attempting to output to VB-CABLE:", vbcable);
        try {
          const ch0 = buffer.getChannelData(0);
          const vol = playbackVolumeRef.current;
          const out = new ArrayBuffer(ch0.length * 4);
          const view = new DataView(out);
          for (let i = 0; i < ch0.length; i++)
            view.setFloat32(i * 4, Math.max(-1, Math.min(1, ch0[i] * vol)), true);
          await invoke<void>("play_audio_raw", {
            pcmBytes: new Uint8Array(out),
            sampleRate: buffer.sampleRate, channels: 1,
            deviceName: vbcable, enableMonitoring: false,
          });
          console.log("VB-CABLE output completed - bytes sent:", out.byteLength);
          showStatus("已输出到虚拟麦克风: " + vbcable);
        } catch (e) {
          console.error("VB-CABLE output failed:", e);
          showStatus("输出到虚拟麦克风失败: " + (e as Error).message);
        }
      } else {
        console.warn("No VB-CABLE device found, audio only plays locally");
        showStatus("未找到虚拟麦克风设备，仅本地播放");
      }
    } catch (e) {
      if (playTokenRef.current !== my) return; // silent cancel
      console.error("Failed to play:", e);
      activeIdRef.current = null;
      currentSourceRef.current = null;
      setCurrentlyPlayingId(null);
    }
  };

  const vbcableDeviceRef = useRef<string | null>(null);

  // Keep vbcableDeviceRef in sync with audioDevices
  useEffect(() => {
    const vbcable = audioDevices.find((d) =>
      d.name.includes("VB-Audio") ||
      d.name.includes("CABLE") ||
      d.name.includes("Cable")
    );
    vbcableDeviceRef.current = vbcable?.name || null;
  }, [audioDevices]);

  // Sync playbackVolume ref
  playbackVolumeRef.current = playbackVolume;
  useEffect(() => {
    playRecordingRef.current = handlePlayClick;
  });

  // ---- Init ----
  // Refresh audio device lists (output + input + media-device-id map).
  // Kept as a reusable function so we can react to hot-plug / default-device
  // changes instead of only enumerating once at startup.
  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await invoke<AudioDevice[]>("get_audio_devices");
      setAudioDevices(devices);
      // Choose the output device by priority:
      //   1) current selection (if still present), 2) saved config device
      //   (if present), 3) first available device.
      const current = selectedOutputDevice;
      const saved = configRef.current.output_device || "";
      const pick =
        (current && devices.some((d) => d.name === current) && current) ||
        (saved && devices.some((d) => d.name === saved) && saved) ||
        devices[0]?.name ||
        "";
      setSelectedOutputDevice(pick);
    } catch (e) {
      console.error("Failed to get audio devices:", e);
    }
    try {
      const devices = await invoke<AudioDevice[]>("get_audio_input_devices");
      setInputDevices(devices);
      const current = selectedInputDevice;
      const saved = configRef.current.input_device || "";
      const pick =
        (current && devices.some((d) => d.name === current) && current) ||
        (saved && devices.some((d) => d.name === saved) && saved) ||
        devices[0]?.name ||
        "";
      setSelectedInputDevice(pick);
    } catch (e) {
      console.error("Failed to get input devices:", e);
    }
    try {
      const mediaDevices = await navigator.mediaDevices.enumerateDevices();
      const map: Record<string, string> = {};
      for (const d of mediaDevices) {
        if (d.kind === "audioinput" && d.label) {
          map[d.label] = d.deviceId;
        }
      }
      setInputDeviceIdMap(map);
    } catch (e) {
      console.error("Failed to enumerate media devices:", e);
    }
    // Re-check driver status too — a driver install/reboot may have happened.
    try {
      const status = await invoke<DriverStatus>("is_vbcable_installed");
      setDriverStatus(status);
    } catch (e) {
      console.error("Failed to check VB-CABLE status:", e);
    }
  }, [selectedOutputDevice, selectedInputDevice]);

  useEffect(() => {
    const init = async () => {
      try {
        const saved = await invoke<TtsConfig>("get_config");
        setConfig(saved);
        configRef.current = saved;
      } catch (e) {
        console.error("Failed to load config:", e);
      }
      // Load recordings AFTER config is loaded (so recordings_dir is correct).
      loadRecordings();
      await refreshAudioDevices();
      try {
        const running = await invoke<boolean>("is_transfer_running");
        setIsTransferring(running);
      } catch (e) {
        console.error("Failed to check transfer status:", e);
      }
    };
    init();
  }, [loadRecordings, refreshAudioDevices]);

  // ---- React to audio device hot-plug / default-device changes ----
  useEffect(() => {
    // `devicechange` fires when devices are connected/disconnected.
    const onChange = () => { refreshAudioDevices(); };
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", onChange);
    }
    // Also poll every 5s as a fallback: some Windows/WASAPI setups don't
    // reliably emit devicechange for default-device switches.
    const interval = setInterval(refreshAudioDevices, 5000);
    // Re-enumerate when the window regains focus (e.g. user changed the
    // default device in Windows settings and came back).
    const onFocus = () => { if (document.hasFocus()) refreshAudioDevices(); };
    window.addEventListener("focus", onFocus);
    return () => {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener("devicechange", onChange);
      }
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAudioDevices]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const key = parseInt(e.key);
        const rec = recordingsRef.current.find((r) => r.key_binding === key);
        if (rec) playRecordingRef.current(rec.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Start recording ----
  const startRecording = async () => {
    try {
      const deviceId = selectedInputDevice ? inputDeviceIdMap[selectedInputDevice] || undefined : undefined;
      // Use ideal (not exact) so a missing/renamed device still falls back
      // gracefully instead of throwing "Requested device not found".
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
        });
      } catch (devErr) {
        // Retry without a specific device constraint if the chosen one failed.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.warn("Selected input device unavailable, falling back to default:", devErr);
      }
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      recordingStartTimeRef.current = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const duration_ms = Date.now() - recordingStartTimeRef.current;
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm",
        });
        stream.getTracks().forEach((t) => t.stop());

        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const audioData = reader.result as string;
          const name =
            newRecordingName.trim() ||
            `录音 ${new Date().toLocaleString()}`;
          const id = Date.now();
          const recording: Recording = {
            id,
            name,
            key_binding: selectedKey,
            path: "",
            duration_ms,
          };
          try {
            await invoke("save_recording", {
              recording,
              recordingsDir: configRef.current.recordings_dir || null,
            });
            await invoke("save_audio", {
              id,
              audioData,
              recordingsDir: configRef.current.recordings_dir || null,
            });
            setNewRecordingName("");
            setSelectedKey(null);
            await loadRecordings();
            showStatus("录音已保存!");
          } catch (e) {
            console.error("Failed to save recording:", e);
            showStatus("保存失败");
          }
        };
      };

      mediaRecorder.start();
      setIsRecording(true);
      showStatus("录音中...");
    } catch (e) {
      console.error("Failed to start recording:", e);
      const err = e as DOMException;
      const name = err?.name || "";
      // Distinguish permission denial from device problems so the user
      // gets actionable guidance instead of a cryptic message.
      if (name === "NotAllowedError" || name === "SecurityError") {
        showStatus(
          "麦克风权限被拒绝。请到 Windows 设置 → 隐私 → 麦克风，允许应用访问麦克风后重试。",
          6000,
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        showStatus(
          "未找到可用的麦克风设备，请检查设备连接或重新选择输入设备。",
          6000,
        );
      } else {
        showStatus("录音启动失败: " + (err?.message || String(e)), 6000);
      }
    }
  };

  // ---- Stop recording ----
  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      showStatus("录音完成");
    }
  };

  // ---- Delete recording ----
  const deleteRecording = async (id: number) => {
    try {
      await invoke("delete_recording", {
        id,
        recordingsDir: configRef.current.recordings_dir || null,
      });
      await loadRecordings();
      showStatus("录音已删除");
    } catch (e) {
      console.error("Failed to delete recording:", e);
    }
  };

  // ---- Bind key ----
  const bindKey = async (recordingId: number, key: number) => {
    const recording = recordingsRef.current.find((r) => r.id === recordingId);
    if (recording) {
      const updated = { ...recording, key_binding: key };
      try {
        await invoke("save_recording", {
          recording: updated,
          recordingsDir: configRef.current.recordings_dir || null,
        });
        await loadRecordings();
        showStatus(`快捷键 Ctrl+${key} 已绑定`);
      } catch (e) {
        console.error("Failed to bind key:", e);
        showStatus("绑定失败");
      }
    }
  };

  // ---- Rename recording ----
  const renameRecording = async (id: number, newName: string) => {
    const recording = recordingsRef.current.find((r) => r.id === id);
    if (!recording || !newName.trim()) return;
    const updated = { ...recording, name: newName.trim() };
    try {
      await invoke("save_recording", {
        recording: updated,
        recordingsDir: configRef.current.recordings_dir || null,
      });
      await loadRecordings();
      setRenamingId(null);
      setRenameText("");
      showStatus("录音已重命名");
    } catch (e) {
      console.error("Failed to rename recording:", e);
      showStatus("重命名失败");
    }
  };

  // ---- Live audio transfer ----
  const toggleTransfer = async () => {
    if (isTransferring) {
      try {
        await invoke("stop_transfer");
        setIsTransferring(false);
        showStatus("中转已关闭");
        console.log("Transfer stopped");
      } catch (e) {
        console.error("Failed to stop transfer:", e);
        showStatus("关闭中转失败: " + (e as Error).message);
      }
    } else {
      const targetDevice = selectedOutputDevice || null;
      console.log("Starting transfer to device:", targetDevice);
      try {
        await invoke("start_transfer", {
          outputDevice: targetDevice,
        });
        setIsTransferring(true);
        showStatus("中转已开启: " + (targetDevice || "默认设备"));
        console.log("Transfer started successfully");
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.error("Failed to start transfer:", msg);
        // If transfer was somehow already running, stop it first then retry
        if (msg.includes("already running")) {
          console.log("Transfer already running, attempting to restart...");
          try { await invoke("stop_transfer"); } catch (_) {}
          try {
            await invoke("start_transfer", { outputDevice: targetDevice });
            setIsTransferring(true);
            showStatus("中转已开启: " + (targetDevice || "默认设备"));
            return;
          } catch (e2) {
            console.error("Restart failed:", (e2 as Error).message);
            showStatus("开启中转失败: " + (e2 as Error).message);
            return;
          }
        }
        showStatus("开启中转失败: " + msg);
      }
    }
  };

  // ---- Import audio file ----
  const importAudio = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: "选择要导入的音频文件",
        filters: [
          {
            name: "音频文件",
            extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a", "webm"],
          },
        ],
      });
      if (!selected) return;
      const path = selected as string;
      const name =
        path.split("\\").pop()?.split("/").pop() || "导入的音频";
      showStatus("正在导入音频...");
      const audioData = await invoke<string>("read_file_base64", { path });
      const id = Date.now();
      const recording: Recording = {
        id,
        name: name.replace(/\.[^.]+$/, ""),
        key_binding: null,
        path: "",
        duration_ms: 0,
      };
      await invoke("save_recording", {
        recording,
        recordingsDir: configRef.current.recordings_dir || null,
      });
      await invoke("save_audio", {
        id,
        audioData: `data:audio/webm;base64,${audioData}`,
        recordingsDir: configRef.current.recordings_dir || null,
      });
      await loadRecordings();
      showStatus("音频已导入!");
    } catch (e) {
      console.error("Failed to import audio:", e);
      showStatus("导入失败: " + (e as Error).message);
    }
  };

  // ---- Settings ----
  const saveConfigToBackend = async () => {
    try {
      // Fold the current device selections into the config so they persist
      // across restarts (otherwise the app resets to the default device).
      const configWithDevices: TtsConfig = {
        ...config,
        output_device: selectedOutputDevice || null,
        input_device: selectedInputDevice || null,
      };
      setConfig(configWithDevices);
      configRef.current = configWithDevices;
      await invoke("save_config", { config: configWithDevices });
      setShowSettings(false);
      showStatus("设置已保存");
    } catch (e) {
      console.error("Failed to save config:", e);
    }
  };

  const selectRecordingsDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择录音保存目录",
      });
      if (selected) {
        setConfig({ ...config, recordings_dir: selected as string });
      }
    } catch (e) {
      console.error("Failed to select directory:", e);
    }
  };

  // ---- Render ----
  return isCompactMode ? (
    <div className="bg-slate-900 text-gray-100 select-none" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Compact mode: mini player bar — fills entire compact window without empty space */}
      <div className="flex items-center gap-1 px-2 py-1 bg-slate-800 overflow-hidden" style={{ flex: 1 }}>
        <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-thin" style={{ scrollbarWidth: 'thin', minWidth: 0 }}>
          {recordings
            .filter((r) => r.key_binding != null)
            .sort((a, b) => (a.key_binding ?? 0) - (b.key_binding ?? 0))
            .map((rec) => (
              <button
                key={rec.id}
                onClick={() => handlePlayClick(rec.id)}
                className="flex items-center justify-center gap-1 px-1 py-1 bg-slate-700 hover:bg-slate-600 rounded shrink-0 transition-colors"
                style={{ width: 88 }}
                title={rec.name}
              >
                <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-cyan-500 to-cyan-700 text-white font-bold text-[10px] shadow shadow-cyan-500/20 shrink-0">
                  {rec.key_binding}
                </span>
                <span className="text-[11px] truncate text-slate-200" style={{ maxWidth: 50 }}>{rec.name}</span>
              </button>
            ))}
          {recordings.filter((r) => r.key_binding != null).length === 0 && (
            <span className="text-xs text-slate-500 whitespace-nowrap">暂无可播放的录音</span>
          )}
        </div>
        <button
          onClick={() => stopPlayback()}
          className="p-1 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 transition-colors shrink-0 ml-0.5"
          title="停止播放"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
        </button>
        <button
          onClick={toggleCompactMode}
          disabled={compactTransitionRef.current}
          className="p-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 transition-colors shrink-0 ml-0.5"
          title="展开完整窗口"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  ) : (
    <div className="min-h-screen bg-slate-900 text-gray-100 flex flex-col">
      <header className="bg-slate-800 border-b border-slate-700 px-6 py-4 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-cyan-400">Virtual Voice</h1>
          <p className="text-sm text-slate-400">虚拟语音客户端</p>
        </div>
        <div className="flex items-center gap-4">
          {statusMessage && (
            <span className="text-sm text-cyan-300 animate-pulse">
              {statusMessage}
            </span>
          )}
          <button
            onClick={toggleCompactMode}
            disabled={compactTransitionRef.current}
            className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 transition-colors"
            title="收起为迷你播放器"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </header>

      <main className="flex-1 flex">
        {/* ---- Left sidebar: recordings ---- */}
        <aside className="w-72 bg-slate-800 border-r border-slate-700 p-4 overflow-y-auto">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">录音片段</h2>
            <span className="text-xs text-slate-500">Ctrl+1-9</span>
          </div>

          <div className="space-y-2">
            {recordings.map((rec) => (
              <div
                key={rec.id}
                className={`rounded-lg p-3 transition-colors cursor-pointer group ${
                  currentlyPlayingId === rec.id
                    ? "bg-cyan-900/40 ring-1 ring-cyan-500/50"
                    : "bg-slate-700 hover:bg-slate-600"
                }`}
                onClick={() => handlePlayClick(rec.id)}
              >
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {currentlyPlayingId === rec.id ? (
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0"></span>
                      ) : null}
                      {renamingId === rec.id ? (
                        <input
                          type="text"
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => {
                            if (renameText.trim()) renameRecording(rec.id, renameText);
                            else setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              if (renameText.trim()) renameRecording(rec.id, renameText);
                              else setRenamingId(null);
                            }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 px-2 py-0.5 bg-slate-600 rounded border border-cyan-500 text-sm font-medium focus:outline-none"
                          autoFocus
                        />
                      ) : (
                        <span className={`font-medium truncate ${currentlyPlayingId === rec.id ? "text-cyan-300" : ""}`}>
                          {rec.name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {Math.floor(rec.duration_ms / 1000)}秒
                      {currentlyPlayingId === rec.id && <span className="text-cyan-400 ml-2">播放中...</span>}
                    </p>
                  </div>
                  {/* Key binding badge — always visible */}
                  {rec.key_binding ? (
                    <div className="flex flex-col items-center shrink-0 -mt-0.5">
                      <span className={`inline-flex items-center justify-center w-9 h-9 rounded-xl text-white font-bold text-base shadow-lg ring-1 ${
                        currentlyPlayingId === rec.id
                          ? "bg-gradient-to-br from-cyan-400 to-cyan-600 shadow-cyan-500/20 ring-cyan-400/40"
                          : "bg-gradient-to-br from-cyan-500 to-cyan-700 shadow-cyan-500/20 ring-cyan-400/40"
                      }`}>
                        {rec.key_binding}
                      </span>
                      <span className="text-[9px] text-cyan-500 mt-0.5 font-medium tracking-wider">Ctrl</span>
                    </div>
                  ) : null}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(rec.id);
                        setRenameText(rec.name);
                      }}
                      className="p-1 text-slate-400 hover:text-cyan-300 transition-colors"
                      title="重命名"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <select
                      className="bg-slate-800 text-xs rounded px-1 py-0.5"
                      value={rec.key_binding || ""}
                      onChange={(e) => {
                        e.stopPropagation();
                        const key = parseInt(e.target.value);
                        if (key) bindKey(rec.id, key);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <option value="">绑定</option>
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRecording(rec.id);
                      }}
                      className="p-1 text-red-400 hover:text-red-300 transition-colors"
                      title="删除"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {recordings.length === 0 && (
            <p className="text-center text-slate-500 mt-8">暂无录音片段</p>
          )}
        </aside>

        {/* ---- Main content ---- */}
        <div className="flex-1 p-6 overflow-y-auto">
          <div className="max-w-3xl mx-auto space-y-6">
            {/* Recording control */}
            <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : "bg-slate-500"}`}
                ></span>
                录音控制
              </h3>
              <div className="flex items-center gap-4">
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`px-6 py-3 rounded-lg font-medium transition-all ${
                    isRecording
                      ? "bg-red-600 hover:bg-red-700"
                      : "bg-cyan-600 hover:bg-cyan-700"
                  }`}
                >
                  {isRecording ? "停止录音" : "开始录音"}
                </button>
                <input
                  type="text"
                  placeholder="录音名称（选填）"
                  value={newRecordingName}
                  onChange={(e) => setNewRecordingName(e.target.value)}
                  className="flex-1 px-4 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  onClick={() => stopPlayback()}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-colors flex items-center gap-1"
                  title="停止播放"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                  停止
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={importAudio}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  导入音频
                </button>
              </div>
              <div className="mt-4">
                <label className="text-sm text-slate-400 mb-2 block">
                  播放音量：{Math.round(playbackVolume * 100)}%
                </label>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.1"
                  value={playbackVolume}
                  onChange={(e) => setPlaybackVolume(parseFloat(e.target.value))}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
              <div className="mt-4">
                <label className="text-sm text-slate-400 mb-2 block">
                  快捷键绑定：
                </label>
                <select
                  className="bg-slate-700 rounded px-3 py-2 border border-slate-600"
                  value={selectedKey || ""}
                  onChange={(e) =>
                    setSelectedKey(
                      e.target.value ? parseInt(e.target.value) : null,
                    )
                  }
                >
                  <option value="">不绑定</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
                    <option key={k} value={k}>
                      Ctrl+{k}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded-full ${isTransferring ? "bg-blue-500 animate-pulse" : "bg-slate-500"}`}
                ></span>
                实时语音中转
              </h3>
              <p className="text-slate-400 text-sm mb-4">
                开启后，您的麦克风声音将被实时转发到选中的音频输出设备（如
                VB-Audio Virtual Cable），供其他应用接收。
              </p>
              <button
                onClick={toggleTransfer}
                className={`px-6 py-3 rounded-lg font-medium transition-all ${
                  isTransferring
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-slate-600 hover:bg-slate-700"
                }`}
              >
                {isTransferring ? "关闭中转" : "开启中转"}
              </button>
            </section>
          </div>
        </div>
      </main>

      {/* ---- Settings modal ---- */}
      {showSettings && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="bg-slate-800 rounded-xl p-6 w-full max-w-lg border border-slate-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-semibold">设置</h3>
              <button
                onClick={() => setShowSettings(false)}
                className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="flex border-b border-slate-600 mb-4">
              <button
                onClick={() => setSettingsTab("storage")}
                className={`px-4 py-2 font-medium transition-colors ${
                  settingsTab === "storage"
                    ? "text-cyan-400 border-b-2 border-cyan-400"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                存储设置
              </button>
              <button
                onClick={() => setSettingsTab("audio")}
                className={`px-4 py-2 font-medium transition-colors ${
                  settingsTab === "audio"
                    ? "text-cyan-400 border-b-2 border-cyan-400"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                音频设备
              </button>
            </div>

            <div className="space-y-4">
              {settingsTab === "storage" && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      录音保存目录
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="默认: %LOCALAPPDATA%\VirtualVoice\recordings"
                        value={config.recordings_dir || ""}
                        onChange={(e) =>
                          setConfig({
                            ...config,
                            recordings_dir: e.target.value || null,
                          })
                        }
                        className="flex-1 px-4 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none"
                      />
                      <button
                        onClick={selectRecordingsDir}
                        className="px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors"
                      >
                        浏览
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      选择录音文件的保存位置
                    </p>
                  </div>
                </>
              )}

              {settingsTab === "audio" && (
                <>
                  {/* VB-CABLE Driver Status */}
                  <div className="mb-6 p-4 bg-slate-900 rounded-xl border border-slate-600">
                    <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                      <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                      </svg>
                      VB-CABLE 虚拟麦克风驱动
                    </h4>

                    <div className="flex items-center gap-3 mb-3">
                      <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                        driverStatus === "Installed"
                          ? "bg-green-900 text-green-300 ring-1 ring-green-700"
                          : driverStatus === "NotInstalled"
                            ? "bg-red-900 text-red-300 ring-1 ring-red-700"
                            : "bg-yellow-900 text-yellow-300 ring-1 ring-yellow-700"
                      }`}>
                        <span className={`w-2 h-2 rounded-full ${
                          driverStatus === "Installed"
                            ? "bg-green-400"
                            : driverStatus === "NotInstalled"
                              ? "bg-red-400"
                              : "bg-yellow-400 animate-pulse"
                        }`}></span>
                        {driverStatus === "Installed" ? "已安装" : driverStatus === "NotInstalled" ? "未安装" : "检测中..."}
                      </span>
                    </div>

                    <p className="text-xs text-slate-400 mb-3">
                      VB-CABLE 是一个虚拟音频设备驱动，安装后可在系统的音频设备列表中找到
                      "VB-Audio Virtual Cable"。
                      将本应用的音频输出到该设备，即可为其他应用提供一个虚拟麦克风信号源。
                    </p>

                    <div className="flex gap-2">
                      {driverStatus === "NotInstalled" && (
                        <button
                          onClick={async () => {
                            try {
                              showStatus("正在安装 VB-CABLE 驱动...");
                              const result = await invoke<{success: boolean; message: string}>("install_vbcable_driver");
                              if (result.success) {
                                showStatus(result.message, 6000);
                                const status = await invoke<DriverStatus>("is_vbcable_installed");
                                setDriverStatus(status);
                              } else {
                                showStatus(result.message, 8000);
                              }
                            } catch (e) {
                              console.error("Failed to install driver:", e);
                              showStatus("驱动安装失败，请以管理员身份运行此应用");
                            }
                          }}
                          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium transition-colors"
                        >
                          安装驱动
                        </button>
                      )}
                      {driverStatus === "Installed" && (
                        <button
                          onClick={async () => {
                            try {
                              showStatus("正在卸载 VB-CABLE 驱动...");
                              const result = await invoke<{success: boolean; message: string}>("uninstall_vbcable_driver");
                              showStatus(result.message, 6000);
                              if (result.success) {
                                const status = await invoke<DriverStatus>("is_vbcable_installed");
                                setDriverStatus(status);
                              }
                            } catch (e) {
                              console.error("Failed to uninstall driver:", e);
                              showStatus("驱动卸载失败");
                            }
                          }}
                          className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors"
                        >
                          卸载驱动
                        </button>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">
                      音频输入设备（麦克风）
                    </label>
                    <select
                      value={selectedInputDevice}
                      onChange={(e) => setSelectedInputDevice(e.target.value)}
                      className="w-full px-4 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none"
                    >
                      {inputDevices.map((device) => (
                        <option key={device.name} value={device.name}>
                          {device.name} {device.is_default ? "(默认)" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-400 mt-1">
                      选择录音和实时中转使用的麦克风设备
                    </p>
                  </div>

                  <div className="mt-4">
                    <label className="block text-sm font-medium mb-2">
                      音频输出设备
                    </label>
                    <select
                      value={selectedOutputDevice}
                      onChange={(e) => setSelectedOutputDevice(e.target.value)}
                      className="w-full px-4 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none"
                    >
                      {audioDevices.map((device) => (
                        <option key={device.name} value={device.name}>
                          {device.name} {device.is_default ? "(默认)" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-400 mt-1">
                      选择虚拟音频线缆设备（如 VB-Audio Virtual
                      Cable）可将音频输出到其他应用
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium">监听（同时播放到默认设备）</label>
                      <p className="text-xs text-slate-400 mt-0.5">
                        开启后，播放音频时会同步输出到您的耳机/扬声器
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        setConfig({ ...config, enable_monitoring: !config.enable_monitoring })
                      }
                      className={`relative w-12 h-6 rounded-full transition-colors ${
                        config.enable_monitoring ? "bg-cyan-600" : "bg-slate-600"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                          config.enable_monitoring ? "translate-x-6" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </>
              )}

              <button
                onClick={saveConfigToBackend}
                className="w-full px-6 py-3 bg-cyan-600 hover:bg-cyan-700 rounded-lg font-medium transition-colors"
              >
                保存设置
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="bg-slate-800 border-t border-slate-700 px-6 py-3 flex items-center justify-between text-sm text-slate-500">
        <span>按 Ctrl+数字键 快速播放录音</span>
        <span className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 ${
            driverStatus === "Installed" ? "text-green-500" : driverStatus === "NotInstalled" ? "text-red-500" : "text-yellow-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              driverStatus === "Installed" ? "bg-green-500" : driverStatus === "NotInstalled" ? "bg-red-500" : "bg-yellow-500"
            }`}></span>
            虚拟麦克风: {driverStatus === "Installed" ? "就绪" : driverStatus === "NotInstalled" ? "未安装" : "..."}
          </span>
          <span>|</span>
          <span>Virtual Voice v1.6.0</span>
        </span>
      </footer>
    </div>
  );
}

export default App;
