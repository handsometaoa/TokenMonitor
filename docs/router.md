# AI Router（本地网关）

TokenMonitor 在原有 OpenCode 余量监控之外，增加了一个本地 AI 网关，产品范围参考 [ai-router](https://github.com/q2316367743/ai-router)：三协议入口、提供商/模型渠道、负载均衡与故障转移、请求日志、用量统计、余量策略。

## 快速开始

主面板首屏「总览」聚合网关状态、今日请求/Tokens、所有 Provider 余量摘要、路由健康、近 7 天用量和最近请求；OpenCode 只是其中一个 Provider。

1. 托盘菜单 →「路由控制台…」，或监控面板右上角的网络图标；设置页也有「AI Router」入口。
2. 设置 →「Provider 连接」已合并 OpenCode Go 与 Codex/Claude/Cursor/Z.AI/ZCode；设置 →「AI Router」可直接调整多渠道路由、会话亲和、额度拦截和最大尝试次数。
2. 「提供商」→ 添加提供商：选择协议、填写 Base URL（包含 `/v1` 等完整前缀）和上游 API Key。
3. 「模型路由」→ 添加渠道：对外模型名（客户端使用的 `model`）→ 上游模型名。
   同一对外模型名可以绑定多个提供商，自动组成渠道组。模型组支持整组重命名、整组启停；请求日志会同步新名称，历史用量保留原名称快照。
4. 「本地网关」→ 启动服务，复制 Base URL 和 API Key。
5. 客户端把 Base URL 指向 `http://127.0.0.1:<port>/v1`，模型填对外模型名。

网关默认关闭，启动后才监听端口；只绑定 `127.0.0.1`。

## 三协议入口

| 入口 | 路径 | 上游协议 |
|---|---|---|
| OpenAI Chat | `POST /v1/chat/completions` | `openai` |
| Anthropic Messages | `POST /v1/messages` | `anthropic` |
| OpenAI Responses | `POST /v1/responses` | `openai-responses` |
| 模型列表 | `GET /v1/models` | — |

- 同协议默认 **raw 透传**：请求体除 `model` 外原样转发，响应原样回写，未知字段不丢失。
- 异协议走 **统一会话转换**：入口解析 → 中性会话 → 上游请求 → 上游解码 → 入口编码。3×3 组合均可用。
- 流式 SSE 与非流式 JSON 都支持；同协议透传逐块回写，异协议转换逐事件编码。
- 支持文本、图片（URL/base64）、工具调用与工具结果；思考内容按各协议约定映射。

转换路径的限制：

- 各协议特有字段不会全部透传（例如 Responses 的 `store`、内置工具，Anthropic 的 citations）。
- 思考历史在跨协议时不回传（签名不可重建）。
- Anthropic 流式 `message_start.usage.input_tokens` 在转换入口恒为 0；输出 token 随 `message_delta` 下发。
- Responses 转换只支持 `function` 工具。

## 负载均衡与故障转移

- 同一 `public_name` 的多条渠道即渠道组；`GET /v1/models` 只暴露至少有一条启用渠道的对外模型。
- 可用度 0–100 是选路权重：
  - 成功 +8，连续失败清零；
  - 网络/5xx 扣 20–30，最低保留 1，允许低权重探针；
  - 401/403 或额度耗尽直接归零并暂停 5 分钟；
  - 额度窗口全部耗尽时，阻断到最近的重置时间；重置时间已过则允许探针。
- 会话亲和：`x-session-id` / `x-conversation-id` / `x-thread-id` / `metadata.user_id` / 首条用户消息指纹，优先固定同一渠道，提升上游 prompt cache 命中。
- 只在尚未向客户端写出任何字节时改道；最多尝试 `maxAttempts` 个渠道。
- 首字节超时 60 秒；非流式上游错误会先读完错误体再决定是否改道。
- 一次客户端请求只落一条日志，重试轨迹写入 `retry_trace`。

## 请求日志与用量

- 两阶段：转发前写 pending 行，结束后按 `requestId` 回填；启动时把残留 pending 收口为 499。
- 记录：对外模型、最终提供商/上游模型、客户端 UA 归一名称、状态码、耗时、流式标记、token（prompt/completion/reasoning/cache read/cache write）、请求/响应头（鉴权头剔除）、请求/响应正文（最多 2MB）、错误、重试轨迹。
- 用量双粒度：
  - `usage_daily` 按本地自然日 + 提供商 + 对外模型聚合，永久保留；
  - `usage_hourly` 按小时聚合，随日志一起清理。
- 请求数与耗时不分成败；token 只累计成功请求；上游未返回 usage 时按字符数估算并写入 `unrecognized_tokens`。
- 日志保留 7 天，启动时清理；「路由设置」可手动清空日志和小时聚合。

## 余量策略

已内置 25 家，可直接绑定到路由提供商：

| id | 凭证 | 说明 |
|---|---|---|
| `opencode` | API Key | OpenCode Go 5h / weekly / monthly |
| `zai` | API Key | Z.AI / BigModel Coding Plan |
| `codex` | OAuth token | Codex 用量窗口 + 重置积分 |
| `claude` | OAuth token | Claude 用量窗口 |
| `cursor` | Cookie | Cursor 用量摘要 |
| `deepseek` | API Key | 账户余额 |
| `openrouter` | API Key | credits 余额 |
| `moonshot` | API Key | 账户余额（region=cn 切中国区） |
| `siliconflow` | API Key | 账户余额 |
| `minimax` | API Key | Coding Plan 5h / 周窗口 + 积分 |
| `aiand` | API Key | 用量日志聚合 |
| `chutes` | API Key | 订阅配额与请求计数 |
| `deepinfra` | API Key | 余额 + 本期用量 |
| `elevenlabs` | API Key | 字符额度 |
| `venice` | API Key | USD / DIEM 余额 |
| `xai` | Management API Key | 团队预付费余额（配置 `XAI_TEAM_ID`） |
| `warp` | API Key | 请求限额与刷新时间 |
| `crof` | API Key | 额度、请求余量、每日重置 |
| `zenmux` | API Key | 订阅额度 + 按量余额 |
| `neuralwatt` | API Key | kWh 算力配额 |
| `llmproxy` | API Key | 自建 LLM Proxy 凭据统计 |
| `litellm` | API Key | 自建 LiteLLM 预算 |
| `codebuff` | token | 用量与订阅档位 |
| `custom-http` | API Key | 自定义 JSON 接口：url + 字段路径，适配长尾 Provider |
| `custom-js` | API Key | 外置 JS 脚本（受限 vm，返回 windows/balance） |

Custom HTTP 通过提供商的「策略附加配置」接入任意 JSON 余量接口：

```json
{
  "url": "https://api.example.com/quota",
  "auth": "bearer",
  "percentPath": "data.usedPercent",
  "balancePath": "data.balance",
  "currency": "USD",
  "label": "Weekly",
  "windowMinutes": 10080
}
```

支持 `percentPath`，或 `usedPath` + `limitPath`；`headers` 可填 JSON 对象，`method` 支持 GET/POST。

Custom JS 在受限 `vm` 中执行脚本，脚本可调用 `getJSON(url, options)`，并返回：

```json
{
  "script": "const r = await getJSON('https://api.example.com/quota', { headers: { Authorization: `Bearer ${apiKey}` } }); return { windows: [{ id: 'weekly', label: 'Weekly', usedPercent: r.json.data.usedPercent, windowMinutes: 10080 }], balance: null, currency: null, details: [] };"
}
```

> `vm` 不是安全沙箱，只应安装你信任的脚本。脚本无 `require` / `process`，网络请求经宿主 `fetch`，默认 20 秒超时。

策略统一实现 `RouterQuotaStrategy`（`src/main/router/quota.ts`），新增一家只需：

1. 实现 `fetch(context): Promise<RouterQuotaResult>`；
2. 注册到 `ROUTER_QUOTA_STRATEGIES`；
3. 在提供商编辑页选择策略。

启动 5 秒后首刷，之后每 10 分钟刷新；余量耗尽会反馈给负载均衡做前置拦截。

## 数据与安全

- 数据文件：`%APPDATA%\TokenMonitor\router.db`（SQLite WAL）。
- 上游 API Key / OAuth token / Cookie 不写入 SQLite；使用现有 `ProviderSecretStore`（Windows DPAPI / macOS Keychain）加密保存在 `provider-secrets.bin`。
- 本地网关 API Key 存在 `router.db` 的设置表，仅用于本机客户端鉴权；可在服务页重新生成。
- 日志正文只保存在本机，保留 7 天；服务页可关闭「保存请求/响应正文」，关闭后只记录状态、耗时、token 和标头；导出/截图时注意仍可能包含 prompt。
- 默认不启动网关；启动后只监听 loopback，不对外网开放。
- 上游代理支持 HTTP(S) URL（CONNECT 隧道）；留空则使用 Electron 默认网络栈（含系统代理）。

## 代码结构

```
src/main/router/
├─ db.ts                 # router.db schema + 仓储 + 日志/用量 SQL
├─ balancer.ts           # 可用度、会话亲和、额度拦截、候选排序
├─ gateway.ts            # loopback HTTP 网关、认证、转发、流式、日志
├─ quota.ts              # 余量策略注册表与 25 家实现
├─ service.ts            # 生命周期、CRUD、状态、定时刷新
└─ protocol/
   ├─ types.ts           # 中性会话/事件/适配器接口
   ├─ sse.ts             # 增量 SSE 解析
   ├─ openaiChat.ts      # OpenAI Chat 双向编解码
   ├─ anthropicMessages.ts
   ├─ openaiResponses.ts
   └─ registry.ts
src/renderer/src/router/  # 独立路由控制台窗口（#router）
```

## 已知限制

- 余量策略目前 25 家，ai-router 的其余 provider 适配器尚未移植；注册表已留扩展点。
- 路由控制台与主监控使用同一 Electron 进程与渲染包；打开路由窗口会增加内存占用。
- 转换路径不保证协议特有字段全量保真；需要原样透传时让入口协议与上游协议一致。
- 请求/响应正文默认落库，敏感场景可在后续版本增加“只记元数据”开关。
- 日志与小时聚合在启动和每日维护任务中清理。
- 未做请求总超时；长流式回答只受客户端断开和首字节 60 秒限制。
