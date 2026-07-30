# Windows 从零安装指南

这份指南面向第一次部署飞书 Codex Bridge 的 Windows 用户。完成后，桥接器会使用一套独立、锁定版本的 Codex CLI 和飞书 CLI；你平时使用的全局 Codex CLI 可以继续单独升级。

如果希望由具备本机终端权限的 AI Agent 协助执行，请让它先完整阅读 [Agent 安装执行协议](INSTALL_WITH_AGENT.md)。该协议把只读检查、权限申请、人工步骤、验证标准和敏感信息处理写成了 Agent 可直接遵循的阶段任务；本文仍是安装参数与用户操作的事实来源。

> 这是能远程操作本机代码的高权限服务。只把可信用户、私聊和私有工作台群加入白名单；不要提交真实配置、飞书 ID、App Secret、Codex 凭据、日志或会话数据。

## 1. 安装系统依赖

当前支持 Windows 10/11、Windows PowerShell 5.1+ 和 Node.js 20+。建议先安装 Git 与 Node.js LTS：

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

关闭并重新打开 PowerShell，然后确认：

```powershell
git --version
node --version
npm.cmd --version
```

`node --version` 必须为 `v20` 或更高。本项目没有第三方运行时依赖，源码克隆后不需要执行 `npm install`。

## 2. 获取源码并安装隔离工具链

将下面的仓库地址替换为实际 GitHub 地址：

```powershell
git clone <repository-url> feishu-codex
Set-Location .\feishu-codex
```

可先查看安装计划，不会写文件或下载工具：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly -PlanOnly
```

实际安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly
```

工具默认安装到：

```text
%LOCALAPPDATA%\feishu-codex-bridge\tools\bridge-toolchain
```

后续命令先定义这些变量：

```powershell
$data = Join-Path $env:LOCALAPPDATA "feishu-codex-bridge"
$codexEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@openai\codex\bin\codex.js"
$larkEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@larksuite\cli\scripts\run.js"
$config = Join-Path $data "config\bridge.config.json"
```

## 3. 登录 Codex

```powershell
node $codexEntry login
node $codexEntry login status
```

登录凭据仍属于当前 Windows 用户。安装器隔离的是 CLI 可执行版本，不是 Codex 账号、Desktop 会话目录或操作系统权限边界。

## 4. 创建或绑定飞书应用

### 新建专用应用（推荐）

下面的 `--new` 会通过浏览器流程创建一个新应用，不要先在开发者后台再创建一份同名应用：

```powershell
node $larkEntry config init --new --name codex-remote --lang zh
```

### 使用已有应用

省略 `--new`，按 CLI 提示选择绑定已有应用：

```powershell
node $larkEntry config init --name codex-remote --lang zh
```

检查 profile 是否存在：

```powershell
node $larkEntry --profile codex-remote config show
```

App Secret 由飞书 CLI 保存，不要写入 `bridge.config.json`、命令历史、Issue 或 Git。

飞书 CLI 的官方安装与初始化说明见[飞书 CLI 安装指南](https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide.md)。官方通用指南还会介绍用户身份登录；本桥接器的消息收发全部使用 `--as bot`，只要求应用凭据和机器人权限。

## 5. 配置飞书开发者后台

打开上一步创建或绑定的企业自建应用，并完成以下设置。

### 机器人与权限

启用“机器人”能力，至少申请：

- `im:message.p2p_msg:readonly`：接收发给机器人的私聊消息。
- `im:message:send_as_bot` 或 `im:message`：以应用身份发送和回复消息。
- `im:message:readonly`：读取消息上下文，供话题路由和卡片操作使用。
- `im:message.urgent:app_send`：可选；人工审批等待 10 秒后发送应用内加急。

需要在工作台群中无需 `@` 机器人即可发任务时，还要申请飞书后台标记为敏感权限的“获取群组中所有消息” `im:message.group_msg`。部分租户的权限目录也会显示 `im:message.group_msg:readonly`；以后台当前提供的“群聊中所有用户消息”权限为准。若只申请 `im:message.group_at_msg:readonly`，群里仍必须 `@` 机器人。

官方接收消息事件文档列出了这些权限及差异：[接收消息 `im.message.receive_v1`](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)。

### 事件订阅

选择“使用长连接接收事件”，订阅：

- `im.message.receive_v1`
- `card.action.trigger`

桥接器不需要公网回调 URL。完成后创建应用版本并发布；企业管理员审批通过后权限才会生效。以后新增权限或事件也要重新发布新版本。

### 工作台群

如需话题隔离，为机器人创建一个只包含可信用户的私有话题群，并把机器人加入群。一个飞书话题会对应一个 Codex 会话。

## 6. 获取白名单 ID

