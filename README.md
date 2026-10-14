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
- **快捷键播放** - 为每条录音绑定 F1–F12 或 Ctrl/Alt/Shift 组合键（全局热键，应用失焦时也可用，冲突自动改绑）
- **分组管理** - 录音按分组折叠展示，支持搜索
- **波形裁剪** - 波形预览、拖拽裁剪、一键去除首尾静音
- **实时语音中转** - 将麦克风声音实时转发到虚拟音频设备，带增益、噪声门、限幅和电平表
- **场景预设** - 保存设备与音频参数组合，一键切换
- **系统托盘** - 关闭窗口最小化到托盘，托盘菜单可停止播放 / 开关中转
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

- 在录音列表中点击热键框，按下想要的组合键（F1–F12 可单独使用，字母/数字需配合 Ctrl/Alt/Shift）
- 按 Esc 取消录入，Backspace/Delete 清除绑定
- 旧版本的 Ctrl+1~9 绑定会自动迁移

### 实时语音中转

1. 选择输出设备（VB-Audio Virtual Cable）
2. 点击 **开启中转** 按钮
3. 此时其他应用（如 Discord、Teams 等）可以将输入源切换到 VB-Audio 设备来接收语音
4. 可按需调整增益、开启噪声门（过滤键盘声和底噪）与限幅（防止爆音），中转过程中实时生效

### 场景预设

调好输入/输出设备、监听、音量和中转参数后，在“场景预设”中输入名称保存；之后点击场景名即可一键切换。

### 驱动说明

VB-CABLE 为 VB-Audio 的捐赠软件，随产品分发前请确认其许可条款。也可以使用 VoiceMeeter、Virtual Audio Cable 等其他虚拟声卡，
在“设置 → 音频设备”中选择对应输出即可。详见 [docs/ROADMAP.md](docs/ROADMAP.md)。

---

## 目录结构

```
virtual_voice/
├── src/                    # React 前端源码
│   ├── App.tsx            # 主应用编排
│   ├── components/        # UI 组件（列表、设置、迷你播放器）
│   ├── hooks/             # 状态消息、全局热键等 hooks
│   ├── lib/               # Tauri API 封装、WAV 编解码
│   ├── types.ts           # 共享类型
│   ├── main.tsx
│   └── index.css
├── src-tauri/              # Tauri 后端源码
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs         # 录音/播放/中转/配置
│   │   ├── dsp.rs         # 中转增益/噪声门/限幅
│   │   ├── tray.rs        # 系统托盘
│   │   └── driver.rs      # VB-CABLE 驱动管理
│   ├── capabilities/      # 权限（含 Windows 全局热键）
│   ├── resources/drivers/ # 虚拟驱动资源
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── tailwind.config.js
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
