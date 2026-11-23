import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TRAY_EVENTS = {
  stopPlayback: "tray://stop-playback",
  toggleTransfer: "tray://toggle-transfer",
} as const;

export function useTrayEvents(handlers: {
  onStopPlayback: () => void;
  onToggleTransfer: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    (async () => {
      try {
        const u1 = await listen(TRAY_EVENTS.stopPlayback, () => ref.current.onStopPlayback());
        const u2 = await listen(TRAY_EVENTS.toggleTransfer, () => ref.current.onToggleTransfer());
        if (disposed) {
          u1();
          u2();
        } else {
          unlisteners.push(u1, u2);
        }
      } catch (e) {
        // Outside the Tauri shell (e.g. browser preview) there is no event bus.
        console.warn("Tray events unavailable:", e);
      }
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, []);
}
