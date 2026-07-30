# 使用 Agent 辅助安装

本文是给具备本机终端和文件访问能力的 AI Agent 阅读的执行协议。用户文档和参数说明以 [Windows 从零安装指南](INSTALL_WINDOWS.md) 为准；本文负责规定 Agent 如何分阶段执行、何时暂停、哪些动作必须由用户确认，以及怎样判断安装真的完成。

用户可以在仓库根目录向 Agent 发送：

```text
请完整阅读 INSTALL_WITH_AGENT.md，并严格按其中的分阶段协议协助我安装飞书 Codex Bridge。
先做只读检查并列出需要我提供或操作的内容；不要跳过版本、安全、doctor、冒烟测试和部署验证，也不要把任何真实凭据或 ID 写入仓库。
```

## Agent 的目标

在 Windows 10/11 上完成以下结果：

1. 使用 `package.json` 中锁定的桥接器专用 Codex CLI 和飞书 CLI。
2. 在受管仓库之外生成 canonical 配置和运行数据目录。
3. 只允许用户确认过的飞书账号、私聊或私有工作台群访问桥接器。
4. 通过 doctor、前台飞书冒烟测试和正式 snapshot 部署。
5. 如用户需要，再指导或配置登录时自动拉起。

不要把“命令执行成功”当作安装完成。只有本文末尾的完成条件全部满足，才能向用户报告完成。

## 不可违反的约束

Agent 必须遵守以下约束：

- 开始写入、下载、安装、登录、发布应用、启动或停止服务前，先说明动作及影响；需要平台审批时正常申请，不绕过审批机制。
- 不永久放宽 PowerShell 执行策略。仅对项目脚本使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...`。
- 不使用或升级全局 Codex/飞书 CLI 代替隔离工具链，不删除版本门禁，也不把版本范围改成 `>=`。
- 不把 `dataDirectory`、canonical 配置、日志、runtime、CLI 工具链放进任何受管仓库。
- 不把 App Secret、Codex 凭据、API Key、飞书事件原文、真实 `ou_...`、`oc_...` 或 thread ID 写入仓库、Issue、提交信息或最终报告。
- 不手工修改 `approvalPolicy`；canonical 配置必须保持项目生成的 `approvalPolicy: "never"`，审批由桥接器自身处理。
- 不自行扩大仓库白名单、飞书白名单、文件权限、网络权限或 sandbox 范围。
- 不使用 `-ForceConfig` 覆盖已有配置，除非用户明确要求，并且 Agent 已先备份和展示差异。
- 不自行创建或删除飞书应用。必须先让用户选择“新建专用应用”或“绑定已有应用”。
- 不声称替用户完成浏览器登录、飞书后台权限申请、应用发布或管理员审批；这些步骤必须获得用户明确确认。
- 不从源码仓库配置登录自启动。任务计划程序只能调用 `dataDirectory\launcher\start-bridge-windows.ps1`。
- 安装任务不授权 Agent 提交、推送代码或修改 Git 身份。

如果环境、安全边界或用户意图不明确，Agent 应暂停相关写操作并询问用户，而不是猜测。

## 开始前收集的信息

Agent 先确认以下信息。可以分阶段询问，不要求用户一次提供尚未取得的飞书 ID。

| 信息 | 示例 | 说明 |
| --- | --- | --- |
| 首个仓库别名 | `my-project` | 1-32 位字母、数字、下划线或连字符 |
| 首个仓库绝对路径 | `E:\projects\my-project` | 必须已存在 |
| 使用方式 | 私聊 / 工作台 / 二者并用 | 决定聊天白名单参数 |
| 飞书 CLI profile | `codex-remote` | 默认即可 |
| DataDirectory | `%LOCALAPPDATA%\feishu-codex-bridge` | 通常使用默认值 |
| 飞书应用选择 | 新建 / 已有 | `--new` 只用于新建 |

稍后还需要：

- 至少一个获准用户的 `open_id`，格式为 `ou_...`。
- 使用工作台时需要工作台群 `chat_id`，格式为 `oc_...`。
- 二者并用时还需要私聊 `chat_id`，否则非空 `allowedChats` 会过滤该私聊。

## 阶段 0：只读检查

这一阶段不得安装或修改文件。Agent 应执行并解释结果：

```powershell
Get-Location
git status --short
git --version
node --version
npm.cmd --version
$PSVersionTable.PSVersion
Get-Content .\package.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty bridgeToolchain
```

同时确认：

- 当前目录包含 `package.json`、`INSTALL_WINDOWS.md` 和 `scripts\install-windows.ps1`。
- 操作系统为 Windows 10/11，Windows PowerShell 为 5.1+，Node.js 为 20+。
- 用户给出的仓库路径存在。
- 默认或自定义 `DataDirectory` 不在首个受管仓库内。
- 工作树中的现有改动属于用户；安装过程不得清理、覆盖或提交它们。

随后只预览工具安装计划：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly -PlanOnly
```

