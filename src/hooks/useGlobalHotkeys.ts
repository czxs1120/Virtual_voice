import { useEffect, useMemo, useRef } from "react";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { acceleratorFromEvent } from "../lib/hotkeys";
import type { Recording } from "../types";

/**
 * Registers each recording's hotkey as an OS-level shortcut so playback works
 * while the window is unfocused (e.g. Discord / Teams in the foreground).
 * An in-window keydown handler remains as a fallback.
 */
export function useGlobalHotkeys(
  recordings: Recording[],
  playById: (id: number) => void,
  enabled = true,
) {
  const playByIdRef = useRef(playById);
  playByIdRef.current = playById;
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;

  const signature = useMemo(
    () =>
      recordings
        .filter((r) => r.hotkey)
        .map((r) => r.hotkey)
        .sort()
        .join("|"),
    [recordings],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const trigger = (accelerator: string) => {
      const rec = recordingsRef.current.find((r) => r.hotkey === accelerator);
      if (rec) playByIdRef.current(rec.id);
    };

    const localHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const accel = acceleratorFromEvent(e);
      if (accel && recordingsRef.current.some((r) => r.hotkey === accel)) {
        e.preventDefault();
        trigger(accel);
      }
    };
    window.addEventListener("keydown", localHandler);

    (async () => {
      try {
        await unregisterAll();
        const hotkeys = signature ? signature.split("|") : [];
        for (const accel of hotkeys) {
          if (cancelled) return;
          try {
            await register(accel, (event) => {
              // Fires on both press and release; playback toggles, so only
              // react to the press or one keystroke would start then stop.
              if (event.state === "Pressed") trigger(accel);
            });
          } catch (e) {
            console.warn(`Global shortcut ${accel} unavailable:`, e);
          }
        }
      } catch (e) {
        console.warn("Global shortcut registration failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", localHandler);
      unregisterAll().catch(() => {});
    };
  }, [signature, enabled]);
}