先启动一次性事件捕获：

```powershell
node $larkEntry --profile codex-remote event consume `
  im.message.receive_v1 --as bot --max-events 1 --timeout 2m
```

然后在飞书中向机器人发送 `/help`。输出 JSON 中：

- `sender_id` 或 `sender_id.open_id` 的 `ou_...` 是你的 `open_id`。
- `chat_id` 的 `oc_...` 是当前私聊或群聊 ID。

若同时需要私聊 ID 和工作台群 ID，分别捕获一次。不要把这些真实 ID 发到公开 Issue 或写进仓库文件。

## 7. 生成 canonical 配置

安装器只创建第一个仓库；后续仓库可手动加入 canonical JSON。

### 仅使用机器人私聊

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_your_open_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project"
```

私聊模式下不传 `-AllowedChat`，桥接器会接受白名单用户与机器人的任意私聊，但仍拒绝群聊。

### 仅使用工作台群

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_your_open_id" `
  -WorkbenchChat "oc_replace_with_workbench_chat_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project"
```

`-WorkbenchChat` 会自动把该群加入 `allowedChats` 并关闭 `p2pOnly`。

### 私聊与工作台并用

一旦 `allowedChats` 非空，它会同时约束私聊和群聊。因此要把私聊 `chat_id` 也明确加入：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_your_open_id" `
  -AllowedChat "oc_replace_with_p2p_chat_id" `
  -WorkbenchChat "oc_replace_with_workbench_chat_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project"
```

多个发送者或聊天 ID 使用 PowerShell 数组，例如 `-AllowedSender "ou_user_one","ou_user_two"`。

默认配置路径为：

```text
%LOCALAPPDATA%\feishu-codex-bridge\config\bridge.config.json
```

安装器不会覆盖已有配置；确实需要重建时，先备份并审阅旧文件，再显式传 `-ForceConfig`。运行数据目录和受管仓库的路径链都不能包含 junction、symlink 或其他 reparse point。

安装器还会把登录启动器固定安装到仓库外：

```powershell
$launcher = Join-Path $data "launcher\start-bridge-windows.ps1"
```

源码目录中的同名脚本只是安装模板，不能直接作为常驻启动入口。

增加仓库时编辑 canonical 配置：

```json
"repositories": {
  "frontend": { "path": "E:\\projects\\frontend" },
  "backend": { "path": "E:\\projects\\backend" }
},
"defaultRepository": "frontend"
```

`dataDirectory` 必须位于所有受管仓库之外。配置文件中的 `approvalPolicy` 必须保持 `never`；飞书审批由桥接器自己的受控代理完成。

## 8. 自检与第一次启动

安装器默认已运行 doctor，也可以再次执行：

```powershell
npm.cmd run doctor -- --config "$config"
```

所有必需检查应为 `PASS`。`codex-read-isolation` 的 `WARN` 是安全边界提醒：`workspace-write` 主要限制写入，不提供强读取隔离。

第一次以前台模式启动，便于观察日志：

```powershell
npm.cmd start -- --config "$config"
```

等待以下三行：

```text
Codex app-server session backend is ready.
Feishu event stream is ready.
Feishu approval card stream is ready.
```

在飞书发送 `/help`，再执行一个只读任务：

```text
/task 阅读当前仓库并用三点概括用途，不要修改文件
```

测试完成后在 PowerShell 按 `Ctrl+C`，等待进程清理并退出。不要在前台实例仍运行时启动正式部署。

## 9. 后台部署、状态和停止

从源码目录运行：

```powershell
npm.cmd run deploy -- --config "$config"
```

部署器会运行测试、生成仓库外 runtime snapshot、启动 detached 进程、检查四项 readiness，并在替换失败时恢复上一份已验证快照。首次部署尚无可回滚目标，所以前台冒烟测试不能省略。

查看当前部署和日志：

```powershell
Get-Content (Join-Path $data "deployment-state.json")
Get-ChildItem (Join-Path $data "logs") | Sort-Object LastWriteTime -Descending | Select-Object -First 10
```

停止后台服务：

```powershell
node .\src\main.js stop --config "$config"
```

## 10. 登录时自动拉起

第 7 步运行安装器时，已生成固定的仓库外启动器：

```powershell
$launcher = Join-Path $data "launcher\start-bridge-windows.ps1"
```

