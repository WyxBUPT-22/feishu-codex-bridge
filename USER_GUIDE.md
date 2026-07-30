# 飞书 Codex Bridge 用户使用指南

这份文档面向项目的实际使用者，目标是让你完成一次配置后，可以通过飞书私聊或“Codex 工作台”话题操作本机 Codex，并在手机与 Codex Desktop/CLI 之间继续同一个会话。

> 这个项目依赖你的电脑运行桥接服务。电脑关机、休眠、断网，或桥接服务未启动时，飞书中的任务不会执行。

> 第一次在新电脑上部署时，请先按 [Windows 从零安装指南](INSTALL_WINDOWS.md)完成隔离工具链、飞书应用、canonical 配置和后台启动；本文主要说明安装后的日常使用。

## 你可以用它做什么

- 在飞书中给某个本地仓库创建 Codex 任务。
- 在手机上继续上一次 Codex 会话。
- 绑定电脑端已经存在的 Codex thread，并在两端接力。
- 管理多个白名单仓库，避免 Codex 操作未授权目录。
- 在飞书中按风险自动处理常规操作，并逐次批准或拒绝敏感操作。

最推荐的使用方式是：一个飞书工作台话题对应一个 Codex 会话。进入对应话题直接续聊，需要时再回到电脑端接手。

## 一、使用前确认

隔离工具链与 canonical 配置的默认位置如下：

```powershell
$data = Join-Path $env:LOCALAPPDATA "feishu-codex-bridge"
$codexEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@openai\codex\bin\codex.js"
$larkEntry = Join-Path $data "tools\bridge-toolchain\node_modules\@larksuite\cli\scripts\run.js"
$config = Join-Path $data "config\bridge.config.json"

node --version
node $codexEntry --version
node $codexEntry login status
node $larkEntry --version
node $larkEntry --profile codex-remote config show
```

桥接器专用 Codex CLI 必须与 `package.json` 的 `bridgeToolchain.codex` 精确一致。全局 Codex CLI 可以独立升级，但新版 Desktop/CLI 写入的共享会话格式仍需兼容性验证。

默认配置不处理群消息。启用工作台后，桥接器也只处理 `workbenchChats` 白名单中的私有群；免 `@` 使用还需要飞书“获取群组中所有消息”权限。应用凭据由飞书 CLI 保存，不要把 App Secret 写进项目配置或 Git。

## 二、配置桥接器

### 1. 创建本地配置

