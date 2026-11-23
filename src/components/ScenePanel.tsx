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
    <section className="voice-panel">
      <h2 className="mb-2">场景预设</h2>

      {scenes.length > 0 ? (
        <div className="scene-list">
          {scenes.map((scene) => {
            const active = scene.id === activeScene;
            return (
              <div
                key={scene.id}
                className="scene-row" data-active={active}
              >
                <button
                  onClick={() => onApply(scene)}
                  className="scene-choice"
                  title={`输入: ${scene.input_device || "默认"}\n输出: ${scene.output_device || "默认"}`}
                  aria-pressed={active}
                >
                  <span className="scene-indicator" aria-hidden="true" />{scene.name}
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
        <p className="text-xs text-slate-500 mb-4">暂无场景</p>
      )}

      <div className="scene-form">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="场景名称（同名则覆盖）"
          aria-label="场景名称"
        />
        <button
          onClick={save}
          disabled={!newName.trim()}
          className="voice-button"
        >
          保存场景
        </button>
      </div>
    </section>
  );
}
