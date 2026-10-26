// dsh-mailbox —— FurtherAgent 独立留言箱的 DSH 原生工具
//
// 只封装本机已有的 FurtherAgent.Cli.exe：不新建身份、不换配对码、不动中继。
// 不注册定时器、不自动把留言转成会话消息、不生成模型任务 ——
// 什么时候查收、什么时候回信，由小夜在她自己的活动里决定。
//
// 凭据：CLI 自己读账户描述文件，插件只拿路径，从不读它的内容，也不写进日志。

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Cordis 插件标识。 */
export const name = 'mailbox'

/** 只需要工具注册表。 */
export const inject = ['tools']

// ---------- 默认值 ----------

const 默认命令行 = 'D:\\Helper\\FurtherAgent\\artifacts\\mailbox-tools\\Cli\\FurtherAgent.Cli.exe'
const 默认设备 = 'MOMO · dsh-desktop'
const 默认超时毫秒 = 30 * 1000
const 回信超时毫秒 = 45 * 1000
const 单页最多 = 50

/** 配置文件放在 DSH home 下（沿用 fish-memory 那套习惯），只存路径，不存密钥。 */
function 配置路径() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-mailbox.json')
}

/** 读配置；坏文件也不让插件挂掉。 */
function 读配置() {
  const 路径 = 配置路径()
  let 原文 = {}
  try {
    if (existsSync(路径)) 原文 = JSON.parse(readFileSync(路径, 'utf8'))
  } catch (error) {
    原文 = {}
  }
  const 命令行 = typeof 原文.命令行 === 'string' && 原文.命令行.trim() ? 原文.命令行.trim() : 默认命令行
  return {
    命令行,
    账户描述: typeof 原文.账户描述 === 'string' && 原文.账户描述.trim() ? 原文.账户描述.trim() : '',
    设备名: typeof 原文.设备名 === 'string' && 原文.设备名.trim() ? 原文.设备名.trim() : 默认设备,
    超时毫秒: Number.isFinite(Number(原文.超时毫秒)) && Number(原文.超时毫秒) > 0 ? Number(原文.超时毫秒) : 默认超时毫秒,
  }
}

// ---------- 跑 CLI ----------

/**
 * 起一个进程跑 CLI：参数数组、不经 shell、不拼命令串。
 * @param {string} 命令行 exe 路径
 * @param {string[]} 参数
 * @param {number} 超时毫秒
 * @returns {Promise<{码: number|null, 输出: string, 错误: string, 超时: boolean}>}
 */
