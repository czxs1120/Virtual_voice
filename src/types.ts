export interface Recording {
  id: number;
  name: string;
  key_binding: number | null;
  path: string;
  duration_ms: number;
}

export interface AppConfig {
  recordings_dir: string | null;
  enable_monitoring: boolean;
  output_device: string | null;
  input_device: string | null;
}

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
};
