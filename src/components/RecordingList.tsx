import type { Recording } from "../types";

interface Props {
  recordings: Recording[];
  currentlyPlayingId: number | null;
  renamingId: number | null;
  renameText: string;
  onPlay: (id: number) => void;
  onStartRename: (id: number, name: string) => void;
  onRenameTextChange: (text: string) => void;
  onCommitRename: (id: number) => void;
  onCancelRename: () => void;
  onBindKey: (id: number, key: number) => void;
  onDelete: (id: number) => void;
}

export function RecordingList({
  recordings,
  currentlyPlayingId,
  renamingId,
  renameText,
  onPlay,
  onStartRename,
  onRenameTextChange,
  onCommitRename,
  onCancelRename,
  onBindKey,
  onDelete,
}: Props) {
  return (
    <aside className="w-72 bg-slate-800 border-r border-slate-700 p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">录音片段</h2>
        <span className="text-xs text-slate-500">Ctrl+1-9</span>
      </div>

      <div className="space-y-2">
        {recordings.map((rec) => (
          <div
            key={rec.id}
            className={`rounded-lg p-3 transition-colors cursor-pointer group ${
              currentlyPlayingId === rec.id
                ? "bg-cyan-900/40 ring-1 ring-cyan-500/50"
                : "bg-slate-700 hover:bg-slate-600"
            }`}
            onClick={() => onPlay(rec.id)}
          >
            <div className="flex justify-between items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {currentlyPlayingId === rec.id ? (
                    <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                  ) : null}
                  {renamingId === rec.id ? (
                    <input
                      type="text"
                      value={renameText}
                      onChange={(e) => onRenameTextChange(e.target.value)}
                      onBlur={() => {
                        if (renameText.trim()) onCommitRename(rec.id);
                        else onCancelRename();
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          if (renameText.trim()) onCommitRename(rec.id);
                          else onCancelRename();
                        }
                        if (e.key === "Escape") onCancelRename();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 px-2 py-0.5 bg-slate-600 rounded border border-cyan-500 text-sm font-medium focus:outline-none"
                      autoFocus
                    />
                  ) : (
                    <span
                      className={`font-medium truncate ${
                        currentlyPlayingId === rec.id ? "text-cyan-300" : ""
                      }`}
                    >
                      {rec.name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {Math.floor(rec.duration_ms / 1000)}秒
                  {currentlyPlayingId === rec.id && (
                    <span className="text-cyan-400 ml-2">播放中...</span>
                  )}
                </p>
              </div>
              {rec.key_binding ? (
                <div className="flex flex-col items-center shrink-0 -mt-0.5">
                  <span
                    className={`inline-flex items-center justify-center w-9 h-9 rounded-xl text-white font-bold text-base shadow-lg ring-1 ${
                      currentlyPlayingId === rec.id
                        ? "bg-gradient-to-br from-cyan-400 to-cyan-600 shadow-cyan-500/20 ring-cyan-400/40"
                        : "bg-gradient-to-br from-cyan-500 to-cyan-700 shadow-cyan-500/20 ring-cyan-400/40"
                    }`}
                  >
                    {rec.key_binding}
                  </span>
                  <span className="text-[9px] text-cyan-500 mt-0.5 font-medium tracking-wider">
                    Ctrl
                  </span>
                </div>
              ) : null}
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartRename(rec.id, rec.name);
                  }}
                  className="p-1 text-slate-400 hover:text-cyan-300 transition-colors"
                  title="重命名"
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
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </button>
                <select
                  className="bg-slate-800 text-xs rounded px-1 py-0.5"
                  value={rec.key_binding || ""}
                  onChange={(e) => {
                    e.stopPropagation();
                    const key = parseInt(e.target.value, 10);
                    if (key) onBindKey(rec.id, key);
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="">绑定</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(rec.id);
                  }}
                  className="p-1 text-red-400 hover:text-red-300 transition-colors"
                  title="删除"
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
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {recordings.length === 0 && (
        <p className="text-center text-slate-500 mt-8">暂无录音片段</p>
      )}
    </aside>
  );
}
