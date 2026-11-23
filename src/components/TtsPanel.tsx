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
    <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-lg font-semibold">文字转语音</h3>
        <button
          onClick={onOpenSettings}
          className="text-xs text-cyan-400 hover:text-cyan-300"
          title="配置语音合成服务商"
        >
          {PROVIDER_LABEL[settings.provider]} · 配置
        </button>
      </div>
      <p className="text-slate-400 text-sm mb-3">输入话术，生成后保存为录音，即可绑定热键播放到虚拟麦克风。</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={5000}
        placeholder="例如：您好，请问有什么可以帮您？"
        className="w-full px-3 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none text-sm resize-y"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="录音名称（默认取前 20 字）"
          className="flex-1 min-w-[10rem] px-3 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none text-sm"
        />
        <button
          onClick={() => run("preview")}
          disabled={empty || busy !== null}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-50 rounded-lg text-sm font-medium"
        >
          {busy === "preview" ? "合成中…" : "试听"}
        </button>
        <button
          onClick={() => run("save")}
          disabled={empty || busy !== null}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 rounded-lg text-sm font-medium"
        >
          {busy === "save" ? "保存中…" : "生成并保存为录音"}
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
