import { useState } from "react";
import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  activeScene: string | null;
  onApply: (scene: Scene) => void;
  onSaveCurrent: (name: string, overwriteId?: string) => void;
  onDelete: (id: string) => void;
}

export function ScenePanel({ scenes, activeScene, onApply, onSaveCurrent, onDelete }: Props) {
  const [newName, setNewName] = useState("");

  const save = () => {
    const name = newName.trim();
    if (!name) return;
    const existing = scenes.find((s) => s.name === name);
    onSaveCurrent(name, existing?.id);
    setNewName("");
  };

  return (
    <section className="bg-slate-800 rounded-xl p-6 border border-slate-700">
      <h3 className="text-lg font-semibold mb-1">场景预设</h3>
      <p className="text-slate-400 text-sm mb-4">
        保存当前的输入/输出设备、监听开关、播放音量和中转处理参数，一键切换（如“开黑”“会议”“直播”）。
      </p>

      {scenes.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-4">
          {scenes.map((scene) => {
            const active = scene.id === activeScene;
            return (
              <div
                key={scene.id}
                className={`group flex items-center rounded-lg border ${
                  active ? "border-cyan-500 bg-cyan-900/40" : "border-slate-600 bg-slate-700"
                }`}
              >
                <button
                  onClick={() => onApply(scene)}
                  className="px-3 py-1.5 text-sm hover:text-cyan-300"
                  title={`输入: ${scene.input_device || "默认"}\n输出: ${scene.output_device || "默认"}`}
                  aria-pressed={active}
                >
                  {scene.name}
                </button>
                <button
                  onClick={() => onDelete(scene.id)}
                  className="px-2 py-1.5 text-slate-500 hover:text-red-400"
                  title={`删除场景「${scene.name}」`}
                  aria-label={`删除场景 ${scene.name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mb-4">还没有场景，先调好设备和参数再保存。</p>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="场景名称（同名则覆盖）"
          className="flex-1 px-3 py-2 bg-slate-700 rounded-lg border border-slate-600 focus:border-cyan-500 focus:outline-none text-sm"
        />
        <button
          onClick={save}
          disabled={!newName.trim()}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 rounded-lg text-sm font-medium"
        >
          保存当前为场景
        </button>
      </div>
    </section>
  );
}
