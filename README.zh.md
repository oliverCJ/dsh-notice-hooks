# dsh-notice-hooks

为用户和项目配置自动化 Hook，在会话、工具调用、权限请求和上下文压缩等事件发生时运行命令。Hook 授权需在“Hooks 设置”中手动管理。

[简明入口](./README.md)

## 环境要求

- DeepSeek Harness，Node.js 24.9.0 或更高版本
- `@deepseek-ai/dsh-session` `>=0.2.1-rc.1 <0.2.2 || >=0.2.2-0 <0.3.0`；Chat 活动提示依赖官方 plugin-record API
- 从源码构建时使用 `pnpm` 11.28.5
- 目标 Host profile 具有可用的 Session 与持久化基础设施

## 快速开始

### Desktop

1. 在 DeepSeek Harness 中打开 **设置 → 插件**。
2. 搜索 `dsh-notice-hooks`。
3. 从 npm 安装并启用插件。
4. 打开 **Hooks 设置**。

Desktop profile 由 Electron 应用专属管理；普通的 `dsh plugin --profile desktop` 命令会被有意拒绝。

### CLI profile

每个 DSH profile 独立安装插件。请把包安装到实际运行的 profile：

```sh
dsh plugin --profile web add dsh-notice-hooks
dsh plugin --profile headless add dsh-notice-hooks
dsh plugin --profile tui add dsh-notice-hooks
```

这些命令使用用户自己配置的 npm registry。可选镜像可能晚于 npm 官方源同步，不要向镜像重复发布。

### 安装后

1. 以 [`examples/hook.json`](./examples/hook.json) 为起点创建或编辑 `~/.dsh/hook.json`。
2. 打开 **Hooks 设置** 并重新加载配置。
3. 开启需要使用的 Hook 配置。
4. 检查命令内容，并明确授权当前执行指纹。

## 从源码安装

```sh
git clone https://github.com/oliverCJ/dsh-notice-hooks.git
cd dsh-notice-hooks
pnpm install
pnpm run check
pnpm pack
```

把生成的 tarball 安装到非 Desktop profile，版本变化时相应替换文件名：

```sh
dsh plugin --profile web add ./dsh-notice-hooks-0.1.2.tgz
```

推荐安装 tarball，因为它会验证与 npm 发布相同的文件集合。如果直接安装源码目录，必须先运行 `pnpm run build`，运行入口位于 `lib/`。

## Profile 支持矩阵

| Profile | 安装方式 | Host Hooks | Web Settings | 前置条件与说明 |
| --- | --- | --- | --- | --- |
| `web` | `dsh plugin --profile web add ...` | 支持 | 支持 | Web workspace provider 启用用户与项目双层作用域。 |
| `desktop` | 仅 Electron Plugin Manager | 支持 | 支持，位于内嵌 Web UI | 不要用普通 CLI 管理该 profile。 |
| `tui` | `dsh plugin --profile tui add ...` | 支持 | 不支持 | 要求已有可工作的 TUI 与 Session stack；终端 UI 不挂载 Web Settings。 |
| `headless` | `dsh plugin --profile headless add ...` | 支持 | 不支持 | 没有 workspace provider 时仍运行用户 Hook；项目 Hook 需要 provider。 |
| 自定义 | profile 对应的插件管理方式 | 有条件支持 | 有条件支持 | Host Hooks 需要 Session 生命周期服务；Settings 还需要 Web server 及兼容的 locale、renderer、Settings client 服务。 |

`workspaceRegistry` 是可选服务。服务存在时插件公开已注册项目作用域；服务缺失或无效时，插件继续以纯用户作用域运行。Bundle 不再插入 fallback workspace provider，也不会把任意 Session `cwd` 推断为可信项目作用域。

Session plugin-record runtime 在激活时同样是可选能力。若 profile 无法解析 Harness 自己持有的 `@deepseek-ai/dsh-session` 模块，Hook 执行、授权和 Settings 仍正常工作；只有紧凑 Chat 活动行关闭，并记录一次 Host warning。插件不会为此安装第二份 Session runtime。

安装后启用 `dsh-notice-hooks`。Settings 导航和页面标题在中文界面显示为 `Hooks 设置`，在英文界面显示为 `Hooks setting`。

插件读取用户配置 `~/.dsh/hook.json`，对所有项目生效。用户文件不存在时，用户 Store 会创建一个无 Hook 的禁用配置。可从 [`examples/hook.json`](./examples/hook.json) 开始；启用任何 Hook 前必须替换示例中的绝对路径。项目配置见下文的作用域说明，项目文件绝不会由插件自动创建。

## 配置格式

