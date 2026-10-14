export interface Recording {
  id: number;
  name: string;
  /** Legacy Ctrl+1..9 binding; superseded by `hotkey`. */
  key_binding: number | null;
  path: string;
  duration_ms: number;
  group?: string | null;
  /** Tauri accelerator string, e.g. "CommandOrControl+1" or "F5". */
  hotkey?: string | null;
}

export interface DspSettings {
  gain_db: number;
  gate_enabled: boolean;
  gate_threshold_db: number;
  limiter_enabled: boolean;
  limiter_ceiling_db: number;
}

export interface TransferLevels {
  input_db: number;
  output_db: number;
  gate_open: boolean;
}

export interface Scene {
  id: string;
  name: string;
  input_device: string | null;
  output_device: string | null;
  enable_monitoring: boolean;
  playback_volume: number;
  dsp: DspSettings;
}

export interface AppConfig {
  recordings_dir: string | null;
  enable_monitoring: boolean;
  output_device: string | null;
  input_device: string | null;
  playback_volume: number;
  dsp: DspSettings;
  scenes: Scene[];
  active_scene: string | null;
}

export const DEFAULT_DSP: DspSettings = {
  gain_db: 0,
  gate_enabled: false,
  gate_threshold_db: -50,
  limiter_enabled: true,
  limiter_ceiling_db: -1,
};

export interface AudioDevice {
  id?: string;
  name: string;
  is_default: boolean;
}

export type DriverStatus = "Installed" | "NotInstalled" | "Unknown";

export interface DriverActionResult {
  success: boolean;
  message: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  recordings_dir: null,
  enable_monitoring: true,
  output_device: null,
  input_device: null,
  playback_volume: 1,
  dsp: DEFAULT_DSP,
  scenes: [],
  active_scene: null,
};
