import type { AppConfig, AudioDevice, DriverStatus } from "../types";

interface Props {
  config: AppConfig;
  settingsTab: "storage" | "audio";
  driverStatus: DriverStatus;
  inputDevices: AudioDevice[];
  audioDevices: AudioDevice[];
  selectedInputDevice: string;
  selectedOutputDevice: string;
  onClose: () => void;
  onTabChange: (tab: "storage" | "audio") => void;
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
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded-xl p-6 w-full max-w-lg border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-semibold">设置</h3>
          <button
            onClick={onClose}
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
            onClick={() => onTabChange("storage")}
            className={`px-4 py-2 font-medium transition-colors ${
              settingsTab === "storage"
                ? "text-cyan-400 border-b-2 border-cyan-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            存储设置
          </button>
          <button
            onClick={() => onTabChange("audio")}
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
                    onConfigChange({
                      ...config,
                      recordings_dir: e.target.value || null,
                    })
                  }
                  className="flex-1 px-4 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  onClick={onSelectRecordingsDir}
                  className="px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors"
                >
                  浏览
                </button>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                选择录音文件的保存位置
              </p>
            </div>
          )}

          {settingsTab === "audio" && (
            <>
              <div className="mb-6 p-4 bg-slate-900 rounded-xl border border-slate-600">
                <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-cyan-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                    />
                  </svg>
                  VB-CABLE 虚拟麦克风驱动
                </h4>

                <div className="flex items-center gap-3 mb-3">
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                      driverStatus === "Installed"
                        ? "bg-green-900 text-green-300 ring-1 ring-green-700"
                        : driverStatus === "NotInstalled"
                          ? "bg-red-900 text-red-300 ring-1 ring-red-700"
                          : "bg-yellow-900 text-yellow-300 ring-1 ring-yellow-700"
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full ${
                        driverStatus === "Installed"
                          ? "bg-green-400"
                          : driverStatus === "NotInstalled"
                            ? "bg-red-400"
                            : "bg-yellow-400 animate-pulse"
                      }`}
                    />
                    {driverStatus === "Installed"
                      ? "已安装"
                      : driverStatus === "NotInstalled"
                        ? "未安装"
                        : "检测中..."}
                  </span>
                </div>

                <p className="text-xs text-slate-400 mb-3">
                  VB-CABLE 是一个虚拟音频设备驱动，安装后可在系统的音频设备列表中找到
                  &quot;VB-Audio Virtual Cable&quot;。
                  将本应用的音频输出到该设备，即可为其他应用提供一个虚拟麦克风信号源。
                </p>

                <div className="flex gap-2">
                  {driverStatus === "NotInstalled" && (
                    <button
                      onClick={onInstallDriver}
                      className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 rounded-lg text-sm font-medium transition-colors"
                    >
                      安装驱动
                    </button>
                  )}
                  {driverStatus === "Installed" && (
                    <button
                      onClick={onUninstallDriver}
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
                  onChange={(e) => onInputDeviceChange(e.target.value)}
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
                  onChange={(e) => onOutputDeviceChange(e.target.value)}
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
                  <label className="text-sm font-medium">
                    监听（同时播放到默认设备）
                  </label>
                  <p className="text-xs text-slate-400 mt-0.5">
                    开启后，播放音频时会同步输出到您的耳机/扬声器
                  </p>
                </div>
                <button
                  onClick={() =>
                    onConfigChange({
                      ...config,
                      enable_monitoring: !config.enable_monitoring,
                    })
                  }
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    config.enable_monitoring ? "bg-cyan-600" : "bg-slate-600"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      config.enable_monitoring
                        ? "translate-x-6"
                        : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </>
          )}

          <button
            onClick={onSave}
            className="w-full px-6 py-3 bg-cyan-600 hover:bg-cyan-700 rounded-lg font-medium transition-colors"
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
