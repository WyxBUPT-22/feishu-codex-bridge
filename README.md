# 飞书 Codex Bridge

通过飞书机器人私聊，在移动设备上发现、绑定并继续本机 Codex Desktop/CLI 的同一个 thread。

> 项目目前主要面向 Windows，且锁定桥接器专用的 Codex CLI 版本。它不是飞书或 OpenAI 的官方项目。首次部署请阅读 [Windows 安装指南](INSTALL_WINDOWS.md)；希望让 AI Agent 分阶段辅助安装时，请让它完整阅读 [Agent 安装执行协议](INSTALL_WITH_AGENT.md)。使用前请完整阅读[安全边界](#重要隔离边界)和[用户指南](USER_GUIDE.md)。

## 项目状态

项目已用于日常移动端远程控制，但仍处于早期版本。Codex app-server 和 Hook 协议属于版本敏感接口；升级 Codex CLI 前必须重新运行测试与真实哨兵验证。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，参与开发请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构

```text
飞书移动端
  -> lark-cli event consume（官方 WebSocket 事件总线）
  -> 本桥接器（白名单、去重、会话 lease、审批代理）
  -> codex app-server --stdio（统一 thread 后端）
  -> Codex Desktop / CLI 共用本机会话存储
  -> lark-cli 回复与电脑侧增量同步
```

本服务不开放公网端口。飞书 CLI 和模型服务都由本机主动建立出站连接；app-server 只使用 stdio。

## 安全默认值

- 仅接受 `allowedSenders` 中的飞书 `open_id`。
- 默认仅接受机器人私聊；启用工作台后，也只接受 `workbenchChats` 明确列出的私有话题群。
- 私聊仅接受 `/task`、`/continue` 等固定命令；工作台话题绑定会话后可直接发送普通文字。消息只作为 Codex prompt，不拼进 shell。
- 只能操作配置文件列出的仓库路径。
- Codex 固定运行于 `workspace-write` 或 `read-only`。
- app-server 使用 `untrusted` + 受控 `PreToolUse` Hook + 本地审批代理。默认 `balanced` 模式会让安全 envelope 内的 shell 先交给 Codex 原生策略：原生可信读取静默执行，原生不可信命令才发送一次飞书审批；协议中的展示型 `commandActions` 不作为自动批准依据。
- `apply_patch` 只接受锁定 Codex 版本的唯一规范补丁载荷，并通过词法路径、真实路径、reparse/symlink 和硬链接检查。`balanced` 仅自动批准仓库内纯 Add 或纯 Update；删除、移动和混合补丁仍需人工。`auto` 可自动批准所有已验证的仓库内补丁，但不自动批准原生不可信 shell。
- Hook 批准与随后原生审批仅按同一 `threadId + turnId + itemId + cwd + 操作类型` 一次性联结；命令还必须匹配严格整串 SHA-256，且只识别完整、锚定的已知 shell wrapper，不使用展示型子命令摘要。联结不可重放，并在 60 秒、任务结束、取消、takeover 或服务退出时清除。
- 未经上述精确联结的 v2 文件修改审批不包含可验证的完整路径，因此默认直接拒绝；Hook 中的 `apply_patch` 会先解析并验证全部目标路径均在当前仓库内。
- 任何额外网络/文件权限、仓库外工作目录、永久策略放宽和 session 级批准均直接拒绝；权限请求会中断对应 turn。
- 审批按钮使用独立 128-bit action ID，并同时绑定发送者、聊天、卡片消息、任务和活跃 turn；文本审批码还会绑定飞书话题。两者均为单次使用、5 分钟失效，服务重启、消息发送失败或超时均默认拒绝。
- app-server 从首次启动起使用专用隔离 `CODEX_HOME`，仅链接本机会话存储并复制认证所需文件；MCP、插件、App、外部 Hook、Skills 指令、notify、Web 搜索和远程能力全部关闭，只启用桥接器自带的一个审批 Hook。
- 每个 app-server/doctor 实例都会创建独立、随机、仓库外的 Hook 目录，停止后清理，避免并行 doctor 覆盖生产 endpoint。app-server 先发现其唯一 `key/currentHash`，再用精确 `trusted_hash` 重启并通过 `hooks/list` 核验：必须只有一个、来源为 session flags、已启用且状态为 `trusted`。
- 本地 shell 需要 app-server 的默认本地 environment，因此不传空 `environments`；动态工具和额外 capability roots 仍为空，turn 的写入根与网络策略仍由显式 sandboxPolicy 限定。
- 每个 turn 显式固定可写根为当前白名单仓库、关闭网络并排除临时目录；隔离自检失败时服务直接退出，不降级到 CLI 后端。
- Codex 子进程会移除名称含 `LARK` 或 `FEISHU` 的环境变量。
- Codex 子进程只继承运行所需的系统环境白名单，不继承 GitHub、AWS、数据库等凭据变量。
- 飞书 CLI 与 Codex app-server 通过参数数组和标准输入调用；仅审批 Hook 使用仓库外的受控 launcher，并把其内部异常统一转换为阻断退出码。
- 消息先按 `message_id` 去重，再执行任务。
- 队列固定单并发，并使用持久化 lease、generation fencing 和 `turn/start` 后复核，降低电脑端/飞书端同时写入同一 thread 的竞态。
- 取消和超时会终止对应 turn 或完整 CLI 进程树。
- 按 `dataDirectory` 派生的内核互斥（Windows 命名管道）配合 `bridge.lock` PID/token 元数据，防止双实例重复消费并安全回收 stale lock；飞书事件流或 app-server 意外退出时，桥接器会清理子进程并以非零状态退出，交由外部 supervisor 重启。

### 重要隔离边界

Codex 的 `workspace-write` 主要限制写入位置，**不代表只能读取所选仓库**。如果飞书 CLI 与 Codex worker 在同一个 Windows 用户和 ACL 边界内运行，不能把 `~/.lark-cli` 等凭据目录视为对 Codex 不可读。

正式常驻运行仍建议将飞书网关和 Codex worker 放到不同 Windows 用户、WSL 或容器身份。当前同用户模式会清理传给 Codex 的环境变量并禁用外部工具执行面，但 Codex 的内建文件读取边界仍取决于操作系统 ACL；系统/用户 Skills 的提示元数据也仍可能被发现。

Codex 0.144.1 对“Hook 进程本身无法启动”或“被 Codex 强制超时终止”的上游语义是 fail-open。桥接器用仓库外 launcher、脚本内部 deny/exit-2 兜底、启动信任自检和运行期失败即退出尽量收窄该窗口，并保留 `approvalPolicy=untrusted` 作为第二道保护；但灾难性的最外层 Hook 启动失败仍可能让 Codex 自带 trusted 集合中的只读命令在桥接器退出前执行。它不能替代独立 OS 用户/容器提供的强读取隔离。

## 版本兼容性

桥接器当前验证的工具链版本记录在 `package.json` 的 `bridgeToolchain` 中：Codex CLI `0.144.1`、飞书 CLI `1.0.68`。Windows 安装器把它们安装到 `%LOCALAPPDATA%\feishu-codex-bridge\tools\bridge-toolchain`，再通过 `codex.entry` 和 `larkCliEntry` 使用绝对入口。因此桥接器不会依赖或降级全局 Codex CLI，日常使用的 Codex Desktop/CLI 可以独立更新。

严格门禁仍是必要的：本项目依赖 app-server、审批、Hook 和飞书事件流的具体协议语义；[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)也明确说明生成的 TypeScript/JSON Schema 与执行生成命令的 Codex 版本一一对应。doctor 和正式启动都会同时校验 Codex CLI 与飞书 CLI，不受支持的版本会 fail-closed；不能用 `>=` 范围或跳过 doctor 代替兼容性审计。

隔离的是桥接器可执行版本，不是 Windows 用户、Codex 登录或本机会话存储。未来新版 Desktop/CLI 若改变共享会话格式，跨版本接力仍需重新验证；已验证组合会在本节更新。

## 快速安装（Windows）

要求 Node.js 20+ 和 Git。克隆仓库后先安装隔离工具链：

仓库根目录的 `AGENTS.md` 会把安装/部署类任务自动引导到 Agent 执行协议。使用具备本机终端权限的 AI Agent 辅助安装时，也可直接发送：“请完整阅读 `INSTALL_WITH_AGENT.md`，先做只读检查，再严格按分阶段协议协助我安装。”该协议会在登录、飞书后台发布、覆盖配置和自启动等边界处暂停并取得用户确认。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly
```

完成 Codex 登录、飞书应用与 profile 配置并取得 `ou_...` 后，生成仓库外 canonical 配置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_your_open_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project"

$config = Join-Path $env:LOCALAPPDATA "feishu-codex-bridge\config\bridge.config.json"
```

新应用/已有应用、机器人权限、私聊/工作台配置、开机拉起、更新、回滚和卸载的完整步骤见 [Windows 从零安装指南](INSTALL_WINDOWS.md)。生产部署只读取 `dataDirectory\config\bridge.config.json`；仓库根目录的 `bridge.config.json` 仅是可选开发 shadow，若与 canonical 漂移，部署会直接停止。

## 运行

前台直接从工作区运行（仅适合开发和观察日志）：

```powershell
npm.cmd start -- --config "$config"
```

看到 `Codex app-server session backend is ready.` 和 `Feishu event stream is ready.` 后即可在飞书私聊机器人。出现 `Feishu approval card stream is ready.` 表示按钮审批也已启用；如果卡片事件流不可用，服务会保留文字审批并继续运行。

正式更新使用单一部署命令：

```powershell
npm.cmd run deploy -- --config "$config"
```

该命令会依次完成：

1. 锁定部署流程，检查 canonical 路径以及仓库 shadow 漂移。
2. 运行全量测试和语法检查，并确认测试期间 canonical 配置没有变化。
3. 生成仓库外 runtime snapshot；清单同时绑定 canonical 配置原始字节的 SHA-256。
4. 验证新快照和 bootstrap，保存上一份可回滚目标，再通过本地控制通道优雅停止旧进程。
5. 后台启动新快照，等待以下四行完整且精确的 ready 标志：runtime 校验、Codex app-server、飞书消息流和审批卡片流。
6. 四项全部就绪后，才原子更新 `dataDirectory\deployment-state.json`。若启动、readiness 或状态落盘失败，部署器会清理新进程、恢复旧快照，并再次等待同样四项 ready 标志。

每次部署启动使用独立日志，位于 `dataDirectory\logs\bridge-<runtime>-<attempt>.*.log`；当前成功版本和对应日志路径记录在 `deployment-state.json`。只准备并审计快照、不停止线上服务时使用：

```powershell
npm.cmd run deploy -- --config "$config" --prepare-only
```

Windows 安装器另会生成 `dataDirectory\launcher\start-bridge-windows.ps1`，供任务计划程序在登录后只重启 `deployment-state.json` 中已验证的 active snapshot。该入口不读取源码仓库，不运行 `npm`/`deploy`；发布源码更新仍必须由用户显式执行上面的部署命令。登录启动器的输出由任务计划程序承接，不会创建新的 `logs\bridge-*` 文件。

单独生成快照仍可使用下面的命令；它同样默认读取 canonical 配置并执行 shadow 漂移检查：

```powershell
npm.cmd run snapshot -- --config "$config"
```

快照只包含 `src`、`package.json`、重定位后的配置和 SHA-256 清单，位于 `dataDirectory\runtime`。正式进程只通过仓库外、按内容哈希安装的 bootstrap 启动。目标仓库内后续代码修改不会在普通重启时改变桥接控制面；更新代码或 canonical 配置后重新运行带显式 `--config` 的 deploy。

支持的命令：

```text
/task <任务>       新建 Codex 会话并执行
/continue <任务>   继续当前仓库的上次会话
/start <仓库> <任务> 在新的工作台话题中选择仓库并创建会话
/repo <别名>       切换仓库
/repos             查看允许的仓库
/sessions          查看当前仓库的 Desktop/CLI 会话
/attach <编号>     绑定电脑侧已有 thread
/detach            解除当前绑定
/fork <编号>       从已完成历史创建并绑定分支
/takeover [确认码] 二次确认后中断冲突 turn
/approval [strict|balanced|auto] 查看或切换当前话题的审批模式
/status            查看任务状态
/cancel [任务号]   取消任务
/approve <确认码>  审批按钮不可用时，单次批准安全范围内的操作
/deny <确认码>     审批按钮不可用时，拒绝待确认操作
/new               清除当前仓库会话
/help              查看帮助
```

### 飞书工作台话题

配置 `lark.workbenchChats` 后，一个飞书话题会固定对应一个 Codex thread。话题根消息 ID 是持久化路由键；接收确认、进度、审批卡片、最终结果和 Desktop 同步都通过 `reply_in_thread` 回到原话题，线程投递失败时不会降级发送到群主时间线。

每个新任务会创建一张可持续更新的控制卡，集中显示仓库、审批模式、最新进度、待审批操作、审批统计和停止按钮。控制卡更新按任务串行执行，避免旧进度覆盖新审批；最终长回复仍单独发送。控制卡创建或更新失败时，进度和审批会自动降级为原有文本消息与独立审批卡片。

控制卡出现人工审批后，如果 10 秒内仍未处理，桥接器会对这张任务卡发送一次飞书应用内加急；自动审批和已经处理的审批不会提醒。应用未开通 `im:message.urgent:app_send`、接收人不满足飞书限制或加急接口失败时，会在原话题中发送一条简短文字提醒，不会再创建审批卡片。

首版交互：

1. 在“Codex 工作台”中新建话题，发送 `/start <仓库> <任务>`；或者先发送 `/repo <仓库>`，随后直接描述任务。
2. 会话建立后，在该话题中直接发送普通文字即可续聊。
3. `/status`、`/cancel`、文本审批和 takeover 都只作用于当前话题。
4. 已绑定话题不能切换仓库、清空或改绑其他会话；需要新会话时新建话题。

旧机器人私聊保持兼容，仍要求使用斜杠命令。

## 验证

```powershell
npm.cmd run doctor -- --config "$config"
npm.cmd test
npm.cmd run check
npm.cmd run sentinel -- --run --config "$config" --include-ipc-failure
```

### 无缝接力流程

1. 在电脑侧的 Codex Desktop 或 CLI 中打开目标项目并产生会话。
2. 飞书发送 `/sessions`，再发送 `/attach <编号>`。
3. 使用 `/continue <内容>`；新增 turn 会写入同一 thread，电脑侧可继续查看和接手。
4. 电脑侧在该 thread 完成新 turn 后，桥接器通常在 5 秒内把摘要主动发到飞书；可通过 `desktopSync.pollIntervalMs` 在 1-60 秒之间调整。

桥接器只列出路径精确匹配白名单且模型 provider 一致的会话。首次绑定建立同步基线，不回放完整历史；若游标落后超过最近 50 轮，会提示同步缺口并重新建立基线。

## 运行限制

- 电脑休眠、关机或断网时无法接收任务。
- 当前返回文本和节流工具摘要，超长回复会截断；飞书 CLI 1.0.68 没有稳定的 typed 消息更新命令，因此不做 token 级原地更新。
- 用户发送的卡片和附件输入尚未支持；登录时自动拉起需要按 [Windows 安装指南](INSTALL_WINDOWS.md#10-登录时自动拉起)配置任务计划程序。
- 飞书任务会立即写入共享 thread，但 Codex Desktop 当前没有公开的跨进程刷新 RPC。已打开的任务可能需要切换回来或重新打开后才显示外部 app-server 写入的 turn；这与电脑端摘要推送到飞书的轮询间隔无关。
- 桥接器必须运行在允许访问飞书与模型服务的普通用户网络环境中；受限沙箱中 Codex 可能无法联网。
