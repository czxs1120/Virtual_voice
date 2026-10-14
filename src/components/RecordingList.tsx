import { useMemo, useState } from "react";
import type { Recording } from "../types";
import { hotkeyLabel } from "../lib/hotkeys";
import { HotkeyInput } from "./HotkeyInput";

const UNGROUPED = "__ungrouped__";

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
  onSetHotkey: (id: number, hotkey: string | null) => void;
  onSetGroup: (id: number, group: string | null) => void;
  onEdit: (id: number) => void;
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
  onSetHotkey,
  onSetGroup,
  onEdit,
  onDelete,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [groupEditId, setGroupEditId] = useState<number | null>(null);
  const [groupText, setGroupText] = useState("");

  const groupNames = useMemo(
    () =>
      Array.from(
        new Set(recordings.map((r) => r.group).filter((g): g is string => !!g)),
      ).sort((a, b) => a.localeCompare(b, "zh")),
    [recordings],
  );

  const sections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const visible = q
      ? recordings.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.group ?? "").toLowerCase().includes(q),
        )
      : recordings;
    const map = new Map<string, Recording[]>();
    for (const rec of visible) {
      const key = rec.group || UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rec);
    }
    const keys = [...groupNames.filter((g) => map.has(g))];
    if (map.has(UNGROUPED)) keys.push(UNGROUPED);
    return keys.map((k) => ({ key: k, items: map.get(k)! }));
  }, [recordings, groupNames, filter]);

  const commitGroup = (id: number) => {
    onSetGroup(id, groupText.trim() || null);
    setGroupEditId(null);
  };

  return (
    <aside className="w-80 bg-slate-800 border-r border-slate-700 p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-semibold">录音片段</h2>
        <span className="text-xs text-slate-500">{recordings.length} 条</span>
      </div>

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索名称或分组…"
        className="w-full mb-3 px-3 py-1.5 text-sm bg-slate-700 rounded border border-slate-600 focus:border-cyan-500 focus:outline-none"
      />

      <datalist id="vv-groups">
        {groupNames.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>

      <div className="space-y-3">
        {sections.map(({ key, items }) => {
          const title = key === UNGROUPED ? "未分组" : key;
          const isCollapsed = !!collapsed[key];
          return (
            <div key={key}>
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                className="w-full flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 mb-1"
              >
                <span className={`transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
                  ▶
                </span>
                {title}
                <span className="text-slate-600 font-normal">({items.length})</span>
              </button>
              {!isCollapsed && (
                <div className="space-y-2">
                  {items.map((rec) => (
                    <div
                      key={rec.id}
                      className={`rounded-lg p-3 transition-colors cursor-pointer group ${
                        currentlyPlayingId === rec.id
                          ? "bg-cyan-900/40 ring-1 ring-cyan-500/50"
                          : "bg-slate-700 hover:bg-slate-600"
                      }`}
                      onClick={() => onPlay(rec.id)}
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {currentlyPlayingId === rec.id && (
                              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                            )}
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
                            {(rec.duration_ms / 1000).toFixed(1)}秒
                            {currentlyPlayingId === rec.id && (
                              <span className="text-cyan-400 ml-2">播放中...</span>
                            )}
                          </p>
                          {groupEditId === rec.id && (
                            <input
                              list="vv-groups"
                              value={groupText}
                              autoFocus
                              placeholder="输入或选择分组，留空取消分组"
                              onChange={(e) => setGroupText(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => commitGroup(rec.id)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Enter") commitGroup(rec.id);
                                if (e.key === "Escape") setGroupEditId(null);
                              }}
                              className="mt-2 w-full px-2 py-0.5 text-xs bg-slate-600 rounded border border-cyan-500 focus:outline-none"
                            />
                          )}
                        </div>
                        {rec.hotkey && (
                          <span className="shrink-0 px-2 py-1 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-700 text-white font-bold text-xs shadow-lg ring-1 ring-cyan-400/40">
                            {hotkeyLabel(rec.hotkey)}
                          </span>
                        )}
                      </div>

                      <div
                        className="flex flex-wrap items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <HotkeyInput
                          compact
                          value={rec.hotkey}
                          onChange={(hk) => onSetHotkey(rec.id, hk)}
                        />
                        <IconButton
                          title="分组"
                          onClick={() => {
                            setGroupEditId(rec.id);
                            setGroupText(rec.group ?? "");
                          }}
                          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                        />
                        <IconButton
                          title="波形 / 裁剪"
                          onClick={() => onEdit(rec.id)}
                          d="M3 12h2l2-6 3 12 3-9 2 3h6"
                        />
                        <IconButton
                          title="重命名"
                          onClick={() => onStartRename(rec.id, rec.name)}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                        <IconButton
                          title="删除"
                          danger
                          onClick={() => onDelete(rec.id)}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {recordings.length === 0 && (
        <p className="text-center text-slate-500 mt-8">暂无录音片段</p>
      )}
      {recordings.length > 0 && sections.length === 0 && (
        <p className="text-center text-slate-500 mt-8">没有匹配的录音</p>
      )}
    </aside>
  );
}

function IconButton({
  title,
  d,
  onClick,
  danger,
}: {
  title: string;
  d: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 transition-colors ${
        danger ? "text-red-400 hover:text-red-300" : "text-slate-400 hover:text-cyan-300"
      }`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
      </svg>
    </button>
  );
}
