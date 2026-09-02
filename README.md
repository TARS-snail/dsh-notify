# dsh-notify

一个 DeepSeek Harness（DSH）插件（bundle）：当会话**完成任务**或**向用户提问（需要选择/回答）**、且用户**不在会话中**时，发送桌面通知并播放系统默认提示音，让你把 DSH 挂到后台跑长任务时不错过关键节点。

> 本插件是纯事件观察者：只监听会话事件流，不拦截、不修改任何会话行为；通知失败绝不会影响会话本身。

## 功能

### 触发时机（均可单独开关）

| 触发时机 | 会话事件 | 通知示例 |
|---|---|---|
| 一轮对话正常结束（agent 回答完毕、回到空闲） | `turn/end`，`reason.kind === 'completed'` | `DSH · 回答完成` + 回答摘要 |
| 持久化目标（goal）完成 | `goal/change`，`operation === 'complete'` | `DSH · 任务完成` + 目标内容 |
| agent 调用 `ask_user_question` 向你提问 | `tool/call`，`name === 'ask_user_question'` | `DSH · 需要你的回答` + 问题与选项 |
| 某个动作超出当前审批策略、需要你审批 | `approval/asked` | `DSH · 需要审批` + 工具名与原因 |

### 在场检测（presence）——只在离开时打扰

浏览器端插件（`dsh.client` 客户端半部）把**当前选中的会话 + 页面可见性**实时上报给宿主：

- 页面是当前标签页 **且** 窗口有焦点 → 视为"在会话中" → **不弹**通知
- 切到别的标签页 / 别的应用 / 最小化 / 关闭页面 → 视为"离开" → 正常弹通知
- 心跳 + 最后状态兜底：标签页崩溃或断连后宿主侧 45 秒（TTL）自动过期，不会永久静音
- 无浏览器场景（headless / tui）没有上报 → 恒为"离开" → 全部通知

### 系统默认提示音

每次弹出桌面通知时，按顺序尝试 `canberra-gtk-play -i message`（系统声音主题的默认提示音）、`pw-play`/`paplay`（freedesktop `message.oga`），都不可用则只记录日志、保持静默。可通过 `playSound` 关闭。

### 通知后端

Linux 桌面 `notify-send`（自动检测，缺失时降级为控制台）、任意自定义命令（占位符 `{title}`/`{message}`）、纯控制台输出。

## 架构

```
浏览器（客户端半部 lib/client.js）                     宿主（bundle 行）
┌──────────────────────────────┐        ┌──────────────────────────────────┐
│ dsh-notify/client            │  RPC   │ dsh-notify/rpc  →  ctx.presence   │
│ visibilitychange / blur /    │ ─────► │ POST /dsh-notify/presence        │
│ focus / pagehide / 心跳(15s) │        │        │                         │
│ 当前会话 + 页面可见性         │        │        ▼                         │
└──────────────────────────────┘        │ dsh-notify 主插件                │
                                        │ session/event → 抑制检查 → 通知  │
                                        └──────────────────────────────────┘
```

bundle 声明了两个宿主行：`notify`（`inject: ['sessions']`，提供 `presence` 服务，headless 可用）和 `notify-rpc`（`inject: ['connection', 'presence']`，仅在 Web 宿主注册 RPC 通道，headless 下自动挂起）。客户端半部通过 `dsh.client` 清单随 Web 装配加载，由构建脚本打包成 `window.__ModuleLoader__` 惰性工厂格式。

## 安装

本包是一个符合 DSH 规范的 **bundle**：`package.json` 中声明了 `dsh.bundle.patch`，指向随包发布的 `cordis.patch.yml` 配置层。

### 从本地目录安装（开发/自用）

```sh
# 1. 构建（lib/ 产物；link 方式安装不会自动跑 prepare）
npm install
npm run build

# 2. 安装进某个 profile（首次使用该 profile 会自动初始化）
dsh plugin --profile web add /path/to/DSH_remind
```

`dsh plugin` 检测到包声明了 `dsh.bundle` 后，会自动把它追加进该 profile 的 `dsh.profile.bundles` 层列表。重启该 profile（如 `dsh web`）后生效。

### 从 GitHub 安装

发布到仓库后：

```sh
dsh plugin --profile web add github:you/dsh-notify#<commit-sha>
```

git 依赖安装时 pnpm 会执行 `prepare` 脚本（即 `npm run build`）自动构建 `lib/`；pnpm ≥ 10 需要你在 profile 目录的 `pnpm-workspace.yaml` 里允许执行构建脚本（首次 `add` 失败时 `dsh` 会打印确切的键）：

```yaml
allowBuilds:
  dsh-notify: true
```

### 验证配置层（不启动）

```sh
dsh --profile web --patch /path/to/DSH_remind/cordis.patch.yml --dump-config
# 应能看到 "# == .../cordis.patch.yml" 下的 notify 行
```

## 配置

默认零配置可用。在 profile 的 `cordis.patch.yml`（用户层）中按 id 覆盖该行：