推荐由 [Windows 安装器](INSTALL_WINDOWS.md#7-生成-canonical-配置)生成配置。只有手动安装时，才从示例创建仓库外 canonical 配置：

```powershell
$configDirectory = Join-Path $env:LOCALAPPDATA "feishu-codex-bridge\config"
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
$config = Join-Path $configDirectory "bridge.config.json"
Copy-Item bridge.config.example.json $config
```

`$config` 是生产环境唯一配置源，不应提交到 Git。仓库根目录的 `bridge.config.json` 只作为可选开发 shadow；如果保留，必须与 canonical 配置一致，否则正式快照和部署会拒绝继续。至少修改以下内容：

```json
{
  "version": 1,
  "lark": {
    "profile": "codex-remote",
    "allowedSenders": [
      "ou_这里替换为你的_open_id"
    ],
    "allowedChats": [],
    "workbenchChats": [],
    "p2pOnly": true,
    "allowedMessageTypes": ["text", "post"],
    "maxMessageAgeMinutes": 10
  },
  "larkCliEntry": "C:\\replace\\with\\lark-cli\\scripts\\run.js",
  "repositories": {
    "my-project": {
      "path": "E:\\projects\\my-project"
    }
  },
  "defaultRepository": "my-project",
  "codex": {
    "sandbox": "workspace-write",
    "approvalPolicy": "never",
    "model": null,
    "provider": null,
    "maxRuntimeMinutes": 60,
    "entry": "C:\\replace\\with\\codex\\bin\\codex.js",
    "appServer": {
      "enabled": true
    }
  },
  "queue": {
    "concurrency": 1
  },
  "desktopSync": {
    "pollIntervalMs": 5000
  },
  "limits": {
    "maxPromptChars": 8000,
    "maxReplyChars": 12000,
    "processedMessageLimit": 2000,
    "storedJobLimit": 500
  },
  "dataDirectory": "C:\\Users\\你的用户名\\AppData\\Local\\feishu-codex-bridge"
}
```

配置时注意：

- `allowedSenders` 只填写可信用户的 `ou_...`，不要为了省事开放给所有人。
- 启用工作台时，把私聊和工作台群的 `oc_...` 都放进 `allowedChats`，把工作台群另外放进 `workbenchChats`，并将 `p2pOnly` 设为 `false`。
- `repositories` 的键是飞书中使用的仓库别名，只能包含字母、数字、下划线和连字符，最长 32 个字符。
- 仓库路径必须是绝对路径；Windows JSON 路径中的反斜杠要写成 `\\`。
- `defaultRepository` 必须与 `repositories` 中的某个别名完全一致。
- `dataDirectory` 必须位于所有受管仓库之外，用于保存状态、锁、快照和日志。
- 日常需要让 Codex 修改代码时使用 `workspace-write`；只希望查询和分析时可改为 `read-only`。
- `approvalPolicy` 必须保持 `never`。项目会通过自己的审批代理向飞书发送单次确认请求。
- `larkCliEntry` 和 `codex.entry` 必须指向安装器生成的隔离工具入口；不要改成未经验证的全局最新版。
- `desktopSync.pollIntervalMs` 可在 1000-60000 毫秒之间调整，默认 5000 毫秒。
- API Key 不要写入此文件，继续使用 Codex CLI 自身的登录凭据。

要增加更多仓库，可在 `repositories` 中继续添加：

```json
"repositories": {
  "frontend": { "path": "E:\\projects\\frontend" },
  "backend": { "path": "E:\\projects\\backend" }
}
```

### 2. 运行自检

```powershell
npm.cmd run doctor -- --config "$config"
```

正常情况下，配置、仓库、飞书 CLI、飞书 profile、Codex 登录、Codex 版本和 app-server 检查都应显示 `PASS`。`codex-read-isolation` 显示 `WARN` 是安全提醒，不等同于启动失败。

遇到 `FAIL` 时先不要启动服务，按照输出逐项修复。常见原因是：路径写错、`open_id` 格式错误、CLI 未登录、飞书 profile 名称不一致，或 Codex CLI 版本不匹配。

## 三、启动并完成第一次任务

首次使用建议以前台方式启动，方便直接观察日志：

```powershell
npm.cmd start -- --config "$config"
```

看到前两行后，服务即可处理普通消息；第三行表示审批按钮也已启用：

```text
Codex app-server session backend is ready.
Feishu event stream is ready.
Feishu approval card stream is ready.
```

现在私聊飞书机器人：

```text
/help
```

如果机器人成功回复，再发送一个低风险测试任务：

```text
/task 阅读当前项目并用三点概括它的用途，不要修改文件
```

任务完成后可以查看状态：

```text
/status
```

停止前台服务时，在 PowerShell 中按 `Ctrl+C`，等待桥接器完成清理后退出。

## 四、日常最顺手的使用流程

### 推荐：在工作台话题中使用

在“Codex 工作台”中新建一个话题，第一条消息发送：

```text
/start my-project 检查登录模块并说明最可能的问题
```

任务完成后，这个话题会固定绑定对应仓库和 Codex 会话。之后直接发送普通文字即可继续，不需要再写 `/continue`。进度、审批卡片、最终结果和电脑端同步都会留在这个话题里。

一个已绑定话题不能切换仓库或改绑成另一条会话。需要新的 Codex 会话时，请新建新的飞书话题。

### 场景 A：直接从飞书创建新任务

```text
/repo my-project
/task 检查登录模块最近的实现，解释可能的异常路径，暂时不要修改代码
```

准备让它继续实现时：

```text
/continue 根据刚才的分析修复最可能的问题，并运行相关测试
```

建议把“分析”和“修改”拆成两轮，这样你可以先确认方向，再批准实际操作。

### 场景 B：从电脑无缝接力到手机

这是本项目最有价值的工作流：

1. 在 Codex Desktop 或 CLI 中打开目标仓库并产生一个会话。
2. 在飞书中切换到同一仓库，并列出可用会话：

   ```text
   /repo my-project
   /sessions
   ```

3. 根据返回的编号绑定会话：

   ```text
   /attach 1
   ```

4. 在手机上继续同一个 thread：

   ```text
   /continue 继续刚才的工作，先告诉我当前进度和下一步
   ```

5. 回到电脑后切换回来或重新打开对应任务，即可继续查看和接手。

首次 `/attach` 只建立同步基线，不会把完整历史重新发送到飞书。电脑端完成新的 turn 后，桥接器通常会在 5 秒内把摘要发到飞书；`desktopSync.pollIntervalMs` 可在 1000-60000 毫秒之间调整。

飞书端完成的 turn 会立即写入同一份本地会话记录，但 Codex Desktop 当前没有提供让其他进程主动刷新已打开任务的接口。因此“电脑端内容推到飞书”的 5 秒轮询不能解决反方向的 UI 刷新；Desktop 未立即显示时，需要切换任务或重新打开该任务。

### 场景 C：切换多个仓库

```text
/repos
/repo backend
/status
```

会话状态按仓库管理。切换仓库后，先用 `/status` 或 `/sessions` 确认当前上下文，再发送任务，可以减少把需求发错项目的风险。

### 场景 D：从历史会话创建安全分支

```text
/sessions
/fork 2
/continue 尝试另一种实现方式，不影响原来的会话
```

当你想保留原 thread，同时试验不同方案时使用 `/fork`。

## 五、如何处理操作审批

默认审批模式是 `balanced`。可信读取与普通仓库内修改不会再占据对话框；Codex 判定为不可信的命令，以及删除、移动或混合补丁，仍会发送交互审批卡片。卡片会显示操作摘要、仓库、任务号和有效期。

新任务默认使用一张持续更新的任务控制卡：排队、执行进度、待审批操作、审批结果、统计和停止按钮都会集中在这张卡中。点击审批或停止后，卡片状态会直接变化；完整的最终回答仍会作为话题内的独立消息发送。若飞书消息更新接口暂时不可用，桥接器会自动退回独立审批卡片和文本进度，不会让任务失去审批入口。

人工审批在控制卡中等待超过 10 秒时，桥接器会对原任务卡发送一次飞书应用内加急，让移动端在飞书处于后台时也能收到通知。自动审批、10 秒内已经处理的审批以及独立降级审批卡不会触发加急。若应用没有 `im:message.urgent:app_send` 权限或飞书拒绝加急，原话题会收到一条简短文字提醒，审批入口仍保留在任务控制卡中。

可以随时查询或切换当前飞书话题的模式：

```text
/approval
/approval strict
/approval balanced
/approval auto
```

| 模式 | 行为 |
| --- | --- |
| `strict` | 所有可审批的 shell 和文件修改都逐次确认 |
| `balanced` | 默认；可信读取和仓库内纯 Add/Update 自动通过，未知或高风险操作人工确认 |
| `auto` | 所有已验证的仓库内补丁都自动通过（包括混合、删除和移动）；不可信 shell 仍需确认 |

模式在任务创建时冻结，只影响之后新建的任务。提权、联网、仓库外工作目录、路径无法验证或输入字段歧义不会因为模式变化而放行。任务结束消息会汇总自动与人工审批次数。

确认操作内容、目标仓库和路径都符合预期后，点击“批准本次”；不确定或不希望执行时点击“拒绝”。每次点击只处理卡片对应的这一项操作。

如果按钮不可用，仍可使用卡片底部的 6 位确认码：

```text
/approve a1b2c3
```

拒绝时发送：

```text
/deny a1b2c3
```

按钮和审批码：

- 只对当前发送者、聊天和任务有效；
- 按钮还会绑定原始卡片消息和当前活跃 turn；
- 只能使用一次；
- 约 5 分钟后失效；
- 服务重启、任务取消或发送失败时会默认拒绝。

不要只看“命令看起来熟悉”就批准。尤其要核对删除、移动、批量替换、Git 操作和可能包含凭据的路径。

## 六、命令速查

| 命令 | 用途 |
| --- | --- |
| `/task <任务>` | 在当前仓库新建会话并执行任务 |
| `/continue <任务>` | 继续当前绑定或最近一次会话 |
| `/start <仓库> <任务>` | 在新的工作台话题中选定仓库并创建会话 |
| `/repos` | 查看配置允许操作的仓库 |
| `/repo <别名>` | 切换当前仓库 |
| `/sessions` | 查看当前仓库可绑定的 Desktop/CLI 会话 |
| `/attach <编号>` | 绑定已有会话 |
| `/detach` | 解除当前会话绑定 |
| `/fork <编号>` | 从已完成的历史会话创建并绑定分支 |
| `/approval [strict\|balanced\|auto]` | 查看或切换当前话题的审批模式 |
| `/status` | 查看队列和当前任务状态 |
| `/cancel` | 取消当前任务 |
| `/cancel <任务号>` | 取消指定任务 |
| `/approve <确认码>` | 单次批准待执行操作 |
| `/deny <确认码>` | 拒绝待执行操作 |
| `/takeover` | 请求接管存在写入冲突的会话，并获得二次确认码 |
| `/takeover <确认码>` | 确认接管并中断冲突 turn |
| `/new` | 清除当前仓库记录的会话选择 |
| `/help` | 查看机器人内置帮助 |

## 七、几个容易混淆的行为

- `/task` 会创建新会话；想沿用上下文时用 `/continue`。
- 工作台话题绑定后，普通文字自动等价于 `/continue`；私聊中的普通文字仍不会执行。
- 工作台话题与仓库、Codex 会话固定绑定；`/new`、`/detach` 和切换仓库不会在已绑定话题中生效。
- `/new` 是清除桥接器为当前仓库保存的会话选择，不是删除仓库，也不是删除本地文件。
- `/detach` 解除绑定后，电脑侧的原 thread 仍然存在。
- `/sessions` 只显示路径精确匹配白名单仓库且模型 provider 一致的会话。
- 同一时间只执行一个任务；新的任务可能进入队列，这是安全设计而不是卡死。
- 如果电脑端和飞书端同时写同一个 thread，桥接器可能要求 `/takeover` 二次确认。
- 回复过长时会被截断。可以让 Codex“分段回答”或“只给结论和文件位置”。
- Desktop 可能不会立刻刷新外部 app-server 写入的 thread；当前没有公开的跨进程刷新接口，必要时切换任务或重新打开任务。

## 八、常见问题排查

### 机器人没有回复

依次检查：

1. 运行窗口是否同时出现两个 ready 日志。
2. 电脑是否联网且没有休眠。
3. 是否在私聊机器人，而不是群聊。
4. 你的 `ou_...` 是否已加入 `allowedSenders`。
5. 飞书应用是否已发布、获批，并订阅 `im.message.receive_v1`；若仅审批按钮无响应，再确认 `card.action.trigger` 和 `im:message:readonly`。
6. 运行：

   ```powershell
   node $larkEntry --profile codex-remote event status --current --json
   npm.cmd run doctor -- --config "$config"
   ```

### `doctor` 提示 Codex 版本不支持

确认 canonical 配置中的 `codex.entry` 指向隔离工具链，然后重新运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-windows.ps1 -ToolsOnly
```

不要降级全局 Codex，也不要通过跳过版本检查来强行运行。

### `/sessions` 看不到电脑端会话

确认：

- 电脑端会话的工作目录与配置中的仓库绝对路径完全一致；
- 已在飞书中切换到正确仓库；
- 电脑端和桥接器使用兼容的模型 provider；
- 会话已经实际产生过内容。

### 修改配置后没有生效

canonical `dataDirectory\config\bridge.config.json` 只在启动时读取。修改 canonical 后同步更新或删除仓库 shadow，再运行 `npm.cmd run deploy -- --config "$config"`；部署器会在新版本未就绪时自动恢复旧版本。

### 提示已有实例正在运行

不要启动第二份服务，也不要直接删除锁文件来绕过单实例保护。更新正式服务统一运行 `npm.cmd run deploy -- --config "$config"`，部署器会使用本地控制通道完成优雅替换。

### 任务长时间没有结束

先发送：

```text
/status
```

确认任务号后可发送：

```text
/cancel <任务号>
```

## 九、长期运行建议

调试阶段可以使用 `npm.cmd start -- --config "$config"`。正式更新统一运行 `npm.cmd run deploy -- --config "$config"`：它会测试、生成仓库外 runtime snapshot、优雅替换、检查完整 readiness，并在失败时自动回滚。登录时拉起请按 [Windows 安装指南](INSTALL_WINDOWS.md#10-登录时自动拉起)让任务计划程序调用 `dataDirectory\launcher` 中的固定启动器；它只重启已验证的 active snapshot，不会从可能被 Codex 修改的源码仓库发布新版本，也不等同于跨部署的持续崩溃监管。

常驻使用时还建议：

- 为桥接服务使用独立 Windows 用户、WSL 或容器身份，强化凭据读取隔离。
- 只配置确实需要远程操作的仓库。
- 定期运行 `npm.cmd run doctor -- --config "$config"`。
- 更新桥接器工具链、本项目代码或 canonical 配置后运行带显式 `--config` 的 deploy。
- 不要把飞书凭据、Codex 凭据、运行日志或 `dataDirectory` 放进受管仓库。

需要安装、更新、回滚或卸载时查阅 [Windows 安装指南](INSTALL_WINDOWS.md)；需要安全边界、架构和项目验证命令时继续查阅 [README.md](README.md)。
