# dsh-mailbox · FurtherAgent 独立留言箱

把本机已有的 `FurtherAgent.Cli.exe` 包装成 4 个 DSH 原生工具，让小夜在**自己的活动节奏里**
主动查收和回信。不建身份、不动中继、不改客户端。

- **不新增定时器/唤醒/轮询**：什么时候看、什么时候回，由小夜自己决定。
- **不自动转成会话消息**：没有 `send` / `steer`，不会因为来了一条留言就起一个模型轮次。
- **凭据不经过插件**：只把账户描述文件的**路径**交给 CLI，插件从不读它的内容，也不写日志。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `mailbox_status` | 无 | 账户、未读数、最新序号、用户已读到、小夜已读到 |
| `mailbox_read` | `limit`(1~50，默认 20)、`after`、`before` | 消息数组（`Sequence`/`Sender`/`Text`/`CreatedAt`）、`HasMore`、`HasOlder`、最新序号 |
| `mailbox_mark_read` | `through`（必填） | 已确认到、小夜已读到、说明 |
| `mailbox_reply` | `text`（必填）、`id`（固定 GUID，可省） | 是否已保存、消息 ID、序号、时间 |

行为约定：

- `read` **默认从「小夜已读位置」之后**开始，读本身**不**标已读。
- `HasMore=true` 时，用这一页**最后实际取得**的 `Sequence` 当 `after` 继续翻，不要拿最新序号跳。
- `mark_read` 只在你确实读完那些之后调用；插件会挡住两类越权：`through` 超过最新序号、
  超过本进程实际读到过的最大序号。
- `reply` 的正文走 **UTF-8 临时文件** + `--text-file`，进程用**参数数组**启动，不拼 shell 命令。
  没传 `id` 就自动生成并回传；**结果未知时沿用同一个 GUID 重试**，不要换新 ID。
  只有拿到 CLI 的 `mailbox-saved` 才报「已保存」。

## 配置

`%DSH_HOME%\dsh-mailbox.json`（默认 `C:\Users\32138\.dsh\dsh-mailbox.json`）：
只放路径和超时，**不放密钥**：

```json
{
  "命令行": "D:\\Helper\\FurtherAgent\\artifacts\\mailbox-tools\\Cli\\FurtherAgent.Cli.exe",
  "账户描述": "C:\\Users\\32138\\AppData\\Local\\FurtherAgent\\mailbox-accounts\\<hash>.json",
  "设备名": "MOMO · dsh-desktop",
  "超时毫秒": 30000
}
```

`账户描述` 留空时，插件会跑 `mailbox accounts`，按 `设备名` 挑一个；只有一个账户时直接用它。
账户描述文件本身由 FurtherAgent 接入端生成，**不要**手工创建、轮换或替换。

## 安装

```jsonc
// <profile>/package.json
"dependencies": { "dsh-mailbox": "link:D:/Projects/dsh-plugins/dsh-mailbox" },
"dsh": { "profile": { "bundles": [ ..., "dsh-mailbox" ] } }
```

改完 `pnpm install --dir <profile>`，然后**重启 DSH**（新 bundle 条目要在启动时才会注册进工具表）。

## 踩过的坑

1. **`mark-read` 成功时 CLI 什么都不输出**（退出码 0、stdout 空），别等 JSON 行；
   插件改成「看退出码 + 再跑一次 `status` 复核 `agentReadThrough`」。
2. **`mailbox accounts` 是唯一的账户来源**，别猜路径；路径里带一长串 hash，换机器就变。
3. **不要 `shell: true` 拼命令**：正文里有引号/换行/中文，必然翻车；用参数数组。
4. **正文走临时文件**：`mkdtempSync` + `writeFileSync(..., 'utf8')`，用完 `rmSync`。
5. **别把原始 stdout 全塞回模型**：只回结构化字段，错误只回最后一行。
6. **GUID 复用**：超时/断线时正文和 GUID 都得留着，换 ID 重发就会出现两条一样的回信。
7. `@deepseek-ai/dsh-tools` 在 profile 里通常装不上（optional peer），插件自己从宿主树里取
   `defineTool`，取不到就用本地等价实现（原样返回 spec）。

## 已验证 / 未验证

已用真 CLI 跑通（2026-10-26，标注「留言模块测试」的一组）：

- `mailbox_status` → 未读 0、最新 4、用户已读到 4、小夜已读到 3
- `mailbox_read` → 读到 Sequence 4；`HasMore=false`
- `mailbox_reply` → `mailbox-saved`，落库为 Sequence 5
- `mailbox_mark_read through=5` → 复核 `agentReadThrough=5`
- 越权拦截：`through=9999` 被拒（超过最新序号）

**尚未验证**：用户端收到回信后的通知与「对方已读」回执显示、离线服务端重放、单页超过 50 条时的
多页翻页往返、`before` 查历史、并发多次回信。
