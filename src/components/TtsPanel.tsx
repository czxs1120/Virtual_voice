import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { TtsSettings } from "../types";

interface Props {
  settings: TtsSettings;
  onSave: (name: string, audioDataUrl: string) => Promise<void>;
  onOpenSettings: () => void;
}

const PROVIDER_LABEL: Record<TtsSettings["provider"], string> = {
  sapi: "Windows 系统语音",
  openai: "OpenAI 兼容接口",
  azure: "Azure 语音服务",
};

export function TtsPanel({ settings, onSave, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Reuse the last result when text and settings are unchanged, so previewing
  // then saving doesn't bill the user twice.
  const cacheRef = useRef<{ key: string; url: string } | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const synthesize = async () => {
    const key = JSON.stringify([text.trim(), settings]);
    if (cacheRef.current?.key === key) return cacheRef.current.url;
    const url = await api.ttsSynthesize(text, settings);
    cacheRef.current = { key, url };
    return url;
  };

  const run = async (kind: "preview" | "save") => {
    setBusy(kind);
    setError(null);
    try {
      const url = await synthesize();
      if (kind === "preview") {
        audioRef.current?.pause();
        audioRef.current = new Audio(url);
        await audioRef.current.play();
      } else {
        const fallback = text.trim().replace(/\s+/g, " ").slice(0, 20);
        await onSave(name.trim() || fallback, url);
        setText("");
        setName("");
        cacheRef.current = null;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const empty = !text.trim();

  return (
    <section className="voice-panel">
      <div className="panel-heading">
        <h2>文字转语音</h2>
        <button
          onClick={onOpenSettings}
          className="text-xs text-cyan-400 hover:text-cyan-300"
          title="配置语音合成服务商"
        >
          {PROVIDER_LABEL[settings.provider]} · 配置
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        aria-label="待合成文本"
        maxLength={5000}
        placeholder="例如：您好，请问有什么可以帮您？"
        className="tts-input"
      />
      <div className="tts-actions">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="录音名称（默认取前 20 字）"
          aria-label="合成录音名称"
        />
        <button
          onClick={() => run("preview")}
          disabled={empty || busy !== null}
          className="voice-button voice-primary"
        >
          {busy === "preview" ? "合成中…" : "试听"}
        </button>
        <button
          onClick={() => run("save")}
          disabled={empty || busy !== null}
          className="voice-button"
        >
          {busy === "save" ? "保存中…" : "保存为录音"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400 break-all">
          {error}
        </p>
      )}
    </section>
  );
}
