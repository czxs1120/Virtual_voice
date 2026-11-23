import { useEffect, useState } from "react";
import { acceleratorFromEvent, hotkeyLabel } from "../lib/hotkeys";

interface Props {
  value: string | null | undefined;
  onChange: (hotkey: string | null) => void;
  compact?: boolean;
}

/**
 * Click to capture a key combo. Esc cancels, Backspace/Delete clears.
 * Letters and digits need a modifier; F1–F12 may be used alone.
 */
export function HotkeyInput({ value, onChange, compact }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        onChange(null);
        setCapturing(false);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const accel = acceleratorFromEvent(e);
      if (!accel) {
        setHint("需配合 Ctrl/Alt/Shift，或使用 F1–F12");
        return;
      }
      onChange(accel);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onChange]);

  useEffect(() => {
    if (!capturing) setHint("");
  }, [capturing]);

  const size = compact ? "text-xs px-2 py-0.5" : "text-sm px-3 py-2";

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setCapturing((c) => !c);
        }}
        className={`${size} rounded border transition-colors whitespace-nowrap ${
          capturing
            ? "bg-cyan-900/60 border-cyan-400 text-cyan-200 animate-pulse"
            : "bg-slate-800 border-slate-600 hover:border-cyan-500 text-slate-200"
        }`}
        title="点击后按下组合键；Esc 取消，Backspace 清除"
      >
        {capturing ? "请按键…" : value ? hotkeyLabel(value) : "设置热键"}
      </button>
      {capturing && hint && (
        <span className="text-[10px] text-amber-400 mt-0.5">{hint}</span>
      )}
    </span>
  );
}
