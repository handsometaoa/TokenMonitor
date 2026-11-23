# TokenMonitor

Windows 托盘版 OpenCode Go 余量监控，参考 [CodexBar](https://github.com/steipete/CodexBar) 的产品设计，使用 Electron + React 独立实现。

![Overview](docs/screenshots/overview.png)

## 功能

- **OpenCode Go 三窗口余量**：5 小时、每周、每月；显示剩余/已用百分比、重置倒计时、限流状态。
- **pace 节奏预测**：按窗口时间进度比较实际消耗，提示“余量充足 / 节奏正常 / 偏快”。
- **本地 token 统计**：只读 OpenCode SQLite，按今日 / 7 天 / 30 天 / 全部展示 token、会话、模型排行。
- **模型速度趋势**：可选开启本地测速代理，记录 TTFT 与 tok/s（实验性）。
- **Windows 原生体验**：系统托盘、flyout 面板、Toast 通知、开机自启、单实例、深色/浅色主题。
- **隐私优先**：凭证用 Windows DPAPI 加密；不读取 prompt、回复、工具输出或其他 Provider 的 Key；不接入遥测。

![Speed](docs/screenshots/speed.png)

## 安装 / 运行

开发：

```bash
npm install
npm run dev
```

构建 Windows 安装包：

```bash
npm run dist:win
```

产物在 `release/`。当前安装包未签名，Windows SmartScreen 可能提示；选择“更多信息 → 仍要运行”。

> macOS 代码保持跨平台，但本项目当前只产出 Windows 安装包；macOS 需要在 macOS/CI 上构建。

## 首次使用

1. 打开 [OpenCode 控制台](https://opencode.ai/auth) 创建 API Key。
2. 在引导页粘贴 Key，点击“测试并保存”；也可以尝试检测本机 `auth.json`。
3. 本地 token 统计默认开启，会自动读取：
   - Windows：`%USERPROFILE%\.local\share\opencode\opencode.db`
   - macOS：`~/.local/share/opencode/opencode.db`
4. 需要更细的模型速度数据时，在“设置 → 精确测速”中启用测速代理。

本机如果只有其他 Provider 的凭证（例如 DeepSeek），不会被读取或展示；必须使用 OpenCode Go 的 Key。

## 精确测速（实验性）

精确测速不是 CodexBar 的原有功能，是本项目的扩展：

- 应用在 `127.0.0.1` 启动一个本地反向代理，记录请求时间、TTFT、流式输出时长和上游 usage。
- 需要在 OpenCode 配置里把 Go Provider 的 `baseURL` 指向本机代理，并把设置页生成的配置片段合并进去。
- **应用退出后代理会停止**；如果配置仍指向代理，OpenCode 请求会失败。退出前请恢复原配置，或先关闭测速。
- 代理只记录模型、时间、token 数；不落盘 prompt、回复、Authorization 或工具输出。
- OpenCode 不同版本可能使用 `provider` 或 `providers` 配置结构，且 Provider ID 可能是 `opencode` 或 `opencode-go`；设置页会同时给出两种片段。
- 如果上游不返回 usage，样本不会被标记为精确 tok/s。

## 数据与隐私

应用数据目录：

```
%APPDATA%\TokenMonitor\
├─ settings.json
├─ secret.bin              # DPAPI 加密
├─ quota-history\          # 90 天额度快照
├─ speed-samples\          # 90 天测速样本
└─ logs\                   # 脱敏日志
```

- 额度请求：`https://opencode.ai/zen/go/v1/usage`（未公开接口，可能随上游变化）。
- 本地统计只读取 `message` / `session_message` 的元数据；不读取 `part` 正文、`session_input.prompt`、工具输出或 `auth.json` 中的其他 Provider。
- 不显示金额/余额；OpenCode 的额度接口只返回百分比。CodexBar 的成本能力没有移植。
- 本项目不是 OpenCode 或 CodexBar 的官方工具。

## 开发

```bash
npm run dev          # electron-vite 开发
npm run typecheck    # 主进程 + 渲染进程类型检查
npm test             # Vitest：API、pace、SQLite 聚合、测速代理
npm run build        # 构建 out/
npm run dist:win     # Windows NSIS 安装包
```

演示模式：

```bash
# Git Bash
TOKENMONITOR_DEMO=1 npm run dev

# PowerShell
$env:TOKENMONITOR_DEMO=1; npm run dev

# 已安装/解包的应用
TokenMonitor.exe --demo
```

演示模式使用模拟额度、模拟本地用量和模拟测速数据，不访问真实 API。

目录：

```
src/main/             Electron 主进程：API、凭证、SQLite、托盘、代理
src/preload/          contextBridge 白名单
src/renderer/         React + Tailwind 界面
src/shared/           共享类型与 IPC 定义
tests/                单元与集成测试
scripts/              图标、数据库检查、UI 冒烟脚本
resources/icons/      应用与托盘图标
```

### 下载 Electron 很慢？

如果 `npm install` 卡在 Electron 二进制下载，可以使用镜像：

```bash
# Git Bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
```

## 已知限制

- OpenCode Go 的 usage 接口未公开，未来可能变更。
- 首版只支持 OpenCode Go；Command Code、Codex、Claude 等 Provider 尚未接入。
- 不显示金额、余额或 credits。
- 精确测速需要手动修改 OpenCode 配置，属于实验性功能；目前支持 HTTP/SSE，不支持 WebSocket 传输的测速。
- 测速的“精确”指请求计时和上游 usage；如果上游不返回 usage，样本不会进入 tok/s 图表。
- Windows 安装包未签名；macOS 未提供首版构建。
- 本地数据库可能是 v1（`message`）或 v2（`session_message`）；混合迁移库按 message id 去重，但仍建议保留 OpenCode 原库，不要用本工具修改它。

## 归属

设计灵感与数据源行为参考 [CodexBar](https://github.com/steipete/CodexBar)（MIT）。本项目与 OpenCode、CodexBar 无隶属关系。

License: MIT，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
