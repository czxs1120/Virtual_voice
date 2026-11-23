import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { TtsProvider, TtsSettings, TtsVoice } from "../types";

interface Props {
  settings: TtsSettings;
  onChange: (next: TtsSettings) => void;
}

const PROVIDERS: { id: TtsProvider; name: string; desc: string }[] = [
  { id: "sapi", name: "Windows 系统语音", desc: "免费、离线，使用系统已安装的语音包" },
  {
    id: "openai",
    name: "OpenAI 兼容接口",
    desc: "OpenAI 或任何兼容 /audio/speech 的服务，包括本地部署的模型",
  },
  { id: "azure", name: "Azure 语音服务", desc: "微软神经网络语音，需要自己的 Azure 订阅密钥" },
];

const OPENAI_PRESETS = [
  { label: "OpenAI 官方", base_url: "https://api.openai.com/v1", model: "tts-1", voice: "alloy" },
  { label: "本地服务 (localhost:8880)", base_url: "http://localhost:8880/v1", model: "kokoro", voice: "" },
];

const inputClass =
  "w-full px-3 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none text-sm";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function ApiKeyField({ provider, optional }: { provider: TtsProvider; optional?: boolean }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft("");
    setError(null);
    api.ttsHasApiKey(provider).then(setHasKey).catch(() => setHasKey(null));
  }, [provider]);

  const save = async (key: string | null) => {
    try {
      await api.ttsSetApiKey(provider, key);
      setHasKey(!!key);
      setDraft("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Field
      label="API Key"
      hint={
        error ??
        (hasKey
          ? "已保存在 Windows 凭据管理器中，不会写入配置文件"
          : optional
            ? "未设置（本地服务通常可留空）"
            : "未设置")
      }
    >
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? "•••••••• 已保存，输入新值可替换" : "粘贴你的 API Key"}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => save(draft)}
          disabled={!draft.trim()}
          className="px-3 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 rounded-lg text-sm whitespace-nowrap"
        >
          保存
        </button>
        {hasKey && (
          <button
            type="button"
            onClick={() => save(null)}
            className="px-3 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-sm whitespace-nowrap"
          >
            清除
          </button>
        )}
      </div>
    </Field>
  );
}

