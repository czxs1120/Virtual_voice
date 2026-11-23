// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../src/App";
import { api } from "../src/lib/api";
import { DEFAULT_CONFIG, DEFAULT_DSP, type AppConfig } from "../src/types";
import { getCurrentWindow } from "@tauri-apps/api/window";

vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/window")>(),
  getCurrentWindow: vi.fn(() => ({
    setSize: vi.fn(), setMinSize: vi.fn(), setSizeConstraints: vi.fn(),
    setAlwaysOnTop: vi.fn(), setResizable: vi.fn(), center: vi.fn(),
  })),
}));
vi.mock("../src/lib/api", () => ({
  api: {
    getConfig: vi.fn(), saveConfig: vi.fn(), getRecordings: vi.fn(),
    getAudioDevices: vi.fn(), getAudioInputDevices: vi.fn(),
    isVbcableInstalled: vi.fn(), isTransferRunning: vi.fn(),
    startTransfer: vi.fn(), stopTransfer: vi.fn(), getTransferLevels: vi.fn(),
  },
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(), unregisterAll: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

let diskConfig: AppConfig;

beforeEach(() => {
  vi.clearAllMocks();
  diskConfig = structuredClone({
    ...DEFAULT_CONFIG,
    input_device: "Mic A", output_device: "Output A",
    scenes: [{
      id: "meeting", name: "会议", input_device: "Mic B", output_device: "Output B",
      enable_monitoring: false, playback_volume: 0.35,
      dsp: { ...DEFAULT_DSP, gain_db: 6, gate_enabled: true },
    }],
  });
  // Model the real persistence boundary: reads return the last saved config,
  // not the frontend's pending changes during its 400ms debounce window.
  vi.mocked(api.getConfig).mockImplementation(async () => structuredClone(diskConfig));
  vi.mocked(api.saveConfig).mockImplementation(async (next) => {
    diskConfig = structuredClone(next);
  });
  vi.mocked(api.getRecordings).mockResolvedValue([]);
  vi.mocked(api.getAudioDevices).mockResolvedValue([
    { name: "Output A", is_default: true }, { name: "Output B", is_default: false },
  ]);
  vi.mocked(api.getAudioInputDevices).mockResolvedValue([
    { name: "Mic A", is_default: true }, { name: "Mic B", is_default: false },
  ]);
  vi.mocked(api.isVbcableInstalled).mockResolvedValue("NotInstalled");
  vi.mocked(api.isTransferRunning).mockResolvedValue(false);
  vi.mocked(api.getTransferLevels).mockResolvedValue({ input_db: -100, output_db: -100, gate_open: false });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
});

afterEach(cleanup);

test("recording search filters within the selected group", async () => {
  vi.mocked(api.getRecordings).mockResolvedValue([
    { id: 1, name: "开始检录", group: "检录", key_binding: 1, path: "", duration_ms: 4200 },
    { id: 2, name: "核对证件", group: null, key_binding: 2, path: "", duration_ms: 5000 },
  ]);
  render(<App />);
  await screen.findByRole("button", { name: "播放 开始检录" });
  fireEvent.click(screen.getByRole("button", { name: "未分组", exact: true }));
  expect(screen.queryByRole("button", { name: "播放 开始检录" })).toBeNull();
  expect(screen.getByRole("button", { name: "播放 核对证件" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索录音片段" }), { target: { value: "开始" } });
  expect(screen.getByText("没有匹配的录音")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部", exact: true }));
  expect(screen.getByRole("button", { name: "播放 开始检录" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "播放 核对证件" })).toBeNull();
});

test("compact player allows width changes and clears its height limit on expand", async () => {
  const mockWindow = getCurrentWindow();
  vi.mocked(getCurrentWindow).mockReturnValue(mockWindow);
  render(<App />);
  await waitFor(() => expect(api.isTransferRunning).toHaveBeenCalled());
  fireEvent.click(screen.getByTitle("收起为迷你播放器"));
  fireEvent.click(await screen.findByTitle("展开完整窗口"));
  await screen.findByTitle("收起为迷你播放器");
  expect(mockWindow.setResizable).not.toHaveBeenCalledWith(false);
  expect(mockWindow.setSizeConstraints).toHaveBeenNthCalledWith(1, {
    minWidth: 320, minHeight: 70, maxHeight: 70,
  });
  expect(mockWindow.setSizeConstraints).toHaveBeenNthCalledWith(2, {
    minWidth: 400, minHeight: 100,
  });
});

test.each([false, true])("scene settings survive device changes and refresh (transfer running: %s)", async (running) => {
  vi.mocked(api.isTransferRunning).mockResolvedValue(running);
  render(<App />);
  const scene = await screen.findByRole("button", { name: "会议" });
  await waitFor(() => expect(api.isTransferRunning).toHaveBeenCalled());
  // Let initial device discovery settle before applying the preset.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  fireEvent.click(scene);
  fireEvent.focus(window);
  await waitFor(() => expect(diskConfig.active_scene).toBe("meeting"));
  expect(diskConfig).toMatchObject({
    input_device: "Mic B", output_device: "Output B", enable_monitoring: false,
    playback_volume: 0.35, dsp: { gain_db: 6, gate_enabled: true },
  });
  expect(scene.getAttribute("aria-pressed")).toBe("true");
  expect((screen.getAllByRole("slider")[0] as HTMLInputElement).value).toBe("0.35");
  if (running) {
    expect(api.stopTransfer).toHaveBeenCalledOnce();
    expect(api.startTransfer).toHaveBeenCalledWith("Output B", "Mic B", {
      ...DEFAULT_DSP, gain_db: 6, gate_enabled: true,
    });
  }
});
