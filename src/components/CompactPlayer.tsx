import type { Recording } from "../types";

interface Props {
  recordings: Recording[];
  onPlay: (id: number) => void;
  onStop: () => void;
  onExpand: () => void;
  expanding: boolean;
}

export function CompactPlayer({
  recordings,
  onPlay,
  onStop,
  onExpand,
  expanding,
}: Props) {
  const bound = recordings
    .filter((r) => r.key_binding != null)
    .sort((a, b) => (a.key_binding ?? 0) - (b.key_binding ?? 0));

  return (
    <div
      className="bg-slate-900 text-gray-100 select-none"
      style={{ height: "100vh", display: "flex", flexDirection: "column" }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1 bg-slate-800 overflow-hidden"
        style={{ flex: 1 }}
      >
        <div
          className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-thin"
          style={{ scrollbarWidth: "thin", minWidth: 0 }}
        >
          {bound.map((rec) => (
            <button
              key={rec.id}
              onClick={() => onPlay(rec.id)}
              className="flex items-center justify-center gap-1 px-1 py-1 bg-slate-700 hover:bg-slate-600 rounded shrink-0 transition-colors"
              style={{ width: 88 }}
              title={rec.name}
            >
              <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-gradient-to-br from-cyan-500 to-cyan-700 text-white font-bold text-[10px] shadow shadow-cyan-500/20 shrink-0">
                {rec.key_binding}
              </span>
              <span
                className="text-[11px] truncate text-slate-200"
                style={{ maxWidth: 50 }}
              >
                {rec.name}
              </span>
            </button>
          ))}
          {bound.length === 0 && (
            <span className="text-xs text-slate-500 whitespace-nowrap">
              暂无可播放的录音
            </span>
          )}
        </div>
        <button
          onClick={onStop}
          className="p-1 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50 transition-colors shrink-0 ml-0.5"
          title="停止播放"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
        <button
          onClick={onExpand}
          disabled={expanding}
          className="p-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 transition-colors shrink-0 ml-0.5"
          title="展开完整窗口"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 15l7-7 7 7"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
