# dsh-notify

一个 DeepSeek Harness（DSH）插件（bundle）：当会话**完成任务**或**向用户提问（需要选择/回答）**时，发送桌面通知，让你把 DSH 挂到后台跑长任务时不错过关键节点。

> 本插件是纯事件观察者：只监听会话事件流，不拦截、不修改任何会话行为；通知失败绝不会影响会话本身。

## 功能

触发通知的三种时机（均可单独开关）：

| 触发时机 | 会话事件 | 通知示例 |
|---|---|---|
| 一轮对话正常结束（agent 回答完毕、回到空闲） | `turn/end`，`reason.kind === 'completed'` | `DSH · 回答完成` + 回答摘要 |
| 持久化目标（goal）完成 | `goal/change`，`operation === 'complete'` | `DSH · 任务完成` + 目标内容 |
| agent 调用 `ask_user_question` 向你提问 | `tool/call`，`name === 'ask_user_question'` | `DSH · 需要你的回答` + 问题与选项 |

通知后端可选：Linux 桌面 `notify-send`（自动检测，缺失时降级为控制台）、任意自定义命令（占位符 `{title}`/`{message}`）、纯控制台输出。

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
    onlyQuestionsWithChoices: false
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
| `onlyQuestionsWithChoices` | boolean | `false` | 为 `true` 时只通知带选项（需选择）的问题 |
| `previewMaxChars` | number | `120` | 通知正文中回答摘要/目标内容的截断长度 |
| `debounceMs` | number | `0` 及以上 | 同类通知的最小间隔（毫秒），避免同一时刻连发多条 |

自定义命令示例（macOS）：

```yaml
config:
  backend: command
  command: 'osascript -e "display notification \"{message}\" with title \"{title}\""'
```

## 工作原理

```
DSH 会话事件流 (session/event)
   ├─ turn/end (completed) ──────► 回答完成 ──┐
   ├─ goal/change (complete) ────► 任务完成 ──┤► 防抖 ─► 通知后端
   └─ tool/call (ask_user_question) ► 需要回答 ─┘       (notify-send / command / console)
```

- 插件声明 `inject: ['sessions']`：等待 `dsh-session` 服务就绪后加载（每个 profile 的 `dsh-base` 都提供）。
- 通过 `ctx.on('session/event', …)` 订阅事件流；`session/disposed` 时清理会话状态。
- 监听器整体 try/catch 包裹：`session/event` 处于会话热路径上，任何通知故障都会被吞掉并只写入日志，绝不冒泡。
- 通知进程以 detached 方式派生并 `unref()`，不阻塞、不等待；退出码非零或 stderr 有输出会记录到 DSH 日志。
- 所有注册（监听器、effect）都由 Cordis 随插件卸载自动回收，支持 HMR。

## 开发

```sh
npm install          # 依赖（沙箱环境可加 --cache ./.npm-cache）
npm run build        # tsc → lib/
npm test             # 构建 + 15 个 cordis 运行时测试（无需 LLM/网络）
```

测试直接加载构建产物：在裸 Cordis 根上下文上提供假 `sessions` 服务，注入合成会话事件并断言通知输出（含防抖、选项过滤、会话清理等边界情况）。

## 许可证

MIT