Agent 向用户报告检查结果、缺失依赖、计划安装位置和下一步需要的下载权限。Node.js 或 Git 缺失时，先让用户批准后再使用 `winget` 安装；不要在未确认时自动改动系统软件。

## 阶段 1：安装隔离工具链

得到用户对下载和写入 `%LOCALAPPDATA%` 的同意后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly
```

定义后续路径：

```powershell
$data = Join-Path $env:LOCALAPPDATA "feishu-codex-bridge"
$codexEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@openai\codex\bin\codex.js"
$larkEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@larksuite\cli\scripts\run.js"
$config = Join-Path $data "config\bridge.config.json"
$launcher = Join-Path $data "launcher\start-bridge-windows.ps1"
```

若用户指定了自定义 `DataDirectory`，以上变量必须使用该路径；后续每个 doctor、start、stop 和 deploy 命令都必须显式传 `--config "$config"`。

Agent 应比较实际输出与 `package.json.bridgeToolchain`：

```powershell
node $codexEntry --version
node $larkEntry --version
```

版本不匹配时停止，不得用全局 CLI 继续。

## 阶段 2：完成 Codex 登录

执行：

```powershell
node $codexEntry login
node $codexEntry login status
```

登录可能打开浏览器或显示设备授权流程。Agent 应让用户本人完成，不读取、记录或转述认证令牌。只有 `login status` 明确成功后才继续。

## 阶段 3：创建或绑定飞书应用

先询问用户选择。

新建专用应用：

```powershell
node $larkEntry config init --new --name codex-remote --lang zh
```

绑定已有应用：

```powershell
node $larkEntry config init --name codex-remote --lang zh
```

不能在用户已经手工创建应用后继续使用 `--new`，否则会再创建一份应用。profile 不是默认值时，把后续命令中的 `codex-remote` 全部替换为用户选择的值。

验证 profile：

```powershell
node $larkEntry --profile codex-remote config show
```

如果 CLI 要求输入 App Secret，应由用户直接在受信任的 CLI/浏览器界面输入，不要让用户把 Secret 发到聊天中。

## 阶段 4：等待用户配置飞书后台

这一阶段通常需要用户在飞书开发者后台完成。Agent 可以逐项引导和检查，但不能在用户未确认时假设已经生效。

必须启用机器人能力，并申请：

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot` 或后台提供的等价 `im:message`
- `im:message:readonly`
- 可选的 `im:message.urgent:app_send`

工作台群无需 `@` 机器人时，还要申请“获取群组中所有消息”：

- `im:message.group_msg`
- 某些租户显示为 `im:message.group_msg:readonly`，以后台实际权限名称为准

事件订阅必须选择长连接，并订阅：

- `im.message.receive_v1`
- `card.action.trigger`

用户还必须创建应用版本、发布并完成企业管理员审批。新增权限或事件后需要重新发布。Agent 应等待用户明确回复这些步骤已完成，再继续捕获消息。

## 阶段 5：获取白名单 ID

