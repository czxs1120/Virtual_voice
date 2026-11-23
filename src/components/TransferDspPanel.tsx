import { useEffect, useState } from "react";
import type { DspSettings, TransferLevels } from "../types";
import { api } from "../lib/api";

interface Props {
  settings: DspSettings;
  onChange: (next: DspSettings) => void;
  active: boolean;
}

const METER_FLOOR_DB = -60;

function Meter({ label, db, marker }: { label: string; db: number; marker?: number }) {
  const pct = (v: number) =>
    Math.max(0, Math.min(100, ((v - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
  const color = db > -3 ? "bg-red-500" : db > -12 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-8 text-slate-400">{label}</span>
      <div className="relative flex-1 h-2 bg-slate-700 rounded overflow-hidden">
        <div className={`h-full ${color} transition-[width] duration-75`} style={{ width: `${pct(db)}%` }} />
        {marker !== undefined && (
          <div className="absolute top-0 h-full w-0.5 bg-cyan-300" style={{ left: `${pct(marker)}%` }} />
        )}
      </div>
      <span className="w-14 text-right tabular-nums text-slate-400">
        {db <= -99 ? "-∞" : db.toFixed(1)} dB
      </span>
    </div>
  );
}

export function TransferDspPanel({ settings, onChange, active }: Props) {
  const [levels, setLevels] = useState<TransferLevels | null>(null);

  useEffect(() => {
    if (!active) {
      setLevels(null);
      return;
    }
    const timer = setInterval(() => {
      api.getTransferLevels().then(setLevels).catch(() => {});
    }, 100);
    return () => clearInterval(timer);
  }, [active]);

  const set = <K extends keyof DspSettings>(key: K, value: DspSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="mt-5 pt-4 border-t border-slate-700 space-y-4">
      <h4 className="text-sm font-semibold text-slate-300">音频处理</h4>

      {active && (
        <div className="space-y-1.5">
          <Meter
            label="输入"
            db={levels?.input_db ?? -100}
            marker={settings.gate_enabled ? settings.gate_threshold_db : undefined}
          />
          <Meter label="输出" db={levels?.output_db ?? -100} />
          {settings.gate_enabled && (
            <p className="text-[11px] text-slate-500">
              噪声门：{levels?.gate_open ? "开启（有声音）" : "关闭（静音中）"}；青色竖线为阈值
            </p>
          )}
        </div>
      )}

      <label className="block text-sm">
        <span className="text-slate-400">输入增益：{settings.gain_db > 0 ? "+" : ""}{settings.gain_db} dB</span>
        <input
          type="range"
          min={-12}
          max={18}
          step={1}
          value={settings.gain_db}
          onChange={(e) => set("gain_db", Number(e.target.value))}
          className="w-full accent-cyan-500"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Toggle
            label="噪声门"
            hint="低于阈值时静音，去掉键盘声和底噪"
            on={settings.gate_enabled}
            onToggle={() => set("gate_enabled", !settings.gate_enabled)}
          />
          <label className={`block text-xs mt-2 ${settings.gate_enabled ? "" : "opacity-40"}`}>
            <span className="text-slate-400">阈值：{settings.gate_threshold_db} dB</span>
            <input
              type="range"
              min={-80}
              max={-20}
              step={1}
              disabled={!settings.gate_enabled}
              value={settings.gate_threshold_db}
              onChange={(e) => set("gate_threshold_db", Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </label>
        </div>
        <div>
          <Toggle
            label="限幅器"
            hint="防止突然大声导致爆音"
            on={settings.limiter_enabled}
            onToggle={() => set("limiter_enabled", !settings.limiter_enabled)}
          />
          <label className={`block text-xs mt-2 ${settings.limiter_enabled ? "" : "opacity-40"}`}>
            <span className="text-slate-400">上限：{settings.limiter_ceiling_db} dB</span>
            <input
              type="range"
              min={-12}
              max={0}
              step={0.5}
              disabled={!settings.limiter_enabled}
              value={settings.limiter_ceiling_db}
              onChange={(e) => set("limiter_ceiling_db", Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-slate-500">{hint}</div>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={`relative shrink-0 w-10 h-5 rounded-full transition-colors ${on ? "bg-cyan-600" : "bg-slate-600"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${on ? "translate-x-5" : ""}`}
        />
      </button>
    </div>
  );
}
