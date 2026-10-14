import type { Recording } from "../types";

/**
 * Hotkeys are stored as Tauri accelerator strings, e.g.
 * "CommandOrControl+1", "F5", "CommandOrControl+Shift+K".
 */

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

function normalizeKey(e: KeyboardEvent): string | null {
  if (FUNCTION_KEY.test(e.key)) return e.key;
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  return null;
}

/** Build an accelerator from a keydown event, or null if not a usable combo. */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const key = normalizeKey(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // Bare letters/digits would hijack normal typing system-wide.
  if (mods.length === 0 && !FUNCTION_KEY.test(key)) return null;
  return [...mods, key].join("+");
}

export function hotkeyLabel(accelerator: string | null | undefined): string {
  if (!accelerator) return "";
  return accelerator.replace("CommandOrControl", "Ctrl");
}

export function legacyHotkey(keyBinding: number | null | undefined): string | null {
  return keyBinding && keyBinding >= 1 && keyBinding <= 9
    ? `CommandOrControl+${keyBinding}`
    : null;
}

/** Fill `hotkey` from the legacy Ctrl+1..9 `key_binding` field. */
export function normalizeRecording(rec: Recording): Recording {
  return {
    ...rec,
    group: rec.group ?? null,
    hotkey: rec.hotkey ?? legacyHotkey(rec.key_binding),
  };
}

export function findHotkeyConflict(
  recordings: Recording[],
  hotkey: string,
  excludeId: number,
): Recording | undefined {
  return recordings.find((r) => r.id !== excludeId && r.hotkey === hotkey);
}

/** Sort key so Ctrl+1..9 come first, then F-keys, then the rest. */
export function hotkeySortKey(hotkey: string): string {
  const m = hotkey.match(/^CommandOrControl\+(\d)$/);
  if (m) return `0${m[1]}`;
  const f = hotkey.match(/^F(\d+)$/);
  if (f) return `1${f[1].padStart(2, "0")}`;
  return `2${hotkey}`;
}