```json
{
  "version": 1,
  "hooks": {
    "PostToolUseFailure": [
      {
        "matcher": "^(bash|edit)$",
        "hooks": [
          {
            "id": "notify-tool-failure",
            "type": "command",
            "command": "node \"/absolute/path/to/notify.mjs\" --failed",
            "enabled": true,
            "timeoutMs": 10000,
            "maxConcurrent": 1
          }
        ]
      }
    ]
  }
}
```

- `version` 必须为 `1`。
- `hooks` 以受支持的事件名为键，每个值是 matcher 分组数组。
- `matcher` 是可选的、不区分大小写的 JavaScript 正则表达式；缺失或空字符串表示全部匹配。
- `id` 必填、不能为空，并且必须在当前配置文件内唯一；用户文件和每个项目文件属于独立作用域，可以使用相同的展示 ID。
- `type` 必须为 `"command"`。
- 只有 `enabled` 明确等于 `true` 才表示该 Hook 可被启用；它不会授予执行权限，授权只能由用户在 Hooks 设置或会话审核弹窗中明确完成。
- `timeoutMs` 默认 `10000`，范围为 `100` 到 `60000` 的整数。
- `maxConcurrent` 默认 `1`，每个 Hook 的范围为 `1` 到 `4` 的整数。

插件会监视并自动重载配置。无效 JSON、无效正则、重复 ID 或字段错误都会触发 fail-closed：配置恢复有效前不运行任何 Hook。Settings 修改 `enabled` 时会保留未知字段。无论是用户配置还是项目配置，直接写入 `enabled: true` 都不能授权 Hook。

## 双层作用域

插件支持两个独立配置作用域：

- 用户配置固定为 `~/.dsh/hook.json`，对所有项目生效。用户文件不存在时，用户 Store 会创建空的禁用配置。
- 项目配置固定为 `<workspace-root>/.dsh/hook.json`，只对该 DSH 已注册工作区的精确根目录生效。插件不会向上扫描目录；未注册目录不会获得项目作用域。
- 已注册工作区的会话按顺序先运行匹配的用户 Hook，再运行匹配的项目 Hook；每个文件内保持配置文档顺序。项目文件不存在时，该作用域表现为空并显示 `exists: false`，插件绝不会因为工作区存在或在 Settings 中选中它而自动创建项目文件，也不会创建项目 `.dsh` 目录。
- 会话工作区归属在首次观测时固定；之后不会因目录切换或注册表变化而改写本次会话的作用域归属。
- 用户配置与每个项目配置分别校验。用户配置 invalid 时仅禁用用户 Hook，有效项目 Hook 仍运行；项目配置 invalid 时仅禁用该项目 Hook，有效用户 Hook 仍运行。一个作用域的 Hook 失败不会传播到 Agent 或工具执行流程。
- 同一个 Hook 展示 ID 可以出现在不同作用域，但在各自配置文件内必须唯一。执行、统计、取消和修改均按作用域隔离。

## 授权模型

执行授权独立保存在 `~/.dsh/dsh-notice-hooks/authorizations.json`。该用户级文件位于权限为 `0700` 的插件目录中，文件权限固定为 `0600`。项目文件不能授予项目 Hook 权限；升级前已有的 `enabled: true` 配置也不会自动继承授权。

Hook 只有同时满足配置声明 `enabled: true`，且用户已通过 Hooks 设置或会话审核弹窗批准当前执行指纹时才会运行。指纹绑定作用域、Hook ID、事件、matcher 源文本、命令、超时和并发限制；任何一项发生变化都会使授权失效，必须再次手工启用。Settings 会区分“未授权”和“配置指纹已变化”，两种状态都 fail closed。

配置启用与执行授权是两个独立操作。启用开关只修改 `enabled` 声明：开启不会授予权限，关闭时先撤销授权再写 `enabled: false`。授权按钮和审核弹窗只授予或撤销当前指纹；撤销授权会保留配置启用，且不改变 config revision。授权要求配置已启用，并执行 revision、指纹和最终复核；最终复核失败时补偿撤销。所有修改事务全局串行。

## 事件与 matcher 值

