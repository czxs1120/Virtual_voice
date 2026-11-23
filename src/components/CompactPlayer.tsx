import { useMemo } from "react";
import type { Recording } from "../types";
import { hotkeyLabel, hotkeySortKey } from "../lib/hotkeys";

interface Props {
  recordings: Recording[];
  currentlyPlayingId: number | null;
  onPlay: (id: number) => void;
  onStop: () => void;
  onExpand: () => void;
  expanding: boolean;
}

export function CompactPlayer({ recordings, currentlyPlayingId, onPlay, onStop, onExpand, expanding }: Props) {
  const bound = useMemo(() => recordings
    .filter((recording) => recording.hotkey)
    .sort((a, b) => hotkeySortKey(a.hotkey!).localeCompare(hotkeySortKey(b.hotkey!))), [recordings]);

  return (
    <div className="compact-player" data-ui>
      <div className="compact-clips" aria-label="已绑定热键的录音">
        {bound.map((recording) => (
          <button key={recording.id} type="button" className="compact-clip"
            aria-pressed={currentlyPlayingId === recording.id}
            title={recording.name + "（" + hotkeyLabel(recording.hotkey) + "）"}
            onClick={() => onPlay(recording.id)}>
            <span className="min-w-0 truncate text-sm">{recording.name}</span>
            <kbd>{hotkeyLabel(recording.hotkey)}</kbd>
          </button>
        ))}
        {bound.length === 0 && <span className="px-2 text-xs text-slate-400">暂无绑定热键的录音</span>}
      </div>
      <button type="button" onClick={onStop} className="voice-button compact-stop shrink-0" title="停止播放">
        <span aria-hidden="true">■</span>停止
      </button>
      <button type="button" onClick={onExpand} disabled={expanding}
        className="voice-button icon-button shrink-0" title="展开完整窗口" aria-label="展开完整窗口">
        <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />
        </svg>
      </button>
    </div>
  );
}
