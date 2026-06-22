# Virtual Voice

> [English](README.en.md) | 中文

<div align="center">

![Logo](logo.png)

**虚拟语音客户端 - Windows 虚拟麦克风应用**

借助 VB-Cable 虚拟麦克风，将录音与实时语音中转至语音软件，帮助语音客服等岗位减少重复话术的工作。

[![版本](https://img.shields.io/badge/version-1.6.0-blue.svg)](https://github.com/czxs1120/Virtual_voice)
[![Tauri](https://img.shields.io/badge/Tauri-2.5.0-2c2255?style=flat&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18.2-61dafb?style=flat&logo=react)](https://react.dev/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**本项目使用 [Trae CN](https://trae.ai)、[Reasonix (Deepseek-V4)](https://www.reasonix.top) 和 [ZCode (GLM5.2)](https://zcode.top) 开发完成。**

</div>

---

## 功能特性

- **录音管理** - 录制、导入、播放、删除语音片段
- **快捷键播放** - 使用 Ctrl+1~9 数字键快速播放录音
- **实时语音中转** - 将麦克风声音实时转发到虚拟音频设备
- **虚拟麦克风支持** - 集成 VB-Audio Virtual Cable 驱动安装/卸载
- **迷你播放器模式** - 可收起为紧凑的悬浮播放器
- **音频设备管理** - 灵活选择输入输出设备
- **播放音量调节** - 支持实时调整播放音量

---

## 界面预览

```
┌─────────────────────────────────────────────────────────────┐
│  Virtual Voice                              虚拟语音客户端   │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  录音片段     │              录音控制                        │
│              │                                              │
│  [录音 1]    │  [开始录音]  [停止播放]  [导入音频]          │
│  [录音 2]    │                                              │
│  [录音 3]    │              实时语音中转                    │
│              │                                              │
│              │  [开启中转]                                   │
│              │                                              │
├──────────────┴──────────────────────────────────────────────┤
│  Ctrl+数字键快速播放  │ 虚拟麦克风: 就绪  │ v1.3.0          │
└─────────────────────────────────────────────────────────────┘
```

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 桌面框架 | [Tauri](https://tauri.app/) 2.5.0 |
| 前端框架 | [React](https://react.dev/) 18.2.0 |
| 语言 | [TypeScript](https://www.typescriptlang.org/) 5.3 |
| 样式 | [Tailwind CSS](https://tailwindcss.com/) 3.4 |
| 后端 | [Rust](https://www.rust-lang.org/) |
| 构建工具 | [Vite](https://vitejs.dev/) 5.1 |

---

## 系统要求

- **操作系统**: Windows 10/11 (64-bit)
- **依赖**: WebView2 Runtime (应用会自动提示安装)

---

## 安装与构建

### 环境准备

1. 安装 Node.js 18+
2. 安装 Rust (推荐使用 [rustup](https://rustup.rs/))
3. 安装 Visual Studio Build Tools (Windows)

### 开发模式

```bash
# 克隆项目
git clone https://github.com/czxs1120/Virtual_voice.git
cd Virtual_voice

# 安装依赖
npm install

# 启动开发服务器
npm run tauri dev
```

### 构建发布版本

```bash
# 构建 Windows 安装包
npm run tauri build
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/nsis/` 目录下。

---

## 使用说明

### 首次使用

1. 启动应用后，前往 **设置** → **音频设备**
2. 点击 **安装驱动** 按钮安装 VB-Audio Virtual Cable 虚拟麦克风驱动
3. 驱动安装完成后可能需要重启计算机

### 录音功能

1. 选择输入设备（麦克风）
2. 点击 **开始录音** 按钮开始录音
3. 可选：设置录音名称和快捷键绑定
4. 点击 **停止录音** 保存录音

### 快捷键播放

- 在录音列表中，选择 Ctrl+1~9 数字绑定
- 按下对应 Ctrl+数字键 即可快速播放录音

### 实时语音中转

1. 选择输出设备（VB-Audio Virtual Cable）
2. 点击 **开启中转** 按钮
3. 此时其他应用（如 Discord、Teams 等）可以将输入源切换到 VB-Audio 设备来接收语音

---

## 目录结构

```
virtual_voice/
├── src/                    # React 前端源码
│   ├── App.tsx            # 主应用组件
│   ├── main.tsx           # 入口文件
│   └── index.css          # 全局样式
├── src-tauri/              # Tauri 后端源码
│   ├── src/
│   │   ├── main.rs        # Rust 主入口
│   │   ├── lib.rs         # 库文件
│   │   └── driver.rs      # 驱动安装逻辑
│   ├── Cargo.toml         # Rust 依赖配置
│   ├── tauri.conf.json    # Tauri 配置文件
│   └── drivers/           # 虚拟驱动文件
├── package.json           # Node.js 依赖配置
├── vite.config.ts         # Vite 配置
└── tailwind.config.js     # Tailwind CSS 配置
```

---

## License

本项目基于 [MIT License](LICENSE) 开源。

---

## 致谢

- [Tauri](https://tauri.app/) - 优秀的跨平台桌面应用框架
- [VB-Audio Software](https://vb-audio.com/) - 提供 Virtual Cable 虚拟音频驱动
- [Trae CN](https://trae.ai) - AI 编程助手
- [Reasonix](https://www.reasonix.top) - 基于 Deepseek-V4 的 AI 助手
- [ZCode](https://zcode.top) - 基于 GLM5.2 的 AI 编程助手