| 事件 | 触发时机 | `matcher` 检查的值 |
| --- | --- | --- |
| `SessionStart` | 主会话创建 | 会话 origin，或空字符串 |
| `UserPromptSubmit` | 接收到用户消息 | `user` |
| `PreToolUse` | 工具调用前 | 工具名 |
| `PostToolUse` | 工具成功返回后 | 工具名；不可用时为空 |
| `PostToolUseFailure` | 工具失败返回后 | 工具名；不可用时为空 |
| `PermissionRequest` | 请求工具授权 | 工具名或类型 |
| `SubagentStart` | 子 Agent 会话创建 | Agent preset，缺失时为 `subagent` |
| `SubagentStop` | 子 Agent 会话销毁 | Agent preset，缺失时为 `subagent` |
| `Stop` | 一轮正常结束 | turn-end reason kind |
| `StopFailure` | 一轮以错误结束 | `error` |
| `PreCompact` | 上下文压缩开始 | `manual` 或 `automatic` |
| `PostCompact` | 上下文压缩成功 | `manual` 或 `automatic` |
| `PostCompactFailure` | 上下文压缩失败 | `manual` 或 `automatic` |
| `SessionEnd` | 主会话销毁 | 销毁原因，或空字符串 |

正则按常规语义匹配完整的 matcher 值。如果只接受精确工具名，请使用 `^bash$` 这样的锚点。

## 命令执行

`command` 是一条命令行字符串，插件将其解析为可执行文件和参数数组，并在会话工作目录中以 `shell: false` 启动。

```json
"command": "node \"/path with spaces/notify.mjs\" --channel desktop"
```

引号用于组合参数。管道、重定向、通配符、`$VARIABLE`、`~`、`&&` 和命令替换都不会被隐式解释。如果确实需要 shell，必须显式调用并把脚本引用成一个参数：

```json
"command": "/bin/sh -c \"printf '%s\\n' done >> /tmp/dsh-hook.log\""
```

应尽量直接调用可执行文件。对于 Agent，Hook 是 fire-and-forget；插件不排队、不重试。超过并发限制的执行会被跳过。禁用/删除 Hook、配置失效、插件卸载或超时都会终止活跃进程树。退出失败和命令输出不会进入 Agent 对话。

## stdin 协议

