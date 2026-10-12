import { useEffect, useRef } from "react";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import type { Recording } from "../types";

/**
 * Registers Ctrl/Cmd+1..9 as OS-level shortcuts so playback works while
 * the window is unfocused (e.g. Discord / Teams in the foreground).
 * Also keeps an in-window keydown fallback.
 */
export function useGlobalHotkeys(
  recordingsRef: React.MutableRefObject<Recording[]>,
  playById: (id: number) => void,
) {
  const playByIdRef = useRef(playById);
  playByIdRef.current = playById;

  useEffect(() => {
    let cancelled = false;

    const triggerKey = (key: number) => {
      const rec = recordingsRef.current.find((r) => r.key_binding === key);
      if (rec) playByIdRef.current(rec.id);
    };

    const localHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        triggerKey(parseInt(e.key, 10));
      }
    };
    window.addEventListener("keydown", localHandler);

    (async () => {
      try {
        await unregisterAll();
        for (let k = 1; k <= 9; k++) {
          if (cancelled) return;
          const accelerator = `CommandOrControl+${k}`;
          await register(accelerator, () => triggerKey(k));
        }
      } catch (e) {
        // Global shortcuts may fail without accessibility permissions; local
        // keydown handler above remains as a fallback.
        console.warn("Global shortcut registration failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", localHandler);
      unregisterAll().catch(() => {});
    };
  }, [recordingsRef]);
}
