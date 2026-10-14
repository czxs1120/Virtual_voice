# Virtual Voice

> English | [中文](README.md)

<div align="center">

![Logo](logo.png)

**Virtual Voice Client - Windows Virtual Microphone Application**

Using VB-Cable virtual microphone, forward recordings and real-time voice to voice software, helping voice customer service and similar positions reduce repetitive speech work.

[![Version](https://img.shields.io/badge/version-1.6.0-blue.svg)](https://github.com/czxs1120/Virtual_voice)
[![Tauri](https://img.shields.io/badge/Tauri-2.5.0-2c2255?style=flat&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18.2-61dafb?style=flat&logo=react)](https://react.dev/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**This project is developed using [Trae CN](https://trae.ai), [Reasonix (Deepseek-V4)](https://www.reasonix.top), and [ZCode (GLM5.2)](https://zcode.top).**

</div>

---

## Features

- **Recording Management** - Record, import, play, and delete audio clips
- **Keyboard Shortcuts** - Bind F1–F12 or Ctrl/Alt/Shift combos per clip (global, work when unfocused; conflicts are rebound automatically)
- **Groups** - Collapsible, searchable recording groups
- **Waveform Trim** - Waveform preview, drag-to-trim, one-click silence removal
- **Real-time Voice Transfer** - Forward microphone audio to virtual audio devices, with gain, noise gate, limiter, and level meters
- **Scene Presets** - Save device + audio setting combinations and switch in one click
- **System Tray** - Close hides to tray; tray menu can stop playback / toggle transfer
- **Virtual Microphone Support** - Integrated VB-Audio Virtual Cable driver installation/uninstallation
- **Mini Player Mode** - Collapsible compact floating player
- **Audio Device Management** - Flexible input/output device selection
- **Playback Volume Control** - Real-time playback volume adjustment

---

## Interface Preview

```
┌─────────────────────────────────────────────────────────────┐
│  Virtual Voice                          Virtual Voice       │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  Recordings  │              Recording Controls              │
│              │                                              │
│  [Clip 1]    │  [Start Recording]  [Stop]  [Import Audio]   │
│  [Clip 2]    │                                              │
│  [Clip 3]    │              Real-time Voice Transfer        │
│              │                                              │
│              │  [Start Transfer]                            │
│              │                                              │
├──────────────┴──────────────────────────────────────────────┤
│  Ctrl+Number Keys Quick Play  │ Virtual Mic: Ready  │ v1.3.0│
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Category | Technology |
|----------|------------|
| Desktop Framework | [Tauri](https://tauri.app/) 2.5.0 |
| Frontend Framework | [React](https://react.dev/) 18.2.0 |
| Language | [TypeScript](https://www.typescriptlang.org/) 5.3 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) 3.4 |
| Backend | [Rust](https://www.rust-lang.org/) |
| Build Tool | [Vite](https://vitejs.dev/) 5.1 |

---

## System Requirements

- **Operating System**: Windows 10/11 (64-bit)
- **Dependencies**: WebView2 Runtime (will be prompted automatically)

---

## Installation & Build

### Prerequisites

1. Install Node.js 18+
2. Install Rust (recommended via [rustup](https://rustup.rs/))
3. Install Visual Studio Build Tools (Windows)

### Development Mode

```bash
# Clone the project
git clone https://github.com/czxs1120/Virtual_voice.git
cd Virtual_voice

# Install dependencies
npm install

# Start development server
npm run tauri dev
```

### Build for Release

```bash
# Build Windows installer
npm run tauri build
```

After building, the installer is located in `src-tauri/target/release/bundle/nsis/`.

---

## Usage

### First Time Setup

1. After launching the app, go to **Settings** → **Audio Devices**
2. Click **Install Driver** to install VB-Audio Virtual Cable
3. A system restart may be required after driver installation

### Recording

1. Select an input device (microphone)
2. Click **Start Recording** to begin recording
3. Optional: Set a recording name and keyboard shortcut
4. Click **Stop Recording** to save

### Keyboard Shortcuts

- Click a clip's hotkey box and press the desired combination (F1–F12 alone, letters/digits need Ctrl/Alt/Shift)
- Esc cancels capture; Backspace/Delete clears the binding
- Legacy Ctrl+1~9 bindings are migrated automatically

### Real-time Voice Transfer

1. Select an output device (VB-Audio Virtual Cable)
2. Click **Start Transfer**
3. Other applications (e.g., Discord, Teams) can now select VB-Audio as their input device
4. Adjust gain, enable the noise gate (removes keyboard noise / hiss) and limiter (prevents clipping); changes apply live

### Scene Presets

Once devices, monitoring, volume, and transfer settings are tuned, save them under a name in **Scene Presets** and click it to switch later.

### Driver Notes

VB-CABLE is donationware from VB-Audio; check its license before redistributing it with a product. Any other virtual audio device
(VoiceMeeter, Virtual Audio Cable, etc.) can be selected as the output instead. See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Project Structure

```
virtual_voice/
├── src/                    # React frontend source
│   ├── App.tsx            # Main application component
│   ├── main.tsx           # Entry point
│   └── index.css          # Global styles
├── src-tauri/              # Tauri backend source
│   ├── src/
│   │   ├── main.rs        # Rust main entry
│   │   ├── lib.rs         # Recording, playback, transfer, config
│   │   ├── dsp.rs         # Transfer gain / noise gate / limiter
│   │   ├── tray.rs        # System tray
│   │   └── driver.rs      # Driver installation logic
│   ├── Cargo.toml         # Rust dependency configuration
│   ├── tauri.conf.json    # Tauri configuration
│   └── drivers/           # Virtual driver files
├── package.json           # Node.js dependency configuration
├── vite.config.ts         # Vite configuration
└── tailwind.config.js     # Tailwind CSS configuration
```

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Acknowledgments

- [Tauri](https://tauri.app/) - Excellent cross-platform desktop framework
- [VB-Audio Software](https://vb-audio.com/) - Virtual Cable driver provider
- [Trae CN](https://trae.ai) - AI programming assistant
- [Reasonix](https://www.reasonix.top) - AI assistant based on Deepseek-V4
- [ZCode](https://zcode.top) - AI programming assistant based on GLM5.2