每个进程都会从标准输入收到一个以换行结束的 JSON 对象。Schema 版本 1 包含以下字段；没有值的字段为 `null`，不会省略。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schema_version` | `1` | 载荷协议版本 |
| `source` | `"deepseek-harness"` | 载荷来源 |
| `hook_event_name` | string | 上述 14 个事件名之一 |
| `session_id` | string | Harness 会话 ID |
| `cwd` | string 或 `null` | 会话工作目录 |
| `timestamp` | string | ISO 8601 事件时间 |
| `turn_id` | string 或 `null` | 可用时的一轮 ID |
| `agent_id` | string 或 `null` | 可用时的 Agent ID |
| `agent_type` | string 或 `null` | 主/子 Agent preset 信息 |
| `tool_name` | string 或 `null` | 相关工具名 |
| `tool_use_id` | string 或 `null` | 工具调用 ID |
| `tool_input` | 任意 JSON 值或 `null` | 已解析的工具参数 |
| `tool_response` | 任意 JSON 值或 `null` | 工具结果内容 |
| `prompt` | string 或 `null` | 用户提交的文本 |
| `last_assistant_message` | string 或 `null` | 当前活动会话中最近观测到的助手文本 |
| `reason` | string 或 `null` | 一轮、会话或授权原因 |
| `error` | string 或 `null` | 规范化错误文本 |
| `compaction_id` | string 或 `null` | 压缩生命周期 Hook 的 DSH 压缩 ID |
| `source_command_id` | string 或 `null` | 手工压缩命令 ID；自动压缩时为 null |

独立消费者示例：

```js
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (event.hook_event_name === 'StopFailure') {
  await sendNotification(event.error ?? 'Agent turn failed')
}
```

[`examples/capture-hook.mjs`](./examples/capture-hook.mjs) 是可执行的独立消费者，它会校验 stdin，并以原子替换方式保存最新载荷：

```sh
node examples/capture-hook.mjs /tmp/dsh-hook.json
```

## Settings

Settings 导航和页面标题在中文界面显示为 `Hooks 设置`，在英文界面显示为 `Hooks setting`。作用域选择器只向 Host 发送 public scope ID（`user` 或 `workspace:<id>`），不会发送客户端提供的路径或内部 runtime ID。

页面始终按固定顺序显示全部 14 个事件组；初始加载或服务不可用时也保留这些组，但在状态可用前禁止操作。包含配置的组默认展开，空组保持紧凑且可以展开；重新加载会保留每个作用域各自的展开状态。每个 Hook 都有配置启用开关和独立授权操作。开启配置后保持未授权，撤销授权后配置开关仍保持开启；两种情况都会进入待审核。关闭配置会撤销授权并停止审核提示。当前作用域存在待授权 Hook 时，页面会显示审核汇总条和每个 Hook 的状态；“审核”按钮会打开与当前会话共用的授权弹窗。只有当前会话的用户或项目作用域存在已声明启用但未授权的 Hook 时，输入框左侧才显示紧凑审核图标。弹窗在用户明确授权所选项或当前列表全部项之前，会展示 command、matcher、超时、并发、scope 和指纹变化状态；该操作不会授权未来新增 Hook 或变化后的指纹。Settings 展开详情仍显示命令、matcher、超时、并发限制、授权状态、近期聚合状态和 public scope。

作用域切换、重新加载和 revision 冲突恢复都有迟到响应保护，旧作用域的响应不会覆盖当前页面。工作区从注册表移除后，页面回退到用户作用域并显示本地化提示；项目配置缺失时显示空状态，不会创建文件。页面也会显示配置路径、无效配置和服务不可用状态，但不提供原始 JSON 编辑器。

写配置时使用 revision 和内容哈希检查，拒绝符号链接和非普通文件，并在同一目录原子替换。替换前检测到的外部编辑会被拒绝。Node.js 的可移植文件系统 API 不提供条件式 rename，因此不协作的外部写入若恰好发生在最终哈希检查与 rename 之间，仍存在一个很窄的竞态窗口。

## 授权审核

输入框审核图标只针对当前 Session：始终检查用户配置，并且只加入拥有当前 Session 的已注册 Workspace；不会扫描 cwd，也不会显示其他项目的待授权 Hook。只有已声明启用但当前指纹未授权的 Hook 才会显示图标。

审核弹窗默认不选中任何项目，展示 scope、事件、command、matcher、超时、并发和需要授权的原因。“授权所选”处理勾选项，“授权全部”只处理弹窗当前显示的 Hook。两者都按用户优先、项目随后和配置顺序调用既有单 Hook Host 事务。同一 scope 某项失败后停止后续项，其他 scope 可以继续；成功项立即移除，失败项保留。

状态会在控件挂载、打开弹窗、窗口重新获得焦点、连接重置时刷新，并在有 Session 审核控件时每 15 秒低频刷新。generation 检查阻止旧响应覆盖 Host 已确认的新状态。弹窗会圈定焦点；空闲时可通过 Escape 或遮罩关闭并把焦点还给触发按钮，提交授权期间保持打开。

## 会话活动提示

每次 Hook 事件调用只要至少匹配一个已配置 Hook，就会在 `conversation.chat.flow` 中输出一条紧凑的有序活动行。活动行采用 `Hook · <event> · <scope/id> <状态>` 的短格式，跟随设置中的代码字号但保留普通界面字体，并聚合用户和项目两个作用域中已触发与被阻止的 Hook，保持用户优先于项目的顺序。被阻止项区分配置声明已禁用、尚未授权和执行指纹已变化。

Host 使用官方 `appendPluginRecord()` API 传输提示。记录带 `ignorable` 标记，不进入模型上下文；随 Session 持久化只是实现结果。畸形载荷、其他 owner 记录和未来协议版本都不会渲染。`SessionEnd` Hook 仍照常执行，但此时 Session 已离开活动 Store，因此有意不输出活动行。

## 限制与隔离

- 序列化 stdin 载荷最大 128 KiB
- stdout、stderr 各最多保留 64 KiB，剩余输出仍会被读取并丢弃
- 命令字符串最大 8192 字符
- 超时范围 100 到 60000 ms
- 每个 Hook 并发 1 到 4
- 配置监视合并窗口 100 ms
- 不隐式使用 shell
- 不提供队列、重试或输出历史

Hook 的启动失败、非零退出、超时和解析失败只记录诊断，不会拒绝或改变 Harness 的 Agent/工具操作。

## 故障排查

**Hook 没有运行**

确认 `enabled` 明确为 `true`、Settings 配置开关已开启、授权状态为“已授权”、事件名受支持、正则匹配上表中的值，并且无需 shell 展开就能找到可执行文件。直接编辑配置不能授予授权。重新加载 Settings，查看配置诊断。

**出现 `ENOENT`**

使用可执行文件和脚本的绝对路径，并确认会话 `cwd` 存在。没有显式 shell 时，`~` 和环境变量不会展开。

**命令在终端可用，但在 Hook 中失败**

移除终端 shell 语法，或者明确调用 `/bin/sh -c`、`cmd.exe /d /s /c` 等 shell，并把 shell 脚本保留为一个带引号的参数。

**Settings 开关写入被拒绝**

配置可能在页面加载后被外部修改，或者文件不是安全的普通文件。重新加载，修复配置错误后再试。

## 开发与发布检查

```sh
pnpm run typecheck
pnpm run typecheck:test
pnpm run test
pnpm run build
pnpm pack --dry-run
```

许可证：[MIT](./LICENSE)。