export function TtsSettingsPanel({ settings, onChange }: Props) {
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const provider = settings.provider;
  const set = <K extends "sapi" | "openai" | "azure">(key: K, patch: Partial<TtsSettings[K]>) =>
    onChange({ ...settings, [key]: { ...settings[key], ...patch } });

  const loadVoices = async () => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      setVoices(await api.ttsListVoices(settings));
    } catch (e) {
      setVoices([]);
      setVoicesError(String(e));
    } finally {
      setLoadingVoices(false);
    }
  };

  useEffect(() => {
    setVoices([]);
    setVoicesError(null);
    setTestResult(null);
    // Azure voice listing costs a request against the user's key, so it is manual.
    if (provider !== "azure") loadVoices();
  }, [provider]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const url = await api.ttsSynthesize("你好，这是一段测试语音。", settings);
      audioRef.current?.pause();
      audioRef.current = new Audio(url);
      await audioRef.current.play();
      setTestResult("合成成功，正在本机试听");
    } catch (e) {
      setTestResult(String(e));
    } finally {
      setTesting(false);
    }
  };

  const voiceList = (
    <datalist id="tts-voices">
      {voices.map((v) => (
        <option key={v.id} value={v.id}>
          {v.label}
        </option>
      ))}
    </datalist>
  );

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
      <p className="text-xs text-slate-400 bg-slate-900 border border-slate-700 rounded-lg p-3 leading-relaxed">
        本软件为非盈利项目，不提供任何官方模型或密钥。合成请求由本机直接发送到你配置的服务商，
        费用、额度与数据隐私政策以服务商为准。
      </p>

      <div className="grid gap-2" role="radiogroup" aria-label="语音合成服务商">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider === p.id}
            onClick={() => onChange({ ...settings, provider: p.id })}
            className={`text-left px-3 py-2 rounded-lg border transition-colors ${
              provider === p.id
                ? "border-cyan-500 bg-cyan-900/30"
                : "border-slate-600 bg-slate-700 hover:border-slate-500"
            }`}
          >
            <span className="block text-sm font-medium">{p.name}</span>
            <span className="block text-xs text-slate-400">{p.desc}</span>
          </button>
        ))}
      </div>

      {provider === "sapi" && (
        <>
          <Field label="音色" hint={voicesError ?? "可在 Windows 设置 → 时间和语言 → 语音 中安装更多语音包"}>
            <select
              value={settings.sapi.voice ?? ""}
              onChange={(e) => set("sapi", { voice: e.target.value || null })}
              className={inputClass}
            >
              <option value="">系统默认</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`语速：${settings.sapi.rate}`}>
            <input
              type="range"
              min={-10}
              max={10}
              step={1}
              value={settings.sapi.rate}
              onChange={(e) => set("sapi", { rate: parseInt(e.target.value, 10) })}
              className="w-full accent-cyan-500"
            />
          </Field>
        </>
      )}

      {provider === "openai" && (
        <>
          <div className="flex flex-wrap gap-2">
            {OPENAI_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() =>
                  set("openai", { base_url: p.base_url, model: p.model, voice: p.voice || settings.openai.voice })
                }
                className="px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Field label="接口地址 (Base URL)" hint="请求会发送到 {Base URL}/audio/speech">
            <input
              value={settings.openai.base_url}
              onChange={(e) => set("openai", { base_url: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="模型">
              <input
                value={settings.openai.model}
                onChange={(e) => set("openai", { model: e.target.value })}
                placeholder="tts-1"
                className={inputClass}
              />
            </Field>
            <Field label="音色">
              <input
                list="tts-voices"
                value={settings.openai.voice}
                onChange={(e) => set("openai", { voice: e.target.value })}
                placeholder="alloy"
                className={inputClass}
              />
              {voiceList}
            </Field>
          </div>
          <Field label={`语速：${settings.openai.speed.toFixed(2)}x`}>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={settings.openai.speed}
              onChange={(e) => set("openai", { speed: parseFloat(e.target.value) })}
              className="w-full accent-cyan-500"
            />
          </Field>
          <ApiKeyField provider="openai" optional />
        </>
      )}

      {provider === "azure" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="区域 (Region)" hint="Azure 门户中语音资源的区域">
              <input
                value={settings.azure.region}
                onChange={(e) => set("azure", { region: e.target.value })}
                placeholder="eastasia"
                className={inputClass}
              />
            </Field>
            <Field label="音色" hint={voicesError ?? undefined}>
              <div className="flex gap-1">
                <input
                  list="tts-voices"
                  value={settings.azure.voice}
                  onChange={(e) => set("azure", { voice: e.target.value })}
                  placeholder="zh-CN-XiaoxiaoNeural"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={loadVoices}
                  disabled={loadingVoices}
                  title="从 Azure 获取音色列表（需先保存 API Key）"
                  className="px-2 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-xs whitespace-nowrap"
                >
                  {loadingVoices ? "…" : "获取"}
                </button>
              </div>
              {voiceList}
            </Field>
          </div>
          <Field label={`语速：${settings.azure.rate_percent > 0 ? "+" : ""}${settings.azure.rate_percent}%`}>
            <input
              type="range"
              min={-50}
              max={100}
              step={5}
              value={settings.azure.rate_percent}
              onChange={(e) => set("azure", { rate_percent: parseInt(e.target.value, 10) })}
              className="w-full accent-cyan-500"
            />
          </Field>
          <ApiKeyField provider="azure" />
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg text-sm font-medium"
        >
          {testing ? "合成中…" : "测试合成"}
        </button>
        {testResult && <span className="text-xs text-slate-300 break-all">{testResult}</span>}
      </div>
    </div>
  );
}
