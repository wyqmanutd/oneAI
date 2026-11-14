[English](README.md) | **简体中文**

# OneAI

**一个桌面工作台，管理所有 AI 编程 CLI。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![Electron 31](https://img.shields.io/badge/Electron-31-47848f)

OneAI 把 Codex、Claude Code、Kimi Code、OpenCode 等 AI 编程 CLI 放进同一个窗口并排运行，每个任务都是独立的真实终端。切换任务和文件夹时会话不会中断，额度、用量和账号一目了然。

## 为什么做 OneAI

同时使用多个 AI 编程 CLI，通常意味着一堆终端窗口：分不清哪个还在跑、每个登录的是哪个账号、额度还剩多少。OneAI 把它们放进同一个侧栏，按项目文件夹分组，你在一个任务里工作时，其他终端仍在后台继续运行。

## 亮点

- **文件夹树与多任务**：任务按项目文件夹分组，每个任务有状态灯、Git 分支徽标和会话里最近一条消息；后台任务输出停下后会显示「待查看」。
- **保活终端**：基于 xterm.js 与 Windows ConPTY（`node-pty`），切换任务或文件夹不会结束任何进程。
- **单行实时额度**：顶栏用一行文字显示 Tokens、Cost、5h / 7d 额度和当前模型，另有 CPU、内存和网速；只有纯文字，没有弹窗。
- **多账号**：Codex、Claude Code、Kimi Code 可并行使用多个账号。账号只是「配置目录 + 环境变量」，OneAI 不读取、不复制你的登录凭据。
- **本周用量面板**：按 CLI、账号、模型统计请求数与 Tokens，附近 26 周每日活跃方块图，数据来自本机会话记录。
- **历史会话**：浏览并恢复 Claude Code、Codex、Kimi Code 的历史会话。
- **文件预览**：在终端里按住 Ctrl 单击路径，即可只读预览文件，并带代码缩略图。
- **任意 CLI**：按 `PATH` 自动检测已安装的 CLI，其他命令可添加为自定义 CLI。
- **简体中文与英文**、20 个主题（浅色、深色、护眼与编辑器配色），以及简短的首次引导。

每项功能的详细行为见 [docs/features.zh-CN.md](docs/features.zh-CN.md)。

## 支持的 CLI

启动时，OneAI 按你的 `PATH` 查找下列命令，只提供找到的 CLI。清单在 [`src/main/known-clis.json`](src/main/known-clis.json)，「设置 → CLI」会显示每个 CLI 的检测状态。

Codex、Claude Code、Kimi Code、OpenCode、Grok Build、Antigravity、Qwen Code、Aider、Cursor Agent、GitHub Copilot、Amp、Droid、Crush、Goose、iFlow CLI、Auggie、Kiro CLI、Cline、Pi。

不在清单里的 CLI，可在「设置 → CLI」填写名称和启动命令添加。所有 CLI 都在普通终端里运行，额外功能取决于各 CLI 的本机会话格式：

| | 额度 | 任务摘要与历史会话 | 用量统计 | 多账号 |
| --- | :---: | :---: | :---: | :---: |
| Codex | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 支持 | 支持 |
| Kimi Code | 支持 | 支持 | 暂不支持 | 支持 |
| Antigravity、Pi | | | 支持 | |
| 其他 CLI 与自定义 CLI | | | | |

## 安装

OneAI 支持 **Windows 10 / 11（x64）**。`feat/macos-apple-silicon` 分支新增了**实验性的 macOS Apple Silicon（arm64）**支持。Windows 使用 ConPTY，macOS 使用 Unix PTY 和用户的登录 Shell。各 AI CLI 本身不随 OneAI 分发：请自行安装需要的 CLI，并确认它们的命令在 `PATH` 中。

- **安装包**：从[最新发布](https://github.com/keepingFE/oneAI/releases/latest)下载 `OneAI-Setup-<version>.exe` 并运行。
- **macOS arm64 测试版**：可在 Apple Silicon Mac 上运行 `npm run build:mac`，也可在此分支的 [macOS 构建工作流](https://github.com/wyqmanutd/oneAI/actions/workflows/macos-arm64.yml)通过后下载未签名构建产物；尚非经过 Apple 公证的正式发行版。
- **从源码构建**：见下文。

首次启动时，OneAI 会请你选择界面语言，再显示一段简短的引导。之后添加项目文件夹，点文件夹右侧的「+」选择 CLI 即可。

## 从源码构建

需要 Node.js 18 或更高版本。

```bash
npm install
npm run dev              # 开发模式启动工作台
npm run build            # 类型检查并构建
npm run build:win        # 安装版：release/OneAI-Setup-<version>.exe
npm run build:portable   # 便携版（可选）：release/OneAI-Portable-<version>.exe
npm run build:mac        # 在 Apple Silicon 上生成 release/OneAI-<version>-mac-arm64.dmg 和 .zip
```

macOS 注意事项：首先安装 Xcode Command Line Tools 与 Node.js 22.12+（推荐 Node.js 24）。macOS 打包时会针对 Electron arm64 重编译原生 `node-pty` 模块，并修复 `spawn-helper` 可执行权限；Windows 打包配置保持不变。当前 macOS 测试版未签名、未公证，首次打开可能需要在系统设置中手动允许。通过 Finder 启动时，OneAI 会读取登录 Shell 的 `PATH` 来查找 CLI。macOS 的应用快捷键及复制粘贴使用 Command，**Ctrl+Tab** 仍用于切换任务（Command+Tab 是系统切换应用快捷键），终端中的 Ctrl+C 用于中断命令。

旧产物被占用、无法覆盖时，可将新产物写入独立目录：

```bash
npm run build:win -- --config.directories.output=release/ui-polish
```

### 检查

```bash
npm run check:ui     # 在隐藏的 Electron 窗口里做界面回归检查（主题、布局、键盘、终端、设置、首次引导）
npm run check:i18n   # 每条界面文案都有英文译文
```

检查产物写入 `.tmp/ui-polish/`。

## 技术栈

Electron 31、React 18、TypeScript、Tailwind CSS、Lucide React、`@xterm/xterm`、`node-pty`、Vite 5 与 `vite-plugin-electron`。

## 隐私

OneAI 在本机运行，没有遥测和统计，也没有更新检查。它读取你所用 CLI 的本机会话文件来显示历史、摘要和用量，不读取、不复制登录凭据。OneAI 自己发起的网络请求只有 Kimi Code 的额度查询（`api.kimi.com`），使用你自己的 Kimi Code 登录，并且只在使用 Kimi Code 时发生。你在终端里启动的各 CLI 照常访问它们自己的服务。

## 参与贡献

欢迎提交 Issue 和 Pull Request。项目约定、目录结构和检查方式见 [AGENTS.md](AGENTS.md)。要点：commit 信息使用英文，所有界面文案都要经过 `t()` 并在 `src/shared/en.ts` 里登记英文，`npm run check:ui` 与 `npm run check:i18n` 应通过。

## 许可证

[MIT](LICENSE)
