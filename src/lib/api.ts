import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  AudioDevice,
  DspSettings,
  DriverActionResult,
  TransferLevels,
  TtsProvider,
  TtsSettings,
  TtsVoice,
  DriverStatus,
  Recording,
} from "../types";

export const api = {
  getRecordings: (recordingsDir: string | null) =>
    invoke<Recording[]>("get_recordings", { recordingsDir }),

  saveRecording: (recording: Recording, recordingsDir: string | null) =>
    invoke("save_recording", { recording, recordingsDir }),

  deleteRecording: (id: number, recordingsDir: string | null) =>
    invoke("delete_recording", { id, recordingsDir }),

  saveAudio: (id: number, audioData: string, recordingsDir: string | null) =>
    invoke("save_audio", { id, audioData, recordingsDir }),

  getAudio: (id: number, recordingsDir: string | null) =>
    invoke<string>("get_audio", { id, recordingsDir }),

  getConfig: () => invoke<AppConfig>("get_config"),

  saveConfig: (config: AppConfig) => invoke("save_config", { config }),

  getAudioDevices: () => invoke<AudioDevice[]>("get_audio_devices"),

  getAudioInputDevices: () => invoke<AudioDevice[]>("get_audio_input_devices"),

  playAudioRaw: (args: {
    pcmBytes: Uint8Array;
    sampleRate: number;
    channels: number;
    deviceName: string | null;
    enableMonitoring: boolean;
  }) => invoke<void>("play_audio_raw", args),

  stopAudio: () => invoke("stop_audio"),

  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),

  startTransfer: (
    outputDevice: string | null,
    inputDevice: string | null,
    dsp: DspSettings,
  ) => invoke("start_transfer", { outputDevice, inputDevice, dsp }),

  setTransferDsp: (settings: DspSettings) => invoke("set_transfer_dsp", { settings }),

  getTransferLevels: () => invoke<TransferLevels>("get_transfer_levels"),

  stopTransfer: () => invoke("stop_transfer"),

  ttsSynthesize: (text: string, settings: TtsSettings) =>
    invoke<string>("tts_synthesize", { text, settings }),

  ttsListVoices: (settings: TtsSettings) => invoke<TtsVoice[]>("tts_list_voices", { settings }),

  ttsSetApiKey: (provider: TtsProvider, key: string | null) =>
    invoke("tts_set_api_key", { provider, key }),

  ttsHasApiKey: (provider: TtsProvider) => invoke<boolean>("tts_has_api_key", { provider }),

  isTransferRunning: () => invoke<boolean>("is_transfer_running"),

  isVbcableInstalled: () => invoke<DriverStatus>("is_vbcable_installed"),

  installVbcableDriver: () =>
    invoke<DriverActionResult>("install_vbcable_driver"),

  uninstallVbcableDriver: () =>
    invoke<DriverActionResult>("uninstall_vbcable_driver"),
};
