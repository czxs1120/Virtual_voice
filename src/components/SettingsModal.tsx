import { VoiceDialog } from "./VoiceDialog";
import type { AppConfig, AudioDevice, DriverStatus } from "../types";
import { TtsSettingsPanel } from "./TtsSettingsPanel";

export type SettingsTab = "storage" | "audio" | "tts";

interface Props {
  config: AppConfig;
  settingsTab: SettingsTab;
  driverStatus: DriverStatus;
  statusMessage: string;
  inputDevices: AudioDevice[];
  audioDevices: AudioDevice[];
  selectedInputDevice: string;
  selectedOutputDevice: string;
  onClose: () => void;
  onTabChange: (tab: SettingsTab) => void;
  onConfigChange: (config: AppConfig) => void;
  onSelectRecordingsDir: () => void;
  onInputDeviceChange: (name: string) => void;
  onOutputDeviceChange: (name: string) => void;
  onInstallDriver: () => void;
  onUninstallDriver: () => void;
  onSave: () => void;
}

export function SettingsModal({
  config,
  settingsTab,
  driverStatus,
  statusMessage,
  inputDevices,
  audioDevices,
  selectedInputDevice,
  selectedOutputDevice,
  onClose,
  onTabChange,
  onConfigChange,
  onSelectRecordingsDir,
  onInputDeviceChange,
  onOutputDeviceChange,
  onInstallDriver,
  onUninstallDriver,
  onSave,
}: Props) {
  return (
    <VoiceDialog title="设置" onClose={onClose}
      navigation={
        <nav className="library-filters settings-tabs" aria-label="设置分类">
          {([
            ["storage", "存储设置"],
            ["audio", "音频设备"],
            ["tts", "语音合成"],
          ] as const).map(([tab, label]) => (
            <button key={tab} type="button" aria-pressed={settingsTab === tab} onClick={() => onTabChange(tab)}>
              {label}
            </button>
          ))}
        </nav>
      }
      footer={
        <>
          <span className="settings-status" role="status">{statusMessage}</span>
          <button type="button" className="voice-button voice-primary" onClick={onSave}>保存设置</button>
        </>
      }
    >
      <div key={settingsTab} className="settings-content">
        {settingsTab === "storage" && (
          <div className="settings-field">
            <label htmlFor="recordings-dir">录音保存目录</label>
            <div className="settings-inline">
              <input
                id="recordings-dir"
                className="settings-input"
                type="text"
                placeholder="默认：%LOCALAPPDATA%\VirtualVoice\recordings"
                value={config.recordings_dir || ""}
                onChange={(event) => onConfigChange({ ...config, recordings_dir: event.target.value || null })}
              />
              <button type="button" className="voice-button" onClick={onSelectRecordingsDir}>浏览</button>
            </div>
          </div>
        )}

        {settingsTab === "audio" && (
          <>
            <div className="settings-card">
              <div className="settings-card-heading">
                <h3>VB-CABLE 驱动</h3>
                <span className="driver-state" data-state={driverStatus}>
                  {driverStatus === "Installed" ? "已安装" : driverStatus === "NotInstalled" ? "未安装" : "状态未知"}
                </span>
              </div>
              <p className="settings-hint">将输出设备设为 VB-Audio Virtual Cable 后，其他应用可通过虚拟麦克风接收音频。</p>
              {driverStatus === "Installed" && (
                <button type="button" className="voice-button settings-danger" onClick={onUninstallDriver}>卸载驱动</button>
              )}
              {driverStatus === "NotInstalled" && (
                <button type="button" className="voice-button" onClick={onInstallDriver}>安装驱动</button>
              )}
            </div>

            <label className="settings-field">
              <span>输入设备（麦克风）</span>
              <select className="settings-input" value={selectedInputDevice}
                onChange={(event) => onInputDeviceChange(event.target.value)}>
                {inputDevices.length === 0 && <option value="">未找到输入设备</option>}
                {inputDevices.map((device, index) => (
                  <option key={index} value={device.name}>{device.name}{device.is_default ? "（默认）" : ""}</option>
                ))}
              </select>
            </label>

            <label className="settings-field">
              <span>输出设备</span>
              <select className="settings-input" value={selectedOutputDevice}
                onChange={(event) => onOutputDeviceChange(event.target.value)}>
                {audioDevices.length === 0 && <option value="">未找到输出设备</option>}
                {audioDevices.map((device, index) => (
                  <option key={index} value={device.name}>{device.name}{device.is_default ? "（默认）" : ""}</option>
                ))}
              </select>
            </label>

            <div className="settings-monitor">
              <div>
                <h3 id="monitor-title">监听播放</h3>
                <p id="monitor-hint" className="settings-hint">同时在默认耳机或扬声器上播放。</p>
              </div>
              <button type="button" className="transfer-switch" role="switch"
                aria-labelledby="monitor-title" aria-describedby="monitor-hint" aria-checked={config.enable_monitoring}
                onClick={() => onConfigChange({ ...config, enable_monitoring: !config.enable_monitoring })}>
                <span className="switch-track" aria-hidden="true" />
              </button>
            </div>
          </>
        )}

        {settingsTab === "tts" && (
          <TtsSettingsPanel settings={config.tts} onChange={(tts) => onConfigChange({ ...config, tts })} />
        )}
      </div>
    </VoiceDialog>
  );
}