启动一次性事件捕获：

```powershell
node $larkEntry --profile codex-remote event consume `
  im.message.receive_v1 --as bot --max-events 1 --timeout 2m
```

让用户在飞书中向机器人发送 `/help`。Agent 从本地输出识别：

- `sender_id.open_id` 或等价字段中的 `ou_...`
- `chat_id` 中的 `oc_...`

私聊与工作台二者并用时分别捕获一次。Agent 可以将 ID 暂存在当前安装流程的内存或命令变量中，但不得写入仓库文件，也不要在最终报告中完整回显。

若两分钟内没有事件，不要反复盲目重试。先检查应用是否已发布、机器人是否加入聊天、长连接事件和消息权限是否生效。

## 阶段 6：预览并生成 canonical 配置

先根据用户选择构造安装参数，并追加 `-PlanOnly` 预览。下面命令中的值必须来自用户确认，不得使用示例占位符实际安装。

仅私聊：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_open_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project" `
  -PlanOnly
```

仅工作台：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_open_id" `
  -WorkbenchChat "oc_replace_with_workbench_chat_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project" `
  -PlanOnly
```

私聊与工作台并用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 `
  -SkipToolInstall `
  -AllowedSender "ou_replace_with_open_id" `
  -AllowedChat "oc_replace_with_p2p_chat_id" `
  -WorkbenchChat "oc_replace_with_workbench_chat_id" `
  -RepositoryAlias "my-project" `
  -RepositoryPath "E:\projects\my-project" `
  -PlanOnly
```

Agent 检查预览中的数据目录、工具入口、仓库路径和配置路径，向用户说明即将写入的内容。用户确认后删除 `-PlanOnly` 执行同一命令。不要传 `-SkipDoctor`。

使用自定义 `DataDirectory` 时，每条安装器命令都要追加 `-DataDirectory "<绝对路径>"`；profile 不是 `codex-remote` 时，每条完整配置命令都要追加 `-Profile "<profile>"`。不要只修改前面定义的 PowerShell 变量却遗漏安装器参数。

如果 canonical 配置已经存在，安装器会拒绝覆盖。此时 Agent 应读取现有配置、隐藏敏感 ID 后展示结构差异，并询问用户是保留、手工合并还是备份后重建；不得自动添加 `-ForceConfig`。

## 阶段 7：doctor 与前台冒烟测试

显式运行 doctor：

```powershell
npm.cmd run doctor -- --config "$config"
```

任何 `FAIL` 都必须解决后再继续。`codex-read-isolation` 的 `WARN` 是已知安全提醒，但 Agent 应向用户解释同一 Windows 用户不能提供强读取隔离。

前台启动：

```powershell
npm.cmd start -- --config "$config"
```

Agent 应观察到以下 ready 标志：

```text
Codex app-server session backend is ready.
Feishu event stream is ready.
Feishu approval card stream is ready.
```

让用户从预期的私聊或工作台话题发送一个无副作用测试，例如 `/help` 或 `/repos`，确认飞书收到回复。若使用工作台，还要确认无需 `@` 的消息能被处理。

冒烟成功后，在另一个终端优雅停止前台服务：

```powershell
node .\src\main.js stop --config "$config"
```

不得同时运行前台实例和正式部署。

## 阶段 8：正式部署

先告诉用户该命令会运行全量测试、创建仓库外 snapshot 并启动后台服务，然后执行：

```powershell
npm.cmd run deploy -- --config "$config"
```

Agent 验证：

- 命令退出码为 0。
- `$data\deployment-state.json` 存在，并记录 active runtime、PID 和日志路径。
- 读取 active 记录指向的 stdout 日志，确认其中包含 runtime、Codex app-server、飞书消息流和审批卡片流四项 readiness。部署命令本身不一定把子进程的 ready 行回显到当前终端。
- active runtime 和 bootstrap 都位于 `DataDirectory` 内，不在源码或受管仓库内。
- 飞书再次发送 `/status` 或 `/repos` 能收到回复。

