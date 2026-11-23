// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../src/App";
import { api } from "../src/lib/api";
import { DEFAULT_CONFIG, DEFAULT_DSP, type AppConfig } from "../src/types";

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
