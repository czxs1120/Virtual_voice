import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceDialog } from "./VoiceDialog";
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

  const peaks = useMemo(() => buffer ? computePeaks(buffer, WIDTH) : null, [buffer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer?.duration || !peaks) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    const mid = HEIGHT / 2;
    const sx = (start / buffer.duration) * WIDTH;
    const ex = (end / buffer.duration) * WIDTH;

    ctx.fillStyle = "#304764";
    ctx.fillRect(sx, 0, ex - sx, HEIGHT);
    ctx.fillStyle = "rgba(175, 186, 203, 0.15)";
    for (let x = 0; x < WIDTH; x += WIDTH / 8) ctx.fillRect(x, 0, 1, HEIGHT);
    ctx.fillRect(0, mid, WIDTH, 1);

    for (let x = 0; x < WIDTH; x++) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      ctx.fillStyle = x >= sx && x <= ex ? "#77bdff" : "#56647a";
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    ctx.fillStyle = "#c3e2ff";
    ctx.fillRect(Math.max(0, sx - 1), 0, 2, HEIGHT);
    ctx.fillRect(Math.min(WIDTH - 2, ex - 1), 0, 2, HEIGHT);
  }, [buffer, peaks, start, end]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * (buffer?.duration ?? 0);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!buffer || saving) return;
    const t = timeAt(e.clientX);
    dragRef.current = Math.abs(t - start) <= Math.abs(t - end) ? "start" : "end";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    applyDrag(t);
  };

  const applyDrag = (t: number) => {
    if (!buffer) return;
    const minimum = Math.min(MIN_SELECTION, buffer.duration);
    if (dragRef.current === "start") setStart(Math.max(0, Math.min(t, end - minimum)));
    else if (dragRef.current === "end") setEnd(Math.min(buffer.duration, Math.max(t, start + minimum)));
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
    setEnd(Math.min(buffer.duration, Math.max(b.end, b.start + MIN_SELECTION)));
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
    <VoiceDialog title="波形裁剪" subtitle={recording.name} wide onClose={onClose} closeDisabled={saving}
      footer={
        <div className="trim-actions">
          <button type="button" className="voice-button" disabled={!buffer || saving} onClick={autoTrim}>
            去除首尾静音
          </button>
          <button type="button" className="voice-button" disabled={!buffer || saving || unchanged}
            onClick={() => { setStart(0); if (buffer) setEnd(buffer.duration); }}>
            重置
          </button>
          <button type="button" className="voice-button" disabled={!buffer || saving} onClick={preview}>
            {previewing ? "停止试听" : "试听选区"}
          </button>
          <button type="button" className="voice-button voice-primary trim-save"
            disabled={!buffer || saving || unchanged} onClick={save}>
            {saving ? "保存中…" : "保存裁剪"}
          </button>
        </div>
      }
    >
      {error && <p className="trim-error" role="alert">加载或保存失败：{error}</p>}
      {!buffer && !error && <p className="settings-hint" role="status">正在解码音频…</p>}
      <div className="trim-waveform">
        <canvas
          ref={canvasRef}
          data-testid="waveform"
          aria-label="录音波形"
          onPointerDown={onPointerDown}
          onPointerMove={(event) => dragRef.current && applyDrag(timeAt(event.clientX))}
          onLostPointerCapture={() => (dragRef.current = null)}
        />
      </div>
      {buffer && (
        <>
          <dl className="trim-timing">
            <div><dt>起点</dt><dd>{start.toFixed(2)} 秒</dd></div>
            <div className="trim-selection"><dt>选区 / 原长</dt><dd>{(end - start).toFixed(2)} / {buffer.duration.toFixed(2)} 秒</dd></div>
            <div><dt>终点</dt><dd>{end.toFixed(2)} 秒</dd></div>
          </dl>
          <p className="settings-hint">拖动波形两侧的边界调整选区。保存后只保留高亮部分。</p>
        </>
      )}
    </VoiceDialog>
  );
}
