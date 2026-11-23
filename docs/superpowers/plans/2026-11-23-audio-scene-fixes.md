# Audio and scene fixes implementation plan

**Goal:** Preserve recordings on failed overwrite and preserve scene settings while changing devices; deliver a Windows acceptance installer.

**Scope:** Based on `cursor/tts-providers-0253`. Keep existing local main edits in the named Git stash. Follow AGENTS.md: bump all application version references to 1.8.0 for this new package (local 1.7.0 installer already exists).

## 1. Scene configuration

- [x] Add `tests/scene-config.test.tsx` using the real App and scene UI, with the Tauri persistence/device boundary simulated.
- [x] Reproduce the failure: applying the meeting preset changes devices, recreates `refreshAudioDevices`, reruns initialization, and saves the previous config after the debounce.
- [x] Make device refresh stable using independent functional setters for input and output selection.
- [x] Run `npm test`: test both idle and running transfer, including focus-triggered refresh. Verify persisted devices, volume, DSP, selected scene, and restarted transfer arguments.

## 2. Recording overwrite

- [x] Add Rust regressions to `src-tauri/src/lib.rs`: invalid base64, destination commit failure, successful overwrite and stale-format cleanup.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml save_audio -- --nocapture` before the fix and confirm original recording loss (two failure tests failed because the original file was missing).
- [x] Decode first; write and sync a temporary file in the recording directory; atomically persist it before removing other formats. Preserve the old recording on write/commit failure.
- [x] Run the full Rust test suite: 22 passed on Windows.

## 3. Package and synchronize

- [x] Update package metadata, lockfiles, frontend footer and both README version references.
- [x] Run `npm test` and `npm run build`.
- [x] Resolve packaging prerequisite: pin `@tauri-apps/api` to 2.10.1 to match locked Rust `tauri` 2.10.3; the previous API 2.12.3 prevented `tauri build` before compilation. Frontend tests passed again after this dependency alignment.
- [x] Build Windows installer with `npm run tauri build` and inspect version/hash/artifacts.
- [x] Smoke test the Windows executable and document remaining hardware checks in `docs/qa/2026-11-23-v1.8.0-acceptance.md`.
- Final delivery: commit the scoped fixes and tests; push `codex/cursor-audio-scene-fixes`; verify remote and local commit equality.

## Acceptance

Automated acceptance covers failure-safe audio file replacement and scene persistence. Real microphone, virtual cable, global hotkeys and third-party paid TTS require live device/provider checks; do not claim those passed without evidence. Do not install/uninstall the audio driver as part of these fixes.