必须先完成第 9 步的首次正式部署；部署成功后，`deployment-state.json` 才有一个经过 readiness 检查的 active runtime。随后可预览登录启动目标：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$launcher" -PlanOnly
```

启动器不读取源码仓库、canonical 配置，也不运行 `npm` 或 `deploy`。它只读取仓库外 `deployment-state.json` 中的 active 目标，限制 runtime/bootstrap 必须位于 `$data\runtime` 和 `$data\bootstrap`，校验 bootstrap SHA-256，再由该 bootstrap 按 manifest 逐文件验证 runtime snapshot 后启动。源码仓库即使后来被任务中的 Codex 修改，也不会改变下一次登录启动的控制面。

在 Windows“任务计划程序”中创建任务：

1. 使用运行桥接器和完成 Codex/飞书登录的同一 Windows 用户。
2. 触发器选择“用户登录时”，建议延迟 30 秒，给网络连接留出时间。
3. 程序填写 `powershell.exe`。
4. 参数填写 `-NoProfile -ExecutionPolicy Bypass -File "<DataDirectory>\launcher\start-bridge-windows.ps1"`。
5. “起始于”可留空；不要填写源码仓库，也不要再传 `ConfigPath`。
6. 设置“如果任务已在运行，则不启动新实例”，并取消不适合常驻服务的最长运行时间限制。
7. 可设置失败后每 1 分钟重试，最多 3 次。

启动器会一直等待它启动的桥接进程，并把退出码返回给任务计划程序，因此上述失败重试可以处理这一次登录启动失败或异常退出。它仍不是完整的持续故障监管方案：后续手工 `deploy` 会由部署器替换成 detached 新进程，原启动任务随旧进程退出，无法继续监管新进程。需要跨部署持续监管时应使用经过审计的专门 supervisor。

## 11. 更新与回滚

正常更新：

```powershell
git pull --ff-only
npm.cmd run deploy -- --config "$config"
```

更新和登录拉起是两条独立路径：只有人工运行上述 deploy 才会测试源码并发布新 snapshot；任务计划程序中的仓库外启动器永远只重启 `deployment-state.json` 已记录的 active snapshot。

普通源码更新不需要重装工具链。只有 release notes 明确说明 `package.json` 中的 `bridgeToolchain` 版本发生变化时，才安排维护窗口：先停止桥接器，备份 `$data\tools` 与 canonical 配置，再运行 `install-windows.ps1 -ToolsOnly`、doctor 和 deploy。工具链更新不会修改 canonical 配置，但 runtime snapshot 的自动回滚也不会还原仓库外 CLI 二进制，因此不要把它与普通热更新混为一谈。

只准备和审计新快照、不替换当前服务：

```powershell
npm.cmd run deploy -- --config "$config" --prepare-only
```

普通源码部署失败会自动恢复上一个成功快照。项目当前没有按编号手动切换旧快照的公开命令；需要主动回退时，切换到已知可用的 Git tag/commit 并重新 deploy。若目标版本锁定了不同工具链，还必须按对应 release notes 恢复匹配的仓库外 CLI，自动快照回滚不会替你完成这一步。

## 12. 卸载

1. 先停止桥接器并删除任务计划程序中的启动任务。
2. 在删除隔离工具链前，如需移除飞书 CLI profile，运行：

   ```powershell
   node $larkEntry --profile codex-remote config remove
   ```

3. 确认 `$data` 指向 `%LOCALAPPDATA%\feishu-codex-bridge` 后，删除该目录和源码目录。
4. 在飞书开发者后台停用或删除专用应用。

不要为了卸载本项目直接删除 `%USERPROFILE%\.codex`；它还包含 Codex Desktop/CLI 的登录和会话数据。

## 常见问题

### PowerShell 提示无法运行 `npm.ps1` 或 `lark-cli.ps1`

本文统一使用 `npm.cmd` 和 `node <绝对 JS 入口>`，不依赖 PowerShell shim。按本文命令执行即可，无需永久放宽系统执行策略。

### doctor 提示 Codex 或飞书 CLI 版本不支持

确认 canonical 配置中的 `codex.entry` 与 `larkCliEntry` 分别指向 `$codexEntry` 和 `$larkEntry`，再运行 `install-windows.ps1 -ToolsOnly`。不要删除版本检查或把全局最新版路径写进配置。

### 私聊正常，工作台群无响应

检查 `workbenchChats`、`allowedChats`、群 `chat_id`、`im:message.group_msg` 权限、事件订阅和应用是否在新增权限后重新发布。

### 工作台正常，私聊无响应

启用工作台后 `allowedChats` 已非空；把私聊事件中的 `chat_id` 加到 `allowedChats`，然后重新部署。

### 修改配置后没有生效

确认修改的是 `$config` 指向的 canonical 文件，而不是仓库中的开发 shadow；然后执行：

```powershell
npm.cmd run doctor -- --config "$config"
npm.cmd run deploy -- --config "$config"
```

日常操作、话题和会话绑定、审批模式请继续阅读[用户使用指南](USER_GUIDE.md)。
