import { useState, useEffect, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import { audioBufferToWavDataUrl, base64ToArrayBuffer, decodeToWavDataUrl } from "./lib/wav";
import { WaveformEditor } from "./components/WaveformEditor";
import { useStatusMessage } from "./hooks/useStatusMessage";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { useTrayEvents } from "./hooks/useTrayEvents";
import { findHotkeyConflict, hotkeyLabel, normalizeRecording } from "./lib/hotkeys";
import { HotkeyInput } from "./components/HotkeyInput";
import { computePeaks } from "./lib/audioEdit";
import { CompactPlayer } from "./components/CompactPlayer";
import { RecordingList } from "./components/RecordingList";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { TtsPanel } from "./components/TtsPanel";
import { TransferDspPanel } from "./components/TransferDspPanel";
import { ScenePanel } from "./components/ScenePanel";
import {
  DEFAULT_CONFIG,
  DEFAULT_DSP,
  mergeTtsSettings,
  type AppConfig,
  type DspSettings,
  type Scene,
  type AudioDevice,
  type DriverStatus,
  type Recording,
} from "./types";

function App() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("storage");
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
  const [playbackPreview, setPlaybackPreview] = useState<{ id: number; peaks: Float32Array; duration: number } | null>(null);
  const [currentlyPlayingId, setCurrentlyPlayingId] = useState<number | null>(null);
  const [playbackVolume, setPlaybackVolume] = useState(1.0);
  const playbackVolumeRef = useRef(1.0);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const compactTransitionRef = useRef(false);
  const compactWidthRef = useRef(760);
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
        await appWindow.setSizeConstraints({ minWidth: 320, minHeight: 70, maxHeight: 70 });
        await appWindow.setSize(new LogicalSize(compactWidthRef.current, 70));
        await appWindow.setAlwaysOnTop(true);
      } else {
        compactWidthRef.current = Math.max(320, window.innerWidth);
        await appWindow.setSizeConstraints({ minWidth: 400, minHeight: 100 });
        await appWindow.setSize(new LogicalSize(1000, 700));
        await appWindow.setAlwaysOnTop(false);
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
    setPlaybackPreview((preview) => preview?.id === id
      ? { id, peaks: computePeaks(trimmed, 64), duration: trimmed.duration }
      : preview);
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

      setPlaybackPreview({ id, peaks: computePeaks(buffer, 64), duration: buffer.duration });

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
      const saved = configRef.current.output_device || "";
      setSelectedOutputDevice((current) =>
        (current && devices.some((d) => d.name === current) && current) ||
        (saved && devices.some((d) => d.name === saved) && saved) ||
        devices[0]?.name ||
        "",
      );
    } catch (e) {
      console.error("Failed to get audio devices:", e);
    }
    try {
      const devices = await api.getAudioInputDevices();
      setInputDevices(devices);
      const saved = configRef.current.input_device || "";
      setSelectedInputDevice((current) =>
        (current && devices.some((d) => d.name === current) && current) ||
        (saved && devices.some((d) => d.name === saved) && saved) ||
        devices[0]?.name ||
        "",
      );
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
    // Read current selections through state updaters so device/scene changes
    // never recreate this callback and rerun config initialization.
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const saved = await api.getConfig();
        const merged: AppConfig = {
          ...DEFAULT_CONFIG,
          ...saved,
          dsp: { ...DEFAULT_DSP, ...saved.dsp },
          scenes: saved.scenes ?? [],
          tts: mergeTtsSettings(saved.tts),
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

  const saveScene = (name: string, overwriteId?: string) => {
    const scene: Scene = {
      id: overwriteId ?? `scene-${Date.now()}`,
      name,
      input_device: selectedInputDevice || null,
      output_device: selectedOutputDevice || null,
      enable_monitoring: configRef.current.enable_monitoring,
      playback_volume: playbackVolumeRef.current,
      dsp: configRef.current.dsp,
    };
    const others = configRef.current.scenes.filter((s) => s.id !== scene.id);
    updateConfig({ scenes: [...others, scene], active_scene: scene.id });
    showStatus(overwriteId ? `场景「${name}」已更新` : `场景「${name}」已保存`);
  };

  const deleteScene = (id: string) => {
    const { scenes, active_scene } = configRef.current;
    updateConfig({
      scenes: scenes.filter((s) => s.id !== id),
      active_scene: active_scene === id ? null : active_scene,
    });
  };

  const applyScene = async (scene: Scene) => {
    const missing: string[] = [];
    let output = selectedOutputDevice;
    let input = selectedInputDevice;
    if (scene.output_device) {
      if (audioDevices.some((d) => d.name === scene.output_device)) output = scene.output_device;
      else missing.push(scene.output_device);
    }
    if (scene.input_device) {
      if (inputDevices.some((d) => d.name === scene.input_device)) input = scene.input_device;
      else missing.push(scene.input_device);
    }
    setSelectedOutputDevice(output);
    setSelectedInputDevice(input);
    setPlaybackVolume(scene.playback_volume);
    updateConfig({
      output_device: output || null,
      input_device: input || null,
      enable_monitoring: scene.enable_monitoring,
      playback_volume: scene.playback_volume,
      dsp: { ...DEFAULT_DSP, ...scene.dsp },
      active_scene: scene.id,
    });

    if (isTransferring) {
      try {
        await api.stopTransfer();
        await api.startTransfer(output || null, input || null, configRef.current.dsp);
      } catch (e) {
        setIsTransferring(false);
        showStatus("切换场景时重启中转失败: " + (e as Error).message, 6000);
        return;
      }
    }
    showStatus(
      missing.length
        ? `已切换到「${scene.name}」，但找不到设备: ${missing.join("、")}`
        : `已切换到场景「${scene.name}」`,
      missing.length ? 6000 : 3000,
    );
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
      const { dataUrl, durationMs } = await decodeToWavDataUrl(base64ToArrayBuffer(b64));
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

  const saveTtsRecording = async (name: string, audioUrl: string) => {
    const { dataUrl, durationMs } = await decodeToWavDataUrl(base64ToArrayBuffer(audioUrl));
    const id = Date.now();
    const recording: Recording = {
      id,
      name,
      key_binding: null,
      hotkey: null,
      group: "语音合成",
      path: "",
      duration_ms: durationMs,
    };
    await api.saveRecording(recording, configRef.current.recordings_dir || null);
    await api.saveAudio(id, dataUrl, configRef.current.recordings_dir || null);
    await loadRecordings();
    showStatus(`已保存「${name}」到“语音合成”分组`);
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

  const previewId = currentlyPlayingId ?? playbackPreview?.id;
  const playbackRecording = recordings.find((recording) => recording.id === previewId) ?? recordings[0];
  const preview = playbackPreview?.id === playbackRecording?.id ? playbackPreview : null;
  const playbackDuration = preview?.duration ?? (playbackRecording?.duration_ms ?? 0) / 1000;

  if (isCompactMode) {
    return (
      <CompactPlayer
        recordings={recordings}
        currentlyPlayingId={currentlyPlayingId}
        onPlay={handlePlayClick}
        onStop={stopPlayback}
        onExpand={toggleCompactMode}
        expanding={compactTransitionRef.current}
      />
    );
  }

  return (
    <div className="voice-app" data-ui>
      <header className="app-bar">
        <div className="app-brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
          </svg>
          <h1>Virtual Voice</h1>
        </div>
        <div className="app-tools">
          <span className="app-status" role="status">{statusMessage}</span>
          <button className="voice-button icon-button" title="设置" aria-label="设置" onClick={() => setShowSettings(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="m10 3-.7 2.4-2 .9-2.3-.7-2 3.4 1.7 1.8v2.4L3 15l2 3.4 2.3-.7 2 .9.7 2.4h4l.7-2.4 2-.9 2.3.7 2-3.4-1.7-1.8v-2.4L21 9l-2-3.4-2.3.7-2-.9L14 3z" /><circle cx="12" cy="12" r="3.2" />
            </svg>
          </button>
          <button className="voice-button icon-button" title="收起为迷你播放器" aria-label="收起为迷你播放器" onClick={toggleCompactMode} disabled={compactTransitionRef.current}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 9 7 7 7-7" /></svg>
          </button>
        </div>
      </header>

      <main className="voice-workspace">
        <div className="voice-library">
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
          <section className="playback-strip" aria-label="播放控制">
            <div className="playback-controls">
              <button className="voice-button icon-button" title={currentlyPlayingId !== null ? "停止当前播放" : "播放录音"} disabled={!playbackRecording}
                onClick={() => playbackRecording && handlePlayClick(playbackRecording.id)}>
                <span aria-hidden="true">{currentlyPlayingId !== null ? "■" : "▶"}</span>
              </button>
              <button className="voice-button icon-button" title="停止播放" onClick={stopPlayback} disabled={currentlyPlayingId === null}>■</button>
            </div>
            <div className="playback-clip">
              <div className="playback-label"><span>{playbackRecording?.name ?? "暂无录音"}</span>
                {playbackRecording && <time>{playbackDuration > 0 ? playbackDuration.toFixed(1) + " 秒" : "—"}</time>}
              </div>
              {preview ? (
                <svg className="playback-waveform" viewBox="0 0 128 28" preserveAspectRatio="none" aria-hidden="true">
                  {Array.from({ length: 64 }, (_, i) => {
                    const low = Math.min(preview.peaks[i * 2], -0.025);
                    const high = Math.max(preview.peaks[i * 2 + 1], 0.025);
                    return <line key={i} x1={i * 2 + 1} x2={i * 2 + 1} y1={14 - high * 13} y2={14 - low * 13} />;
                  })}
                </svg>
              ) : <div className="waveform-idle" aria-hidden="true" />}
            </div>
            <label className="playback-volume">
              <span>播放音量 <output>{Math.round(playbackVolume * 100)}%</output></span>
              <input type="range" min="0" max="1" step="0.01" value={playbackVolume}
                onChange={(e) => changePlaybackVolume(Number(e.target.value))} />
            </label>
          </section>

          <div className="record-options">
            <input type="text" aria-label="录音名称" value={newRecordingName}
              onChange={(e) => setNewRecordingName(e.target.value)} placeholder="录音名称（选填）" />
            <HotkeyInput compact value={newHotkey} onChange={setNewHotkey} />
            {newHotkey && findHotkeyConflict(recordings, newHotkey, -1) && (
              <span className="record-conflict">保存后将改绑「{findHotkeyConflict(recordings, newHotkey, -1)?.name}」的热键</span>
            )}
          </div>
          <div className="record-actions">
            <button onClick={isRecording ? stopRecording : startRecording} className={`voice-button voice-primary ${isRecording ? "recording-active" : ""}`}>
              <span className="record-dot" aria-hidden="true" />{isRecording ? "停止录音" : "开始录音"}
            </button>
            <button onClick={importAudio} className="voice-button">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 16v4h16v-4M12 16V4m-5 5 5-5 5 5" /></svg>
              导入音频
            </button>
          </div>
        </div>

        <div className="voice-utilities">
          <section className="voice-panel" aria-labelledby="transfer-title">
            <div className="panel-heading">
              <h2 id="transfer-title">实时语音中转</h2>
              <button type="button" role="switch" aria-checked={isTransferring} aria-label="实时语音中转"
                onClick={toggleTransfer} className="transfer-switch">
                <span className="switch-track" aria-hidden="true" />{isTransferring ? "已开启" : "已关闭"}
              </button>
            </div>
            <div className="transfer-devices">
              <label><span>输入设备</span><select value={selectedInputDevice} disabled={isTransferring}
                onChange={(e) => {
                  setSelectedInputDevice(e.target.value);
                  updateConfig({ input_device: e.target.value || null, active_scene: null });
                }}>
                {inputDevices.length === 0 && <option value="">系统默认</option>}
                {inputDevices.map((device, index) => <option key={index} value={device.name}>{device.name}</option>)}
              </select></label>
              <label><span>输出设备</span><select value={selectedOutputDevice} disabled={isTransferring}
                onChange={(e) => {
                  setSelectedOutputDevice(e.target.value);
                  updateConfig({ output_device: e.target.value || null, active_scene: null });
                }}>
                {audioDevices.length === 0 && <option value="">系统默认</option>}
                {audioDevices.map((device, index) => <option key={index} value={device.name}>{device.name}</option>)}
              </select></label>
            </div>
            <TransferDspPanel settings={config.dsp} onChange={changeDsp} active={isTransferring} />
          </section>
          <ScenePanel scenes={config.scenes} activeScene={config.active_scene} onApply={applyScene}
            onSaveCurrent={saveScene} onDelete={deleteScene} />
          <TtsPanel settings={config.tts} onSave={saveTtsRecording} onOpenSettings={() => {
            setSettingsTab("tts");
            setShowSettings(true);
          }} />
        </div>
      </main>

      {showSettings && (
        <SettingsModal
          config={config}
          settingsTab={settingsTab}
          driverStatus={driverStatus}
          statusMessage={statusMessage}
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

      <footer className="app-footer">
        <span>全局热键可在窗口后台使用</span>
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
          <span>Virtual Voice v1.9.0</span>
        </span>
      </footer>
    </div>
  );
}

export default App;
