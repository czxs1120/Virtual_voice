import { useMemo, useState } from "react";
import type { Recording } from "../types";
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
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
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

  const selectedGroup = groupFilter === UNGROUPED || (groupFilter && groupNames.includes(groupFilter))
    ? groupFilter
    : null;
  const query = filter.trim().toLowerCase();
  const visible = recordings.filter((recording) =>
    (selectedGroup === null || (recording.group || UNGROUPED) === selectedGroup) &&
    (recording.name.toLowerCase().includes(query) || (recording.group ?? "").toLowerCase().includes(query)),
  );

  const commitGroup = (id: number) => {
    onSetGroup(id, groupText.trim() || null);
    setGroupEditId(null);
  };

  return (
    <section className="recording-library" aria-labelledby="recordings-title">
      <div className="library-heading">
        <h2 id="recordings-title">录音片段</h2>
        <label className="library-search">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5.5 5.5" />
          </svg>
          <input type="search" aria-label="搜索录音片段" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索录音片段" />
        </label>
      </div>
      <div className="library-filters" aria-label="按分组筛选录音">
        {[{ key: null, label: "全部" }, { key: UNGROUPED, label: "未分组" },
          ...groupNames.map((name) => ({ key: name, label: name }))].map(({ key, label }) => (
          <button key={key === null ? "all" : "group:" + key} onClick={() => setGroupFilter(key)} aria-pressed={selectedGroup === key}>{label}</button>
        ))}
      </div>
      <datalist id="vv-groups">
        {groupNames.map((name) => <option key={name} value={name} />)}
      </datalist>

      <div className="recording-rows">
        {visible.map((rec) => {
          const playing = currentlyPlayingId === rec.id;
          return (
            <div key={rec.id} className="recording-row" data-playing={playing}>
              <button type="button" className="clip-play" aria-label={(playing ? "停止播放 " : "播放 ") + rec.name}
                onClick={() => onPlay(rec.id)}>
                <span aria-hidden="true">{playing ? "■" : "▶"}</span>
              </button>
              <div className="clip-name">
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
                      aria-label="重命名录音" className="w-full px-2 py-0.5 bg-slate-600 rounded border border-cyan-500 text-sm font-medium focus:outline-none"
                      autoFocus
                    />
                  ) : (
                    <button className="clip-title" onClick={() => onPlay(rec.id)} title={rec.name}>{rec.name}</button>
                  )}
                {groupEditId === rec.id && (
                  <input
                    list="vv-groups" aria-label="录音分组"
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
              <time className="clip-duration">{rec.duration_ms > 0 ? formatDuration(rec.duration_ms) : "—"}</time>
              <div className="clip-key"><HotkeyInput compact value={rec.hotkey} onChange={(key) => onSetHotkey(rec.id, key)} /></div>
              <div className="clip-actions">
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
          );
        })}
        {visible.length === 0 && (
          <p className="library-empty">{recordings.length === 0 ? "暂无录音片段" : "没有匹配的录音"}</p>
        )}
      </div>
    </section>
  );
}

function formatDuration(milliseconds: number) {
  const totalTenths = Math.round(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = ((totalTenths % 600) / 10).toFixed(1);
  return String(minutes).padStart(2, "0") + ":" + seconds.padStart(4, "0");
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
