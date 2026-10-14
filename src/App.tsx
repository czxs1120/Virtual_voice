import { useState, useEffect, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import { audioBufferToWavDataUrl, decodeToWavDataUrl } from "./lib/wav";
import { WaveformEditor } from "./components/WaveformEditor";
import { useStatusMessage } from "./hooks/useStatusMessage";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { useTrayEvents } from "./hooks/useTrayEvents";
import { findHotkeyConflict, hotkeyLabel, normalizeRecording } from "./lib/hotkeys";
import { HotkeyInput } from "./components/HotkeyInput";
import { CompactPlayer } from "./components/CompactPlayer";
import { RecordingList } from "./components/RecordingList";
import { SettingsModal } from "./components/SettingsModal";
import { TransferDspPanel } from "./components/TransferDspPanel";
import {
  DEFAULT_CONFIG,
  DEFAULT_DSP,
  type AppConfig,
  type DspSettings,
  type AudioDevice,
  type DriverStatus,
  type Recording,
} from "./types";

function App() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"storage" | "audio">("storage");
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [newRecordingName, setNewRecordingName] = useState("");
  const [newHotkey, setNewHotkey] = useState<string | null>(null);
  const { statusMessage, showStatus } = useStatusMessage();
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
  const [editingId, setEditingId] = useState<number | null>(null);

  const compactTransitionRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const configRef = useRef<AppConfig>(config);
  const recordingsRef = useRef<Recording[]>(recordings);
  const recordingStartTimeRef = useRef(0);
  const vbcableDeviceRef = useRef<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const currentGainRef = useRef<GainNode | null>(null);
  const bufferCacheRef = useRef<Map<number, AudioBuffer>>(new Map());
  const activeIdRef = useRef<number | null>(null);
  const playTokenRef = useRef(0);

  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    recordingsRef.current = recordings;
  }, [recordings]);

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

  const loadRecordings = useCallback(async () => {
    try {
      const list = await api.getRecordings(configRef.current.recordings_dir || null);
      setRecordings(list.map(normalizeRecording).sort((a, b) => a.id - b.id));
    } catch (e) {
      console.error("Failed to load recordings:", e);
    }
  }, []);

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  };

  const stopPlayback = useCallback(() => {
    playTokenRef.current++;
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
      try {
        currentGainRef.current.disconnect();
      } catch (_) {}
      currentGainRef.current = null;
    }
    activeIdRef.current = null;
    setCurrentlyPlayingId(null);
    api.stopAudio().catch(() => {});
  }, []);

  const loadBuffer = useCallback(async (id: number): Promise<AudioBuffer> => {
    const cached = bufferCacheRef.current.get(id);
    if (cached) return cached;
    const dataUrl = await api.getAudio(id, configRef.current.recordings_dir || null);
    const base64 = dataUrl.split(",", 2)[1] || "";
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    const buffer = await ensureAudioCtx().decodeAudioData(arr.buffer);
    bufferCacheRef.current.set(id, buffer);
    return buffer;
  }, []);

  const saveTrimmed = async (id: number, trimmed: AudioBuffer) => {
    const recording = recordingsRef.current.find((r) => r.id === id);
    if (!recording) return;
    if (activeIdRef.current === id) stopPlayback();
    await api.saveAudio(id, audioBufferToWavDataUrl(trimmed), configRef.current.recordings_dir || null);
    await persist({ ...recording, duration_ms: Math.round(trimmed.duration * 1000) });
    bufferCacheRef.current.set(id, trimmed);
    await loadRecordings();
    showStatus(`已裁剪为 ${trimmed.duration.toFixed(2)} 秒`);
  };

  const doPlay = async (id: number) => {
    const my = ++playTokenRef.current;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === "suspended") await ctx.resume();
      if (playTokenRef.current !== my || activeIdRef.current !== id) return;

      const buffer = await loadBuffer(id);
      if (playTokenRef.current !== my || activeIdRef.current !== id) return;

      const monitor = configRef.current.enable_monitoring;
      const gain = ctx.createGain();
      gain.gain.value = playbackVolumeRef.current;
      // Only route to local speakers when monitoring is enabled.
      if (monitor) gain.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      currentSourceRef.current = source;
      currentGainRef.current = gain;

      source.onended = () => {
        if (playTokenRef.current !== my || activeIdRef.current !== id) return;
        activeIdRef.current = null;
        currentSourceRef.current = null;
        try {
          gain.disconnect();
        } catch (_) {}
        currentGainRef.current = null;
        setCurrentlyPlayingId(null);
      };

      source.start();
      if (playTokenRef.current !== my || activeIdRef.current !== id) {
        try {
          source.onended = null;
          source.stop();
          source.disconnect();
        } catch (_) {}
        currentSourceRef.current = null;
        return;
      }

      const vbcable = vbcableDeviceRef.current;
      if (vbcable) {
        try {
          const ch0 = buffer.getChannelData(0);
          const vol = playbackVolumeRef.current;
          const out = new ArrayBuffer(ch0.length * 4);
          const view = new DataView(out);
          for (let i = 0; i < ch0.length; i++) {
            view.setFloat32(i * 4, Math.max(-1, Math.min(1, ch0[i] * vol)), true);
          }
          await api.playAudioRaw({
            pcmBytes: new Uint8Array(out),
            sampleRate: buffer.sampleRate,
            channels: 1,
            deviceName: vbcable,
            // Frontend already handles local monitoring via AudioContext.
            enableMonitoring: false,
          });
          showStatus("已输出到虚拟麦克风: " + vbcable);
        } catch (e) {
          console.error("VB-CABLE output failed:", e);
          showStatus("输出到虚拟麦克风失败: " + (e as Error).message);
        }
      } else if (!monitor) {
        // No virtual cable and monitoring off — still play locally so user hears something.
        try {
          gain.connect(ctx.destination);
        } catch (_) {}
        showStatus("未找到虚拟麦克风设备，已本地播放");
      } else {
        showStatus("未找到虚拟麦克风设备，仅本地播放");
      }
    } catch (e) {
      if (playTokenRef.current !== my) return;
      console.error("Failed to play:", e);
      activeIdRef.current = null;
      currentSourceRef.current = null;
      setCurrentlyPlayingId(null);
    }
  };

  const handlePlayClick = useCallback(
    (id: number) => {
      if (activeIdRef.current === id) {
        stopPlayback();
        return;
      }
      stopPlayback();
      activeIdRef.current = id;
      setCurrentlyPlayingId(id);
      doPlay(id);
    },
    // doPlay closes over latest refs; stopPlayback is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stopPlayback],
  );

  useEffect(() => {
    const vbcable = audioDevices.find(
      (d) =>
        d.name.includes("VB-Audio") ||
        d.name.includes("CABLE") ||
        d.name.includes("Cable"),
    );
    vbcableDeviceRef.current = vbcable?.name || null;
  }, [audioDevices]);

  playbackVolumeRef.current = playbackVolume;

  useGlobalHotkeys(recordings, handlePlayClick);

  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await api.getAudioDevices();
      setAudioDevices(devices);
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
      const devices = await api.getAudioInputDevices();
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
    try {
      const status = await api.isVbcableInstalled();
      setDriverStatus(status);
    } catch (e) {
      console.error("Failed to check VB-CABLE status:", e);
    }
  }, [selectedOutputDevice, selectedInputDevice]);

  useEffect(() => {
    const init = async () => {
      try {
        const saved = await api.getConfig();
        const merged: AppConfig = {
          ...DEFAULT_CONFIG,
          ...saved,
          dsp: { ...DEFAULT_DSP, ...saved.dsp },
          scenes: saved.scenes ?? [],
        };
        setConfig(merged);
        configRef.current = merged;
        setPlaybackVolume(merged.playback_volume ?? 1);
      } catch (e) {
        console.error("Failed to load config:", e);
      }
      loadRecordings();
      await refreshAudioDevices();
      try {
        const running = await api.isTransferRunning();
        setIsTransferring(running);
      } catch (e) {
        console.error("Failed to check transfer status:", e);
      }
    };
    init();
  }, [loadRecordings, refreshAudioDevices]);

  useEffect(() => {
    const onChange = () => {
      refreshAudioDevices();
    };
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", onChange);
    }
    const interval = setInterval(refreshAudioDevices, 5000);
    const onFocus = () => {
      if (document.hasFocus()) refreshAudioDevices();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener("devicechange", onChange);
      }
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAudioDevices]);

  const startRecording = async () => {
    try {
      const deviceId = selectedInputDevice
        ? inputDeviceIdMap[selectedInputDevice] || undefined
        : undefined;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
        });
      } catch (devErr) {
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
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());

        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const audioData = reader.result as string;
          const name = newRecordingName.trim() || `录音 ${new Date().toLocaleString()}`;
          const id = Date.now();
          const recording: Recording = {
            id,
            name,
            key_binding: null,
            hotkey: null,
            group: null,
            path: "",
            duration_ms,
          };
          try {
            await api.saveRecording(recording, configRef.current.recordings_dir || null);
            await api.saveAudio(id, audioData, configRef.current.recordings_dir || null);
            if (newHotkey) await assignHotkey(recording, newHotkey);
            setNewRecordingName("");
            setNewHotkey(null);
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
      if (name === "NotAllowedError" || name === "SecurityError") {
        showStatus(
          "麦克风权限被拒绝。请到 Windows 设置 → 隐私 → 麦克风，允许应用访问麦克风后重试。",
          6000,
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        showStatus("未找到可用的麦克风设备，请检查设备连接或重新选择输入设备。", 6000);
      } else {
        showStatus("录音启动失败: " + (err?.message || String(e)), 6000);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      showStatus("录音完成");
    }
  };

  const deleteRecording = async (id: number) => {
    try {
      await api.deleteRecording(id, configRef.current.recordings_dir || null);
      bufferCacheRef.current.delete(id);
      await loadRecordings();
      showStatus("录音已删除");
    } catch (e) {
      console.error("Failed to delete recording:", e);
    }
  };

  const persist = (rec: Recording) =>
    api.saveRecording(rec, configRef.current.recordings_dir || null);

  /**
   * Bind `hotkey` to `recording`. A hotkey maps to exactly one recording, so
   * any other recording holding it is unbound. Returns the displaced one.
   */
  const assignHotkey = async (
    recording: Recording,
    hotkey: string | null,
  ): Promise<Recording | undefined> => {
    const conflict = hotkey
      ? findHotkeyConflict(recordingsRef.current, hotkey, recording.id)
      : undefined;
    if (conflict) {
      await persist({ ...conflict, hotkey: null, key_binding: null });
    }
    // Clear the legacy field so normalizeRecording doesn't resurrect it.
    await persist({ ...recording, hotkey, key_binding: null });
    return conflict;
  };

  const setHotkey = async (recordingId: number, hotkey: string | null) => {
    const recording = recordingsRef.current.find((r) => r.id === recordingId);
    if (!recording) return;
    try {
      const conflict = await assignHotkey(recording, hotkey);
      await loadRecordings();
      if (!hotkey) showStatus("热键已清除");
      else if (conflict)
        showStatus(`${hotkeyLabel(hotkey)} 已从「${conflict.name}」改绑到「${recording.name}」`, 4000);
      else showStatus(`热键 ${hotkeyLabel(hotkey)} 已绑定`);
    } catch (e) {
      console.error("Failed to bind hotkey:", e);
      showStatus("绑定失败");
    }
  };

  const setGroup = async (recordingId: number, group: string | null) => {
    const recording = recordingsRef.current.find((r) => r.id === recordingId);
    if (!recording || (recording.group ?? null) === group) return;
    try {
      await persist({ ...recording, group });
      await loadRecordings();
      showStatus(group ? `已移入分组「${group}」` : "已移出分组");
    } catch (e) {
      console.error("Failed to set group:", e);
      showStatus("分组失败");
    }
  };

  const renameRecording = async (id: number, newName: string) => {
    const recording = recordingsRef.current.find((r) => r.id === id);
    if (!recording || !newName.trim()) return;
    const updated = { ...recording, name: newName.trim() };
    try {
      await api.saveRecording(updated, configRef.current.recordings_dir || null);
      await loadRecordings();
      setRenamingId(null);
      setRenameText("");
      showStatus("录音已重命名");
    } catch (e) {
      console.error("Failed to rename recording:", e);
      showStatus("重命名失败");
    }
  };

  const toggleTransfer = async () => {
    if (isTransferring) {
      try {
        await api.stopTransfer();
        setIsTransferring(false);
        showStatus("中转已关闭");
      } catch (e) {
        console.error("Failed to stop transfer:", e);
        showStatus("关闭中转失败: " + (e as Error).message);
      }
    } else {
      const targetDevice = selectedOutputDevice || null;
      const inputDevice = selectedInputDevice || null;
      try {
        await api.startTransfer(targetDevice, inputDevice, configRef.current.dsp);
        setIsTransferring(true);
        showStatus("中转已开启: " + (targetDevice || "默认设备"));
      } catch (e) {
        const msg = (e as Error).message || String(e);
        console.error("Failed to start transfer:", msg);
        if (msg.includes("already running")) {
          try {
            await api.stopTransfer();
          } catch (_) {}
          try {
            await api.startTransfer(targetDevice, inputDevice, configRef.current.dsp);
            setIsTransferring(true);
            showStatus("中转已开启: " + (targetDevice || "默认设备"));
            return;
          } catch (e2) {
            showStatus("开启中转失败: " + (e2 as Error).message);
            return;
          }
        }
        showStatus("开启中转失败: " + msg);
      }
    }
  };

  const persistConfigTimer = useRef<number | undefined>(undefined);
  const updateConfig = useCallback((patch: Partial<AppConfig>) => {
    const next = { ...configRef.current, ...patch };
    configRef.current = next;
    setConfig(next);
    window.clearTimeout(persistConfigTimer.current);
    persistConfigTimer.current = window.setTimeout(() => {
      api.saveConfig(configRef.current).catch((e) => console.error("Failed to save config:", e));
    }, 400);
  }, []);

  const changeDsp = (dsp: DspSettings) => {
    updateConfig({ dsp, active_scene: null });
    if (isTransferring) {
      api.setTransferDsp(dsp).catch((e) => console.error("Failed to update DSP:", e));
    }
  };

  const changePlaybackVolume = (volume: number) => {
    setPlaybackVolume(volume);
    updateConfig({ playback_volume: volume });
  };

  useTrayEvents({
    onStopPlayback: stopPlayback,
    onToggleTransfer: toggleTransfer,
  });

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
      const name = path.split("\\").pop()?.split("/").pop() || "导入的音频";
      showStatus("正在导入音频...");
      const b64 = await api.readFileBase64(path);
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const { dataUrl, durationMs } = await decodeToWavDataUrl(bytes.buffer);
      const id = Date.now();
      const recording: Recording = {
        id,
        name: name.replace(/\.[^.]+$/, ""),
        key_binding: null,
        hotkey: null,
        group: null,
        path: "",
        duration_ms: durationMs,
      };
      await api.saveRecording(recording, configRef.current.recordings_dir || null);
      await api.saveAudio(id, dataUrl, configRef.current.recordings_dir || null);
      await loadRecordings();
      showStatus("音频已导入!");
    } catch (e) {
      console.error("Failed to import audio:", e);
      showStatus("导入失败: " + (e as Error).message);
    }
  };

  const saveConfigToBackend = async () => {
    try {
      const configWithDevices: AppConfig = {
        ...config,
        output_device: selectedOutputDevice || null,
        input_device: selectedInputDevice || null,
      };
      setConfig(configWithDevices);
      configRef.current = configWithDevices;
      await api.saveConfig(configWithDevices);
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

  if (isCompactMode) {
    return (
      <CompactPlayer
        recordings={recordings}
        onPlay={handlePlayClick}
        onStop={stopPlayback}
        onExpand={toggleCompactMode}
        expanding={compactTransitionRef.current}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-gray-100 flex flex-col">
      <header className="bg-slate-800 border-b border-slate-700 px-6 py-4 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-cyan-400">Virtual Voice</h1>
          <p className="text-sm text-slate-400">虚拟语音客户端</p>
        </div>
        <div className="flex items-center gap-4">
          {statusMessage && (
            <span className="text-sm text-cyan-300 animate-pulse">{statusMessage}</span>
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
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <RecordingList
          recordings={recordings}
          currentlyPlayingId={currentlyPlayingId}
          renamingId={renamingId}
          renameText={renameText}
          onPlay={handlePlayClick}
          onStartRename={(id, name) => {
            setRenamingId(id);
            setRenameText(name);
          }}
          onRenameTextChange={setRenameText}
          onCommitRename={(id) => renameRecording(id, renameText)}
          onCancelRename={() => setRenamingId(null)}
          onSetHotkey={setHotkey}
          onSetGroup={setGroup}
          onEdit={setEditingId}
          onDelete={deleteRecording}
        />

        <div className="flex-1 p-6 overflow-y-auto">
          <div className="max-w-3xl mx-auto space-y-6">
            <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded-full ${
                    isRecording ? "bg-red-500 animate-pulse" : "bg-slate-500"
                  }`}
                />
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
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  停止
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={importAudio}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
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
                  max="1"
                  step="0.01"
                  value={playbackVolume}
                  onChange={(e) => changePlaybackVolume(parseFloat(e.target.value))}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />
              </div>
              <div className="mt-4">
                <label className="text-sm text-slate-400 mb-2 block">
                  新录音热键（可选，支持 F1–F12 或 Ctrl/Alt/Shift 组合）：
                </label>
                <div className="flex items-center gap-2">
                  <HotkeyInput value={newHotkey} onChange={setNewHotkey} />
                  {newHotkey && findHotkeyConflict(recordings, newHotkey, -1) && (
                    <span className="text-xs text-amber-400">
                      已被「{findHotkeyConflict(recordings, newHotkey, -1)!.name}」占用，保存后将改绑
                    </span>
                  )}
                </div>
              </div>
            </section>

            <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span
                  className={`w-3 h-3 rounded-full ${
                    isTransferring ? "bg-blue-500 animate-pulse" : "bg-slate-500"
                  }`}
                />
                实时语音中转
              </h3>
              <p className="text-slate-400 text-sm mb-4">
                开启后，您的麦克风声音将被实时转发到选中的音频输出设备（如 VB-Audio Virtual
                Cable），供其他应用接收。
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
              <TransferDspPanel settings={config.dsp} onChange={changeDsp} active={isTransferring} />
            </section>
          </div>
        </div>
      </main>

      {showSettings && (
        <SettingsModal
          config={config}
          settingsTab={settingsTab}
          driverStatus={driverStatus}
          inputDevices={inputDevices}
          audioDevices={audioDevices}
          selectedInputDevice={selectedInputDevice}
          selectedOutputDevice={selectedOutputDevice}
          onClose={() => setShowSettings(false)}
          onTabChange={setSettingsTab}
          onConfigChange={setConfig}
          onSelectRecordingsDir={selectRecordingsDir}
          onInputDeviceChange={setSelectedInputDevice}
          onOutputDeviceChange={setSelectedOutputDevice}
          onInstallDriver={async () => {
            try {
              showStatus("正在安装 VB-CABLE 驱动...");
              const result = await api.installVbcableDriver();
              showStatus(result.message, result.success ? 6000 : 8000);
              if (result.success) {
                setDriverStatus(await api.isVbcableInstalled());
              }
            } catch (e) {
              console.error("Failed to install driver:", e);
              showStatus("驱动安装失败，请以管理员身份运行此应用");
            }
          }}
          onUninstallDriver={async () => {
            try {
              showStatus("正在卸载 VB-CABLE 驱动...");
              const result = await api.uninstallVbcableDriver();
              showStatus(result.message, 6000);
              if (result.success) {
                setDriverStatus(await api.isVbcableInstalled());
              }
            } catch (e) {
              console.error("Failed to uninstall driver:", e);
              showStatus("驱动卸载失败");
            }
          }}
          onSave={saveConfigToBackend}
        />
      )}

      {editingId !== null && recordings.find((r) => r.id === editingId) && (
        <WaveformEditor
          recording={recordings.find((r) => r.id === editingId)!}
          loadBuffer={loadBuffer}
          onSave={(trimmed) => saveTrimmed(editingId, trimmed)}
          onClose={() => setEditingId(null)}
        />
      )}

      <footer className="bg-slate-800 border-t border-slate-700 px-6 py-3 flex items-center justify-between text-sm text-slate-500">
        <span>按绑定的热键快速播放录音（窗口在后台也有效）</span>
        <span className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 ${
              driverStatus === "Installed"
                ? "text-green-500"
                : driverStatus === "NotInstalled"
                  ? "text-red-500"
                  : "text-yellow-500"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                driverStatus === "Installed"
                  ? "bg-green-500"
                  : driverStatus === "NotInstalled"
                    ? "bg-red-500"
                    : "bg-yellow-500"
              }`}
            />
            虚拟麦克风:{" "}
            {driverStatus === "Installed"
              ? "就绪"
              : driverStatus === "NotInstalled"
                ? "未安装"
                : "..."}
          </span>
          <span>|</span>
          <span>Virtual Voice v1.6.0</span>
        </span>
      </footer>
    </div>
  );
}

export default App;