```yaml
- id: notify
  name: dsh-notify
  config:
    backend: notify-send
    urgency: normal
    expireMs: 10000
    onTurnComplete: true
    onGoalComplete: true
    onUserQuestion: true
    onApproval: true
    onlyQuestionsWithChoices: false
    onlyWhenAway: true
    presenceTtlMs: 45000
    playSound: true
    titlePrefix: DSH
    previewMaxChars: 120
    debounceMs: 1000
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `backend` | `auto \| notify-send \| console \| command` | `auto` | `auto`：有 `notify-send` 用桌面通知，否则降级控制台 |
| `command` | string | `''` | `command` 后端的命令模板，经 `/bin/sh -c` 执行；`{title}`、`{message}` 被替换，引号转义由命令作者负责 |
| `urgency` | `low \| normal \| critical` | `normal` | `notify-send` 的紧急度 |
| `expireMs` | number | `10000` | `notify-send` 展示时长（毫秒，`0` = 常驻直到关闭） |
| `titlePrefix` | string | `DSH` | 通知标题前缀 |
| `onTurnComplete` | boolean | `true` | 一轮回答完成时通知 |
| `onGoalComplete` | boolean | `true` | goal（长期任务）完成时通知 |
| `onUserQuestion` | boolean | `true` | agent 提问时通知 |
| `onApproval` | boolean | `true` | 某个动作需要用户审批时通知 |
| `onlyQuestionsWithChoices` | boolean | `false` | 为 `true` 时只通知带选项（需选择）的问题 |
| `onlyWhenAway` | boolean | `true` | 为 `true` 时，正在浏览该会话（当前标签页且窗口有焦点）就不弹通知；离开才弹 |
| `presenceTtlMs` | number | `45000` | 浏览器上报的在场状态有效期（毫秒）；标签页停止上报（崩溃/断连）后超过该时长即视为离开 |
| `playSound` | boolean | `true` | 弹通知时播放系统默认提示音（`canberra-gtk-play -i message` → `pw-play`/`paplay` 兜底） |
| `previewMaxChars` | number | `120` | 通知正文中回答摘要/目标内容的截断长度 |
| `debounceMs` | number | `0` 及以上 | 同类通知的最小间隔（毫秒），避免同一时刻连发多条 |

自定义命令示例（Linux，`command` 后端）：

```yaml
# 例 1：通知 + 自定义提示音文件（替换默认提示音）
config:
  backend: command
  command: 'notify-send --app-name "DeepSeek Harness" --urgency critical "{title}" "{message}" && paplay "$HOME/.local/share/sounds/custom.oga"'
```

```yaml
# 例 2：通知 + 留痕到日志文件（方便事后回看）
config:
  backend: command
  command: 'notify-send "{title}" "{message}"; echo "$(date "+%F %T") {title} | {message}" >> "$HOME/.local/share/dsh-notify.log"'
```

```yaml
# 例 3：用 zenity 弹常驻气泡（不会自动消失，需手动关闭）
config:
  backend: command
  command: 'zenity --notification --text="{title}：{message}"'
```

> 说明：`command` 模板经 `/bin/sh -c` 执行，`{title}`/`{message}` 会被原样替换，其中的引号/空格转义由你自己负责。绝大多数场景直接用默认 `notify-send` 后端即可，`command` 只在你需要自定义声音、留痕或换通知工具时才用。

## 工作原理

```
浏览器（页面）                           宿主（本 bundle）
 会话选中变化 ─┐
 visibility/focus/blur ─┼─► RPC /dsh-notify/presence ─► ctx.presence（TTL 状态表）
 心跳 15s ─────┘                                        │
                                                        ▼
DSH 会话事件流 (session/event) ─────────────────► 离开检查（isAttended）─► 防抖 ─► 通知 + 提示音
```

- 主插件声明 `inject: ['sessions']`：等待 `dsh-session` 服务就绪后加载（每个 profile 的 `dsh-base` 都提供），并提供 `presence` 服务。
- 通过 `ctx.on('session/event', …)` 订阅事件流；`session/disposed` 时清理会话状态。
- 监听器整体 try/catch 包裹：`session/event` 处于会话热路径上，任何通知故障都会被吞掉并只写入日志，绝不冒泡。
- 通知与提示音进程以 detached 方式派生并 `unref()`，不阻塞、不等待；退出码非零或 stderr 有输出会记录到 DSH 日志。
- 所有注册（监听器、effect、RPC 通道）都由 Cordis 随插件卸载自动回收，支持 HMR。
- 客户端半部保持零 import（构建期纯度门禁），由 `scripts/build-client.mjs` 打包成 Web 装配所需的惰性工厂格式。

## 开发

```sh
npm install          # 依赖（沙箱环境可加 --cache ./.npm-cache）
npm run build        # tsc → lib/（宿主）+ lib/client.js（客户端 bundle）
npm test             # 构建 + 32 个测试（宿主事件/在场抑制/审批触发/客户端 DOM 模拟，无需 LLM/网络）
```

测试直接加载构建产物：在裸 Cordis 根上下文上提供假 `sessions`/`connection` 服务，注入合成会话事件与在场上报并断言通知输出；客户端半部在 mock 的 DOM 与 ModuleLoader 上运行。

## 许可证

MIT
