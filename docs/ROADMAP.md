# Virtual Voice 升级计划表

状态说明：✅ 已完成 · 🚧 进行中 · ⏸ 待外部条件 · 📋 规划中

| # | 方向 | 内容 | 状态 | 涉及模块 | 依赖 / 阻塞 |
|---|------|------|------|----------|-------------|
| 1 | 全局热键 + 系统托盘 | 应用失焦时热键可用；托盘菜单（显示/停止播放/开关中转/退出）；关闭窗口最小化到托盘 | ✅ | `src-tauri/src/tray.rs`、`hooks/useGlobalHotkeys.ts`、`hooks/useTrayEvents.ts` | 无 |
| 2 | 分组与更多绑定 | 录音分组（可折叠、可搜索）；F1–F12 与 Ctrl/Alt/Shift 组合键；冲突检测并自动改绑；兼容旧 `key_binding` | ✅ | `lib/hotkeys.ts`、`components/HotkeyInput.tsx`、`components/RecordingList.tsx` | 无 |
| 3 | 波形预览与裁剪 | 波形显示、拖拽选择起止点、一键去除首尾静音、试听、覆盖保存 | ✅ | `components/WaveformEditor.tsx`、`lib/audioEdit.ts` | 无 |
| 4 | 场景配置 | 保存“输入/输出设备 + 监听 + 播放音量 + 中转处理参数”为命名场景，一键切换；中转进行中自动重启到新设备 | ✅ | `components/ScenePanel.tsx`、`AppConfig.scenes` | 无 |
| 5 | 音频管线质量 | 中转链路加入增益、噪声门（带保持/平滑）、峰值限幅；实时电平表；参数可在中转中实时调整 | ✅ | `src-tauri/src/dsp.rs`、`components/TransferDspPanel.tsx` | 后续：用 sinc/多相重采样替换线性插值、可选 RNNoise 降噪 |
| 6 | TTS / 话术合成 | 输入文字生成语音并保存为录音；服务商由用户自行配置：Windows 系统语音（免费离线）、OpenAI 兼容接口（含本地部署）、Azure | ✅ | `src-tauri/src/tts.rs`、`src-tauri/src/secrets.rs`、`components/TtsPanel.tsx`、`components/TtsSettingsPanel.tsx` | 不提供官方模型或密钥；后续可按需增加更多服务商 |
| 7 | 多语言 / 无障碍 | 中/英界面切换；按钮补齐 `aria-label`、键盘可达、焦点样式 | 📋 | 计划：`react-i18next` 或轻量字典 + 文案抽取 | 无硬性阻塞，属于文案改动面较大的重构 |
| 8 | 自动更新 | 启动检查更新、增量下载、签名校验 | ⏸ | 计划：`tauri-plugin-updater` + GitHub Releases `latest.json` | 需生成并保管更新签名私钥；需 CI 发布流程（Windows runner） |
| 9 | 替代 / 补充虚拟驱动 | 驱动合规说明；支持任意虚拟声卡（VoiceMeeter、VAC 等）作为输出 | 🚧 | 本文“驱动与合规”一节；设备选择已支持任意输出设备 | 自研驱动需 EV 代码签名证书与微软签名，成本高 |

## 已落地的改动

- **托盘**：左键单击托盘图标显示窗口；关闭按钮改为隐藏到托盘，通过托盘菜单“退出”才真正退出；托盘“停止播放/开关中转”会同步到前端状态。
- **热键**：修复全局热键在按下和松开时各触发一次（导致刚播放就被停止）的问题，现仅在按下时触发。
- **裁剪**：自动去静音阈值 -45 dBFS，首尾各保留 80 ms；保存后覆盖原文件并更新时长。
- **DSP**：默认开启 -1 dBFS 限幅、关闭噪声门；参数以原子量存储，音频线程无锁读取。
- **TTS**：项目不内置任何模型或密钥，用户自行选择服务商。API Key 存在 Windows 凭据管理器，只写不读（前端只能设置/清除/查询是否已设置），不进入 `config.json`；请求由本机直连服务商，支持系统代理环境变量；单次最多 5000 字；试听后保存会复用同一次合成结果，避免重复计费。
- **场景**：场景中的设备不存在时保留当前设备并提示；手动修改中转参数会取消“当前场景”高亮。

## 验证情况

- `cargo test`：19 个单元测试（base64、重采样、下混、DSP、配置兼容与场景序列化、TTS 请求构造/转义/校验）通过；`cargo check --target x86_64-pc-windows-gnu` 通过。
- `npx tsc --noEmit`、`npm run build` 通过。
- 云端为 Linux 环境，**无法验证** VB-CABLE 驱动、真实音频中转、全局热键与 Windows 托盘行为，需在 Windows 上手动回归。

## 驱动与合规

本应用本身不实现虚拟声卡驱动，而是把声音输出到系统中已存在的虚拟音频设备。

- **VB-Audio Virtual Cable** 是 VB-Audio Software 的捐赠软件（donationware），个人使用免费。
  将其安装包**随软件分发或集成到商业产品**之前，请先阅读其官方许可并按需联系 VB-Audio 获取授权
  （见 <https://vb-audio.com/Cable/>）。若无法确认授权，建议改为引导用户从官网自行下载安装。
- **可替代的输出设备**（在“设置 → 音频设备”中直接选择即可，无需改代码）：
  - VB-Audio VoiceMeeter（同一厂商，捐赠软件，带混音器）
  - Virtual Audio Cable（Eugene Muzychenko，商业授权）
  - 声卡厂商自带的“立体声混音 / Stereo Mix”或硬件环回
- **自研驱动**：可参考 Windows Driver Kit 的 SysVAD 示例实现虚拟麦克风，但发布需要 EV 代码签名证书
  并通过微软硬件开发者中心签名，成本和维护负担都较高，仅在需要完全自主分发时考虑。