部署失败时阅读本次 stderr 日志和回滚结果，不要删除锁文件、跳过测试或直接从源码设置自启动。

## 阶段 9：可选的登录自启动

先验证固定启动器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$launcher" -PlanOnly
```

只有用户明确需要时，才协助创建 Windows 任务计划。设置必须符合 [Windows 安装指南的登录自启动章节](INSTALL_WINDOWS.md#10-登录时自动拉起)：

- 使用完成 Codex/飞书登录的同一 Windows 用户。
- 触发器为用户登录，建议延迟 30 秒。
- 程序为 `powershell.exe`。
- 参数为 `-NoProfile -ExecutionPolicy Bypass -File "<DataDirectory>\launcher\start-bridge-windows.ps1"`。
- 不填写源码仓库作为起始目录。
- 如果任务已运行，不启动新实例。
- 不设置不合理的最长运行时间。

Agent 创建或修改任务计划前必须展示准确设置并取得用户确认。完成后用任务计划程序历史、任务状态或一次受控测试验证；不要仅凭任务存在就报告自启动成功。

## 完成条件

Agent 只能在以下项目全部满足时报告“安装完成”：

- 隔离 Codex CLI 和飞书 CLI 的版本与 `package.json.bridgeToolchain` 完全一致。
- Codex 登录状态有效，飞书 CLI profile 可用。
- 用户确认飞书权限、长连接事件、应用发布和管理员审批已完成。
- canonical 配置位于受管仓库之外，并且没有覆盖用户未确认的旧配置。
- doctor 没有 `FAIL`。
- 前台启动出现三项服务 ready 标志，飞书端冒烟消息收到回复。
- 正式 deploy 成功，并生成经过验证的 active snapshot。
- 正式部署后飞书仍能收到回复。
- `bridge.config.json`、真实 ID、Secret、凭据、日志和运行数据没有进入 Git 跟踪范围。
- 如果用户选择自启动，固定启动器的 `-PlanOnly` 和任务计划验证均成功；否则明确标记为“未配置（用户选择）”。

## Agent 最终报告格式

最终报告应简短，隐藏敏感值，并至少包含：

```text
安装结果：完成 / 未完成
隔离工具链：Codex <版本>，飞书 CLI <版本>
Canonical 配置：<绝对路径>
首个仓库：<别名> -> <绝对路径>
交互模式：私聊 / 工作台 / 二者并用
Doctor：通过 / 失败项
飞书冒烟：通过 / 未通过
正式部署：active PID、runtime 名称、日志目录（不要粘贴日志内容）
登录自启动：已验证 / 未配置 / 待人工验证
仍需用户完成：<没有则写“无”>
```

不要在最终报告中完整显示 `ou_...`、`oc_...`、App ID、App Secret、token、API Key 或 thread ID。

## 常见失败的处理原则

- 下载或联网被沙箱阻止：按平台流程申请对应命令的最小权限，不使用其他程序绕过。
- CLI 版本不匹配：重新运行 `install-windows.ps1 -ToolsOnly`，不要关闭版本检查。
- Codex 未登录：重新执行隔离入口的 `login`，不要切换到全局 CLI。
- 飞书 CLI profile 不可用：检查 profile 名称和 `config show`，不要把 App Secret 写进 JSON。
- 私聊正常、工作台无响应：检查 `workbenchChats`、`allowedChats`、群消息权限、机器人入群和重新发布状态。
- 审批卡片无响应：检查 `card.action.trigger`、长连接和应用重新发布，不要放宽审批策略。
- 已有实例运行：使用 `node .\src\main.js stop --config "$config"` 优雅停止；不要直接删除 `bridge.lock`。
- deploy 失败：阅读部署输出与本次日志，确认是否已自动回滚；不要手工启动未验证 snapshot。
- 用户暂时无法完成浏览器或管理员步骤：报告当前阶段和剩余人工动作，停止在安全边界内，不虚报完成。