function 跑(命令行, 参数, 超时毫秒) {
  return new Promise((完成) => {
    let 输出 = ''
    let 错误 = ''
    let 已结束 = false
    const 收尾 = (值) => {
      if (已结束) return
      已结束 = true
      clearTimeout(计时)
      完成(值)
    }
    let 进程
    try {
      进程 = spawn(命令行, 参数, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      完成({ 码: null, 输出: '', 错误: String((error && error.message) || error), 超时: false })
      return
    }
    const 计时 = setTimeout(() => {
      try {
        进程.kill()
      } catch (error) {
        /* 杀不掉就随它去 */
      }
      收尾({ 码: null, 输出, 错误: 错误 + '\n(超时)', 超时: true })
    }, 超时毫秒)
    进程.stdout.on('data', (块) => {
      输出 += 块.toString('utf8')
    })
    进程.stderr.on('data', (块) => {
      错误 += 块.toString('utf8')
    })
    进程.on('error', (error) => {
      收尾({ 码: null, 输出, 错误: 错误 + String((error && error.message) || error), 超时: false })
    })
    进程.on('close', (码) => {
      收尾({ 码, 输出, 错误, 超时: false })
    })
  })
}

/** 把 JSON Lines 解析成数组；坏行直接跳过。 */
function 解析行(文本) {
  const 结果 = []
  for (const 行 of String(文本 || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const 净 = 行.trim()
    if (!净 || 净[0] !== '{') continue
    try {
      结果.push(JSON.parse(净))
    } catch (error) {
      /* 非 JSON 的进度行忽略 */
    }
  }
  return 结果
}

/** 从一批行里找某种 type 的最后一条。 */
function 找(行们, 类型) {
  for (let i = 行们.length - 1; i >= 0; i--) {
    if (行们[i] && 行们[i].type === 类型) return 行们[i]
  }
  return null
}

/** 失败时给模型一句人话，不要把整段运行日志塞进去。 */
function 说失败(动作, 结果) {
  if (结果.超时) return 动作 + '超时了（CLI 没在 ' + Math.round(结果.码 === null ? 0 : 0) + '毫秒内返回；结果未知，重试时请沿用原来的 GUID）'
  const 尾 = String(结果.错误 || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
  const 码 = 结果.码 === null ? '未启动' : '退出码 ' + 结果.码
  return 动作 + '失败（' + 码 + '）' + (尾 ? '：' + 尾.slice(0, 300) : '')
}

// ---------- 账户 ----------

/** 本进程里解析到的账户描述路径（不落盘、不外传）。 */
let 缓存账户 = ''

/**
 * 找到要用的账户描述路径：
 *   1) 配置里写死的；
 *   2) 否则跑 `mailbox accounts`，按设备名挑；只有一个就直接用。
 */
async function 取账户(配置) {
  if (配置.账户描述) return 配置.账户描述
  if (缓存账户) return 缓存账户
  const 结果 = await 跑(配置.命令行, ['mailbox', 'accounts'], 配置.超时毫秒)
  const 一 = 找(解析行(结果.输出), 'mailbox-accounts')
  if (!一 || !Array.isArray(一.data) || 一.data.length === 0) {
    throw new Error(说失败('查账户描述', 结果) + '｜先确认 FurtherAgent 接入端已生成账户描述')
  }
  const 命中 = 一.data.find((账户) => 账户 && 账户.name === 配置.设备名)
    || (一.data.length === 1 ? 一.data[0] : null)
  if (!命中) {
    const 名字 = 一.data.map((账户) => (账户 && 账户.name) || '?').join('、')
    throw new Error('找到多个账户描述但都不叫「' + 配置.设备名 + '」：' + 名字 + '。请在 ' + 配置路径() + ' 里写死账户描述路径')
  }
  缓存账户 = String(命中.accountFile || '')
  if (!缓存账户) throw new Error('账户描述里没有 accountFile 字段')
  return 缓存账户
}

// ---------- defineTool ----------

/**
 * 取宿主的 defineTool：从宿主那棵树里 import，拿不到就用本地等价实现。
 * （插件不能直接裸 import @deepseek-ai/dsh-tools —— 它在 profile 里通常装不上。）
 */
async function 取defineTool() {
  const 候选 = []
  const appdata = process.env.APPDATA
  if (appdata) {
    候选.push(join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    候选.push(join(appdata, 'npm', 'node_modules', '@deepseek-ai'))
  }
  for (const 根 of 候选) {
    const 目录 = join(根, 'dsh-tools')
    try {
      if (!existsSync(join(目录, 'package.json'))) continue
      const 包 = JSON.parse(readFileSync(join(目录, 'package.json'), 'utf8'))
      const 入口 = typeof 包.exports?.['.'] === 'string'
        ? 包.exports['.']
        : (包.exports?.['.']?.import || 包.exports?.['.']?.default || 包.module || 包.main)
      if (!入口) continue
      const 文件 = join(目录, String(入口).replace(/^\.\//, ''))
      if (!existsSync(文件)) continue
      const 模块 = await import('file:///' + 文件.replace(/\\/g, '/'))
      const 函数 = 模块.defineTool || 模块.default?.defineTool
      if (typeof 函数 === 'function') return 函数
    } catch (error) {
      /* 换下一个候选 */
    }
  }
  // 本地等价：宿主那份只是做 spec→JSON Schema 转换和校验，我们本来就写标准结构，原样返回即可
  return (选项) => 选项
}

// ---------- 插件本体 ----------

export function apply(ctx) {
  let defineTool = (选项) => 选项
  let 就绪 = null

  /** 懒加载 defineTool（拿不到也不会卡住注册）。 */
  const 准备 = () => {
    就绪 ??= 取defineTool().then((函数) => {
      defineTool = 函数
      return 函数
    })
    return 就绪
  }

  /** 跑一条 mailbox 子命令，返回解析后的行和原始结果。 */
  const 跑mailbox = async (参数, 超时) => {
    const 配置 = 读配置()
    if (!existsSync(配置.命令行)) {
      throw new Error('找不到 FurtherAgent CLI：' + 配置.命令行 + '（要改路径请写在 ' + 配置路径() + ' 的「命令行」）')
    }
    const 账户 = await 取账户(配置)
    const 结果 = await 跑(配置.命令行, ['mailbox', ...参数.slice(0, 1), '--account-file', 账户, ...参数.slice(1)], 超时 || 配置.超时毫秒)
    return { 结果, 行们: 解析行(结果.输出) }
  }

  const 输出结构 = (属性, 必填) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: 属性,
      required: 必填,
    },
    render: (_参数, 值) => [{ type: 'text', text: JSON.stringify(值, void 0, 2) }],
  })

  const 注册 = () => {
    // 1) 未读数与已读位置
    ctx.tools.register(defineTool({
      name: 'mailbox_status',
      description: '查看 FurtherAgent 独立留言箱的状态：未读数，以及用户端和 Agent 端各自的已读位置。只读，不会把任何留言标为已读，也不会启动模型或会话。',
      parameters: {},
      output: 输出结构({
        账户: { type: 'string', required: true },
        未读: { type: 'integer', required: true },
        最新序号: { type: 'integer', required: true },
        用户已读到: { type: 'integer', required: true },
        小夜已读到: { type: 'integer', required: true },
        说明: { type: 'string' },
      }, ['账户', '未读', '最新序号', '用户已读到', '小夜已读到']),
      isConcurrencySafe: () => true,
      execute: async () => {
        await 准备()
        const { 结果, 行们 } = await 跑mailbox(['status'])
        const 一 = 找(行们, 'mailbox-status')
        if (!一 || !一.data) throw new Error(说失败('查留言状态', 结果))
        const 数据 = 一.data
        return {
          账户: String(数据.name || ''),
          未读: Number(数据.unread || 0),
          最新序号: Number(数据.latestSequence || 0),
          用户已读到: Number(数据.controllerReadThrough || 0),
          小夜已读到: Number(数据.agentReadThrough || 0),
          说明: '未读来自用户端；小夜已读到最后一次 mark-read 确认的位置。',
        }
      },
    }))

    // 2) 读留言
    const 已取得 = new Set()

    ctx.tools.register(defineTool({
      name: 'mailbox_read',
      description: '读取 FurtherAgent 独立留言箱里的留言。默认从「小夜已读位置」之后按序取一页；读取本身不会标记已读。返回每条的 Sequence、Sender、Text、CreatedAt，以及 HasMore。HasMore=true 时用这一页最后一条实际取得的 Sequence 作为 after 继续翻页。',
      parameters: {
        limit: { type: 'integer', description: '这一页最多取几条，1~50，默认 20。' },
        after: { type: 'integer', description: '只看这个 Sequence 之后的留言（翻页用）。' },
        before: { type: 'integer', description: '只看这个 Sequence 之前的留言（翻历史用）。' },
      },
      output: 输出结构({
        账户: { type: 'string', required: true },
        消息: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              Sequence: { type: 'integer', required: true },
              Sender: { type: 'string', required: true },
              Text: { type: 'string', required: true },
              CreatedAt: { type: 'string', required: true },
            },
            required: ['Sequence', 'Sender', 'Text', 'CreatedAt'],
          },
        },
        HasMore: { type: 'boolean', required: true },
        HasOlder: { type: 'boolean' },
        最新序号: { type: 'integer' },
        小夜已读到: { type: 'integer' },
        说明: { type: 'string' },
      }, ['账户', '消息', 'HasMore']),
      isConcurrencySafe: () => true,
      execute: async (参数) => {
        await 准备()
        const 条数 = Math.max(1, Math.min(单页最多, Math.round(Number(参数 && 参数.limit) || 20)))
        const 参数表 = ['read', '--limit', String(条数)]
        if (参数 && Number.isFinite(Number(参数.after))) 参数表.push('--after', String(Math.round(Number(参数.after))))
        if (参数 && Number.isFinite(Number(参数.before))) 参数表.push('--before', String(Math.round(Number(参数.before))))
        const { 结果, 行们 } = await 跑mailbox(参数表)
        const 一 = 找(行们, 'mailbox-messages')
        if (!一 || !一.data) throw new Error(说失败('读留言', 结果))
        const 数据 = 一.data
        const 消息 = (Array.isArray(数据.messages) ? 数据.messages : []).map((条) => {
          const 号 = Number(条.sequence || 0)
          if (号 > 0) 已取得.add(号)
          return {
            Sequence: 号,
            Sender: String(条.sender || ''),
            Text: String(条.text || ''),
            CreatedAt: String(条.createdAt || ''),
          }
        })
        return {
          账户: String(数据.name || ''),
          消息,
          HasMore: 数据.hasMore === true,
          HasOlder: 数据.hasOlder === true,
          最新序号: Number(数据.latestSequence || 0),
          小夜已读到: Number(数据.agentReadThrough || 0),
          说明: 消息.length === 0
            ? '没有新留言。'
            : (数据.hasMore === true ? '还有更多：用本页最后一条的 Sequence 作为 after 再读一次。' : '这一页读完了；确认看完再 mark-read。'),
        }
      },
    }))

    // 3) 标已读
    ctx.tools.register(defineTool({
      name: 'mailbox_mark_read',
      description: '把「小夜已读到」推进到指定 Sequence。只在你确实读完那些留言之后调用；不能直接确认到尚未取得的 LatestSequence。',
      parameters: {
        through: { type: 'integer', required: true, description: '确实已经看完的最大 Sequence。' },
      },
      output: 输出结构({
        已确认到: { type: 'integer', required: true },
        小夜已读到: { type: 'integer' },
        说明: { type: 'string', required: true },
      }, ['已确认到', '说明']),
      isConcurrencySafe: () => false,
      execute: async (参数) => {
        await 准备()
        const 到 = Math.round(Number(参数 && 参数.through))
        if (!Number.isFinite(到) || 到 < 1) throw new Error('through 必须是 ≥ 1 的整数')

        const { 结果: 状态结果, 行们: 状态行 } = await 跑mailbox(['status'])
        const 状态 = 找(状态行, 'mailbox-status')
        if (!状态 || !状态.data) throw new Error(说失败('核对已读位置', 状态结果))
        const 最新 = Number(状态.data.latestSequence || 0)
        if (到 > 最新) {
          throw new Error('through=' + 到 + ' 超过了最新序号 ' + 最新 + '，不能确认还没出现的留言')
        }
        if (已取得.size > 0) {
          const 最大 = Math.max(...已取得)
          if (到 > 最大) {
            throw new Error('through=' + 到 + ' 超过本次实际读到的最大序号 ' + 最大 + '，先把后面的读出来再确认')
          }
        }

        const { 结果, 行们 } = await 跑mailbox(['mark-read', '--through', String(到)])
        // CLI 的 mark-read 成功时**不输出** JSON 行，只看退出码；再用 status 复核一次
        const 行里确认 = 找(行们, 'mailbox-read-confirmed') || 找(行们, 'mailbox-marked-read') || 找(行们, 'mailbox-status')
        if (!行里确认 && 结果.码 !== 0) throw new Error(说失败('标已读', 结果))

        const { 结果: 复核结果, 行们: 复核行 } = await 跑mailbox(['status'])
        const 复核 = 找(复核行, 'mailbox-status')
        if (!复核 || !复核.data) throw new Error(说失败('复核已读位置', 复核结果))
        const 已读到 = Number(复核.data.agentReadThrough || 0)
        if (已读到 < 到) {
          return {
            已确认到: 到,
            小夜已读到: 已读到,
            说明: '命令跑完了，但复核还没看到已读位置推进（现在是 ' + 已读到 + '）。稍后再查一次 status 核对。',
          }
        }
        return {
          已确认到: 到,
          小夜已读到: 已读到,
          说明: '已确认读到第 ' + 到 + ' 条；用户端会看到「对方已读」。',
        }
      },
    }))

    // 4) 回信
    ctx.tools.register(defineTool({
      name: 'mailbox_reply',
      description: '给主人的留言箱发一条回信。正文通过 UTF-8 临时文件传给 CLI（不拼命令串）。每条新回信要带一个固定 GUID：不传则自动生成并在结果里返回。结果未知（超时/断线）时保留同一个 GUID 重试，不要换 ID 重发。只有拿到 mailbox-saved 才算保存成功。',
      parameters: {
        text: { type: 'string', required: true, description: '回信正文，最多 8000 字。' },
        id: { type: 'string', description: '这条回信的固定 GUID。省略则自动生成；重试时必须沿用上次返回的那个。' },
      },
      output: 输出结构({
        已保存: { type: 'boolean', required: true },
        消息ID: { type: 'string', required: true },
        序号: { type: 'integer' },
        时间: { type: 'string' },
        说明: { type: 'string', required: true },
      }, ['已保存', '消息ID', '说明']),
      isConcurrencySafe: () => false,
      execute: async (参数) => {
        await 准备()
        const 正文 = String((参数 && 参数.text) || '')
        if (!正文.trim()) throw new Error('回信正文不能为空')
        if (正文.length > 8000) throw new Error('回信正文最多 8000 字，现在是 ' + 正文.length)

        const 给定 = String((参数 && 参数.id) || '').trim()
        const 标识 = 给定 || randomUUID()
        if (!/^[0-9a-fA-F-]{32,40}$/.test(标识)) {
          throw new Error('id 必须是 GUID（32 位十六进制，可带连字符）：' + 标识.slice(0, 12) + '…')
        }

        const 临时目录 = mkdtempSync(join(tmpdir(), 'dsh-mailbox-'))
        const 正文文件 = join(临时目录, '正文.txt')
        try {
          writeFileSync(正文文件, 正文, 'utf8')
          const { 结果, 行们 } = await 跑mailbox(
            ['reply', '--text-file', 正文文件, '--id', 标识],
            回信超时毫秒,
          )
          const 一 = 找(行们, 'mailbox-saved')
          if (!一) {
            return {
              已保存: false,
              消息ID: 标识,
              说明: 说失败('发回信', 结果) + '｜还没拿到 mailbox-saved，正文和 GUID 都保留：核对后用同一个 id 重试，不要换新 ID。',
            }
          }
          const 数据 = (一 && 一.data) || {}
          return {
            已保存: true,
            消息ID: 标识,
            序号: Number(数据.sequence || 数据.latestSequence || 0) || void 0,
            时间: String(数据.createdAt || ''),
            说明: '中继已确认保存（mailbox-saved）。',
          }
        } finally {
          try {
            rmSync(临时目录, { recursive: true, force: true })
          } catch (error) {
            /* 临时文件删不掉不影响结果 */
          }
        }
      },
    }))
  }

  // 注册放在 effect 里：插件卸载时工具跟着撤掉
  ctx.effect(() => {
    注册()
  })

  // 顺手确保配置目录存在（不写默认值，只读）
  try {
    mkdirSync(dirname(配置路径()), { recursive: true })
  } catch (error) {
    /* 建不了就算了 */
  }
}
