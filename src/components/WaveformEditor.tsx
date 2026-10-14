import { useCallback, useEffect, useRef, useState } from "react";
import type { Recording } from "../types";
import { computePeaks, detectSilenceBounds, sliceBuffer } from "../lib/audioEdit";

interface Props {
  recording: Recording;
  loadBuffer: (id: number) => Promise<AudioBuffer>;
  onSave: (trimmed: AudioBuffer) => Promise<void>;
  onClose: () => void;
}

const WIDTH = 640;
const HEIGHT = 140;
const MIN_SELECTION = 0.05;

export function WaveformEditor({ recording, loadBuffer, onSave, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const dragRef = useRef<"start" | "end" | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const previewSrcRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    let alive = true;
    loadBuffer(recording.id)
      .then((b) => {
        if (!alive) return;
        setBuffer(b);
        setStart(0);
        setEnd(b.duration);
      })
      .catch((e) => alive && setError(String((e as Error)?.message || e)));
    return () => {
      alive = false;
    };
  }, [recording.id, loadBuffer]);

  const stopPreview = useCallback(() => {
    try {
      previewSrcRef.current?.stop();
    } catch (_) {}
    previewSrcRef.current = null;
    setPreviewing(false);
  }, []);

  useEffect(
    () => () => {
      stopPreview();
      previewCtxRef.current?.close().catch(() => {});
    },
    [stopPreview],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    const peaks = computePeaks(buffer, WIDTH);
    const mid = HEIGHT / 2;
    const sx = (start / buffer.duration) * WIDTH;
    const ex = (end / buffer.duration) * WIDTH;

    for (let x = 0; x < WIDTH; x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      ctx.fillStyle = x >= sx && x <= ex ? "#22d3ee" : "#475569";
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    ctx.fillStyle = "rgba(15,23,42,0.55)";
    ctx.fillRect(0, 0, sx, HEIGHT);
    ctx.fillRect(ex, 0, WIDTH - ex, HEIGHT);

    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(sx - 1, 0, 2, HEIGHT);
    ctx.fillRect(ex - 1, 0, 2, HEIGHT);
  }, [buffer, start, end]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * (buffer?.duration ?? 0);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!buffer) return;
    const t = timeAt(e.clientX);
    dragRef.current = Math.abs(t - start) <= Math.abs(t - end) ? "start" : "end";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    applyDrag(t);
  };

  const applyDrag = (t: number) => {
    if (!buffer) return;
    if (dragRef.current === "start") setStart(Math.min(t, end - MIN_SELECTION));
    else if (dragRef.current === "end") setEnd(Math.max(t, start + MIN_SELECTION));
  };

  const preview = async () => {
    if (!buffer) return;
    if (previewing) {
      stopPreview();
      return;
    }
    if (!previewCtxRef.current) previewCtxRef.current = new AudioContext();
    const ctx = previewCtxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => setPreviewing(false);
    src.start(0, start, end - start);
    previewSrcRef.current = src;
    setPreviewing(true);
  };

  const autoTrim = () => {
    if (!buffer) return;
    const b = detectSilenceBounds(buffer);
    setStart(b.start);
    setEnd(Math.max(b.end, b.start + MIN_SELECTION));
  };

  const save = async () => {
    if (!buffer) return;
    stopPreview();
    setSaving(true);
    try {
      await onSave(sliceBuffer(buffer, start, end));
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const unchanged = !!buffer && start <= 0.001 && end >= buffer.duration - 0.001;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded-xl p-6 border border-slate-700 shadow-2xl"
        style={{ width: WIDTH + 48 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">波形 / 裁剪 —「{recording.name}」</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white px-2">
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-red-400 mb-3">加载或保存失败：{error}</p>}
        {!buffer && !error && <p className="text-sm text-slate-400 mb-3">正在解码音频…</p>}

        <canvas
          ref={canvasRef}
          data-testid="waveform"
          style={{ width: WIDTH, height: HEIGHT, touchAction: "none" }}
          className="rounded-lg bg-slate-900 cursor-ew-resize"
          onPointerDown={onPointerDown}
          onPointerMove={(e) => dragRef.current && applyDrag(timeAt(e.clientX))}
          onPointerUp={() => (dragRef.current = null)}
        />

        {buffer && (
          <div className="flex justify-between text-xs text-slate-400 mt-2">
            <span>起点 {start.toFixed(2)}s</span>
            <span className="text-cyan-300">
              选区 {(end - start).toFixed(2)}s / 原长 {buffer.duration.toFixed(2)}s
            </span>
            <span>终点 {end.toFixed(2)}s</span>
          </div>
        )}

        <p className="text-xs text-slate-500 mt-2">
          在波形上拖动橙色边界调整选区；保存后只保留高亮部分。
        </p>

        <div className="flex gap-2 mt-4">
          <button
            disabled={!buffer}
            onClick={autoTrim}
            className="px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-sm"
          >
            自动去除首尾静音
          </button>
          <button
            disabled={!buffer}
            onClick={() => buffer && (setStart(0), setEnd(buffer.duration))}
            className="px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-sm"
          >
            重置
          </button>
          <button
            disabled={!buffer}
            onClick={preview}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-sm"
          >
            {previewing ? "停止试听" : "试听选区"}
          </button>
          <div className="flex-1" />
          <button
            disabled={!buffer || saving || unchanged}
            onClick={save}
            className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-sm font-medium"
          >
            {saving ? "保存中…" : "保存裁剪"}
          </button>
        </div>
      </div>
    </div>
  );
}
