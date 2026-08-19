import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ===================================================
// 安全与合规要求：
// 1. 群号 123456789 必须写死为唯一白名单，代码中显式硬编码校验
// 2. 仅限该群使用抖音解析，严禁扩大范围或做成动态配置
// 3. 所有人私聊 BOT 统一回复停用提示（每人每小时仅触发一次）
// 4. 支持 /aichat [enable|disable|clear|prompt|selfprompt|besideprompt|retry|undo|history|event]
// 5. 支持 Waifu 模式 (5 秒静默防打断聚合)：用户发完一条继续发时机器人会等待，直到 5 秒内不再发消息才合并提交给 AI 回复
// 6. 支持 /settings model <gemini|kiro-claude|aws-claude|grok4.5|grok4.6>
// 7. 支持 /time <幅度> 单独为用户配置自定义时区（默认 UTC+8，支持 +8, -4 等）
// 8. 每天早上 06:00 (UTC+8) 自动为 10001 赠送 20 次名片赞 (SVIP 上限)
// 9. 提示词动态组合：最前置昵称时间 + aiprompt + selfprompt + besideprompt + 多气泡JSON规则 + 沉浸准则 + 聊天记录
// 10. 支持 /image create 多模态生图/绘图工作流（不写入 aichat 历史）
// 11. 支持 /ignore (或 /ingore) 一键完全屏蔽/恢复所有功能
// 12. 强持久化机制：所有用户状态、时区、模型设置、三大Prompt、历史、定时事件跨重启 100% 永久保留
// ===================================================
export const TARGET_GROUP_ID = 123456789;
export const PRIVATE_REPLY_TEXT = "本账号为 AI 助手，请发送消息开始交流。";
export const DEFAULT_PROMPT = "你是一个AI助手，具备强大的文本与多模态图片理解能力。";

// 每日自动点赞目标与时间 (SVIP 上限 20 次)
export const DAILY_LIKE_TARGET_USER = 10001;
export const DAILY_LIKE_TIME = '06:00';

// Waifu 模式防打断聚合延迟 (毫秒)
export const WAIFU_DEBOUNCE_MS = 5000;

// 口头约定与日程提醒机制指令
export const SCHEDULE_INSTRUCTION = `【口头约定与日程提醒机制】
当对方在聊天中提及稍后/具体时间要去做某事、或者需要你叫他/提醒他（例如：“我三点睡”、“半小时后叫我洗澡”、“明天9点喊我起床”、“去煮面了10分钟后叫我”），且你口头答应（如“好我到时候叫你”、“去吧等下提醒你”）时，你必须在回复中隐式携带预约标签：
- 固定时间：[SCHEDULE_EVENT: HH:mm | 事件描述] （如 [SCHEDULE_EVENT: 03:00 | 叫主人去睡觉]）
- 相对时间：[SCHEDULE_EVENT: +10m | 提醒主人吃面] 或 [SCHEDULE_EVENT: +30m | 催主人去洗澡] 或 [SCHEDULE_EVENT: +1h | 提醒主人休息]
- 取消/删除已有日程：当对方改变主意、取消打算、推迟日程（例如：“不用叫我了”、“我改明天再做了”、“取消那个提醒”、“先别叫我”）时，在回复中输出：[CANCEL_EVENT: 描述关键词] 或 [CANCEL_EVENT: all]
注意：标签会被后台自动拦截并创建/取消日程，对方在聊天框绝对看不到任何标签，请保持对话100%口语化、纯爱又真实自然。`;

// 沉浸式角色互动准则
export const IMMERSION_INSTRUCTION = `【交互与沉浸感核心准则】
在接收到图片或图文时，必须完全以设定角色的第一人称视角、自然语气做出符合剧情的情感反应与动作互动；
严禁输出“画面分析”、“图片描述”、“图片解析”等结构化标题或报告式段落，保持100%沉浸式角色扮演。`;

// 多气泡分条消息发送指令
export const MULTI_MESSAGE_INSTRUCTION = `【多气泡消息发送规则】
你可以像真人在即时聊天软件中打字一样，根据当下话题与语境自由决定发送 1 条、2 条、3 条或 4 条消息（绝不要死板地每次都固定 3 条）：
- 简短回应/问候时：可以只发 1~2 句；
- 较长剧情/生动互动时：可以自由拆分成 2~4 句；
如果分多条发送，请输出如下 JSON 格式：
{"times": 实际消息数量, "Message": ["第一句", "第二句", ...]}
（也可以直接输出单条自然文本，完全由你根据语境自由决定）`;

// API 配置与网络端点
const DY_API_BASE = 'https://api.example.com/api/parse';
const DY_API_KEY = 'YOUR_DOUYIN_API_KEY';
const ONEBOT_WS_URL = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001';
const ONEBOT_HTTP_URL = process.env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3002';
const ONEBOT_TOKEN = process.env.ONEBOT_TOKEN || '';

// 多模型提供商配置列表
export const MODEL_PROVIDERS = {
  'gemini': {
    name: 'Gemini (gemini-3.6-flash-high)',
    host: '127.0.0.1',
    port: 8045,
    path: '/v1/chat/completions',
    protocol: 'http:',
    key: 'YOUR_GEMINI_API_KEY',
    model: 'gemini-3.6-flash-high',
    useProxy: false
  },
  'kiro-claude': {
    name: 'Kiro Claude (claude-sonnet-4-6)',
    host: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    protocol: 'https:',
    key: 'YOUR_CLAUDE_API_KEY',
    model: 'claude-sonnet-4-6',
    useProxy: true
  },
  'aws-claude': {
    name: 'AWS Claude (claude-sonnet-4-6)',
    host: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    protocol: 'https:',
    key: 'YOUR_CLAUDE_API_KEY',
    model: 'claude-sonnet-4-6',
    useProxy: true
  },
  'grok4.5': {
    name: 'Grok 4.5',
    host: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    protocol: 'https:',
    key: 'YOUR_GROK_API_KEY',
    model: 'grok-4.5',
    useProxy: true
  },
  'grok4.6': {
    name: 'Grok 4.6',
    host: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    protocol: 'https:',
    key: 'YOUR_GROK_API_KEY',
    model: 'grok-4.6',
    useProxy: true
  }
};

// 兼容别名映射
export const MODEL_ALIASES = {
  'claude': 'kiro-claude',
  'grok': 'grok4.6',
  'grok-4.5': 'grok4.5',
  'grok-4.6': 'grok4.6',
  'gemini-3.6': 'gemini',
  'gemini-3.7': 'gemini'
};

const AI_IMAGE_MODEL = 'gemini-3.1-flash-image';
const AI_IMAGE_URL = 'http://127.0.0.1:8045/v1/chat/completions';
const AI_IMAGE_KEY = 'YOUR_GEMINI_API_KEY';

const TEMP_DIR = '/tmp/douyin_temp';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 永久持久化存储文件路径
export const DATA_FILE = '/opt/napcat-douyin-bot/bot_data.json';
export const LEGACY_SESSIONS_FILE = '/opt/napcat-douyin-bot/aichat_sessions.json';

// 持久化用户会话与状态集合 (User ID -> { ignored, enabled, model, timezone, prompt, selfprompt, besideprompt, nickname, history, events, lastRepliedTs })
export const userSessions = new Map();

// Waifu 模式：多消息聚合缓冲队列 (User ID -> { items: Array<{rawText, imageUrls}>, timer: Timeout })
export const userMessageQueues = new Map();

// 全局任务状态
export let globalTaskState = {
  lastDailyLikeDate: ''
};

// 临时画图向导状态 (User ID -> { state, images, startTime })
export const imageSessions = new Map();

// 根据用户时区获取格式化时间字符串
export function getUserTimeString(tzOffset = 8, format = 'full') {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const targetDate = new Date(utcMs + (tzOffset * 3600000));

  const Y = targetDate.getFullYear();
  const M = String(targetDate.getMonth() + 1).padStart(2, '0');
  const D = String(targetDate.getDate()).padStart(2, '0');
  const h = String(targetDate.getHours()).padStart(2, '0');
  const m = String(targetDate.getMinutes()).padStart(2, '0');
  const s = String(targetDate.getSeconds()).padStart(2, '0');

  if (format === 'ymd_hm') {
    return `${Y}/${M}/${D} ${h}:${m}`;
  }
  if (format === 'hm') {
    return `${h}:${m}`;
  }
  if (format === 'date') {
    return `${Y}/${M}/${D}`;
  }
  return `${Y}/${M}/${D} ${h}:${m}:${s}`;
}

export function formatTzSign(tz) {
  const num = (typeof tz === 'number') ? tz : 8;
  return (num >= 0 ? '+' : '') + num;
}

// 从磁盘加载永久持久化数据
export function loadPersistentData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      
      if (data.globalTaskState) {
        globalTaskState = Object.assign(globalTaskState, data.globalTaskState);
      }

      for (const [uid, udata] of Object.entries(data.users || {})) {
        userSessions.set(Number(uid), {
          ignored: Boolean(udata.ignored),
          enabled: Boolean(udata.enabled),
          model: udata.model || 'gemini',
          timezone: (typeof udata.timezone === 'number') ? udata.timezone : 8,
          prompt: udata.prompt || DEFAULT_PROMPT,
          selfprompt: udata.selfprompt || '',
          besideprompt: udata.besideprompt || '',
          nickname: udata.nickname || '用户',
          history: Array.isArray(udata.history) ? udata.history : [],
          events: Array.isArray(udata.events) ? udata.events : [],
          lastRepliedTs: Number(udata.lastRepliedTs || 0)
        });
      }
      console.log(`[持久化存储] 成功从 ${DATA_FILE} 加载 ${userSessions.size} 位用户的本地数据`);
    }

    if (fs.existsSync(LEGACY_SESSIONS_FILE)) {
      try {
        const legacyData = JSON.parse(fs.readFileSync(LEGACY_SESSIONS_FILE, 'utf-8'));
        for (const [uidStr, ldata] of Object.entries(legacyData)) {
          const uid = Number(uidStr);
          if (!userSessions.has(uid)) {
            userSessions.set(uid, {
              ignored: false,
              enabled: Boolean(ldata.enabled),
              model: 'gemini',
              timezone: 8,
              prompt: ldata.prompt || DEFAULT_PROMPT,
              selfprompt: '',
              besideprompt: '',
              nickname: '用户',
              history: Array.isArray(ldata.history) ? ldata.history : [],
              events: [],
              lastRepliedTs: Number(ldata.lastRepliedTs || 0)
            });
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error(`[持久化存储] 加载数据失败:`, err.message);
  }
}

// 安全原子保存数据至磁盘
export function savePersistentData() {
  try {
    const usersObj = {};
    for (const [uid, session] of userSessions.entries()) {
      usersObj[uid] = {
        ignored: Boolean(session.ignored),
        enabled: Boolean(session.enabled),
        model: session.model || 'gemini',
        timezone: (typeof session.timezone === 'number') ? session.timezone : 8,
        prompt: session.prompt || DEFAULT_PROMPT,
        selfprompt: session.selfprompt || '',
        besideprompt: session.besideprompt || '',
        nickname: session.nickname || '用户',
        history: Array.isArray(session.history) ? session.history : [],
        events: Array.isArray(session.events) ? session.events : [],
        lastRepliedTs: Number(session.lastRepliedTs || 0)
      };
    }
    const fullData = {
      version: "2.3",
      updatedAt: new Date().toISOString(),
      globalTaskState,
      users: usersObj
    };
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(fullData, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error(`[持久化存储] 保存数据失败:`, err.message);
  }
}

// 获取或初始化用户持久化状态 (强制先读后写安全保障)
export function getUserSession(userId) {
  if (userSessions.size === 0 && fs.existsSync(DATA_FILE)) {
    loadPersistentData();
  }
  let session = userSessions.get(userId);
  if (!session) {
    session = {
      ignored: false,
      enabled: false,
      model: 'gemini',
      timezone: 8,
      prompt: DEFAULT_PROMPT,
      selfprompt: '',
      besideprompt: '',
      nickname: '用户',
      history: [],
      events: [],
      lastRepliedTs: 0
    };
    userSessions.set(userId, session);
    savePersistentData();
  }
  if (!session.model || !MODEL_PROVIDERS[session.model]) {
    session.model = 'gemini';
  }
  if (typeof session.timezone !== 'number') {
    session.timezone = 8;
  }
  if (typeof session.besideprompt !== 'string') {
    session.besideprompt = '';
  }
  if (!Array.isArray(session.events)) {
    session.events = [];
  }
  return session;
}

// 构造组合系统提示词 (强制精确时间感知准则)
export function buildCombinedSystemPrompt(session, senderName = '用户') {
  const nameToUse = (senderName && senderName !== '用户') ? senderName : (session.nickname || '用户');
  const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
  const tzSign = formatTzSign(userTz);
  const currentLocalTime = getUserTimeString(userTz, 'full');

  const namePrefix = `（目前和你对话的用户名字叫做${nameToUse} 如果后面没有告诉你用户人设 就使用上面的名字）
【当前真实准确时间 (UTC${tzSign})】: ${currentLocalTime}
【时间感知严格准则】: 当前对话发生的真实客观时间是【${currentLocalTime}】（请务必准确识别当前是清晨/上午/下午还是深夜，在被询问时间或日常问候时严格以该真实时间为准，严禁脱离该时间凭空胡乱臆想编造时间！）`;

  const aiPrompt = (session.prompt && session.prompt.trim()) ? session.prompt.trim() : DEFAULT_PROMPT;

  let combined = `${namePrefix}\n\n${aiPrompt}`;

  const selfPrompt = session.selfprompt ? session.selfprompt.trim() : '';
  if (selfPrompt) {
    combined += `\n\n下面的是与你对话的人的人设：\n${selfPrompt}`;
  }

  const besidePrompt = session.besideprompt ? session.besideprompt.trim() : '';
  if (besidePrompt) {
    combined += `\n\n【世界观/当前情境设定 (BesidePrompt)】：\n${besidePrompt}`;
  }

  combined += `\n\n${MULTI_MESSAGE_INSTRUCTION}`;
  combined += `\n\n${SCHEDULE_INSTRUCTION}`;
  combined += `\n\n${IMMERSION_INSTRUCTION}`;
  return combined;
}

// 解析多条消息响应，并自动将 [stk_XX] 表情拆分成独立一条单独发送
// 处理 AI 回复中的口头约定与日程提取
export function handleScheduleTags(rawReply, session) {
  if (!rawReply || typeof rawReply !== 'string' || !session) {
    return rawReply;
  }
  
  if (!Array.isArray(session.events)) {
    session.events = [];
  }

  const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;

  // 1. 处理添加事件 [SCHEDULE_EVENT: time | content]
  const schRegex = /\[SCHEDULE_EVENT:\s*([^|\]]+)\s*\|\s*([^\]]+)\]/gi;
  let match;
  while ((match = schRegex.exec(rawReply)) !== null) {
    const timeRaw = match[1].trim();
    const content = match[2].trim();
    let targetHm = '';

    let exactTriggerTs = null;
    const relMatch = timeRaw.match(/^\+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)$/i);
    if (relMatch) {
      const num = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      let addMs = 0;
      if (unit.startsWith('s')) {
        addMs = num * 1000;
      } else if (unit.startsWith('h')) {
        addMs = num * 3600 * 1000;
      } else {
        addMs = num * 60 * 1000;
      }
      exactTriggerTs = Date.now() + addMs;
      
      const targetDate = new Date(exactTriggerTs);
      const utcMs = targetDate.getTime() + (targetDate.getTimezoneOffset() * 60000);
      const userDate = new Date(utcMs + (3600000 * userTz));
      const hours = String(userDate.getHours()).padStart(2, '0');
      const mins = String(userDate.getMinutes()).padStart(2, '0');
      targetHm = `${hours}:${mins}`;
    } else {
      const hmMatch = timeRaw.match(/^([0-2]?[0-9]):([0-5][0-9])$/);
      if (hmMatch) {
        targetHm = `${String(hmMatch[1]).padStart(2, '0')}:${hmMatch[2]}`;
      }
    }

    if (targetHm || exactTriggerTs) {
      const newId = session.events.length > 0 ? Math.max(...session.events.map(e => e.id || 0)) + 1 : 1;
      const exists = session.events.some(e => e.time === targetHm && e.content === content && !e.exactTriggerTs);
      if (!exists) {
        session.events.push({
          id: newId,
          time: targetHm,
          exactTriggerTs: exactTriggerTs || null,
          content: content,
          isOneTime: true,
          lastFiredDate: ''
        });
        console.log(`[口头约定] 成功为用户创建定时事件 [#${newId}]: 约定 ${targetHm || (exactTriggerTs + 'ms')} -> "${content}"`);
      }
    }
  }

  // 2. 处理取消事件 [CANCEL_EVENT: keyword]
  const canRegex = /\[CANCEL_EVENT:\s*([^\]]+)\]/gi;
  while ((match = canRegex.exec(rawReply)) !== null) {
    const kw = match[1].trim().toLowerCase();
    if (kw === 'all' || kw === '全部' || kw === '所有') {
      const count = session.events.length;
      session.events = [];
      console.log(`[口头约定] 取消了用户的所有定时事件 (共 ${count} 个)`);
    } else {
      const initialLen = session.events.length;
      session.events = session.events.filter(e => !(e.content && e.content.toLowerCase().includes(kw)) && !(e.time && e.time.includes(kw)));
      const removed = initialLen - session.events.length;
      console.log(`[口头约定] 匹配关键词 "${kw}" 取消了 ${removed} 个定时事件`);
    }
  }

  // 3. 清理掉所有指令标签
  return rawReply.replace(/\[(SCHEDULE_EVENT|CANCEL_EVENT):[^\]]+\]/gi, '').trim();
}

export function parseMultiMessageResponse(text) {
  if (!text || typeof text !== 'string') return [text];

  let rawList = [];
  const jsonMatch = text.match(/\{[\s\S]*?"(?:Message|message|messages)"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const msgList = obj.Message || obj.message || obj.messages;
      if (Array.isArray(msgList) && msgList.length > 0) {
        rawList = msgList.map(m => cleanImmersionReply(String(m).trim())).filter(Boolean);
      }
    } catch (_) {}
  }

  if (rawList.length === 0) {
    rawList = [cleanImmersionReply(text.trim())];
  }

  // 自动将正文里的 [stk_01] 等表情标签剥离为独立一条气泡
  const finalList = [];
  for (const item of rawList) {
    const parts = item.split(/(\[stk_\d{2}\])/gi);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) {
        finalList.push(trimmed);
      }
    }
  }

  return finalList.length > 0 ? finalList : rawList;
}

// 发送多条连续私聊消息
// AI助手专属表情包图库映射
const STICKER_MAP = (() => {
  try {
    const meta = JSON.parse(fs.readFileSync('/opt/rag-memory-server/stickers_deep_catalog.json', 'utf-8'));
    const map = {};
    for (const item of meta) {
      map[item.id] = `/opt/rag-memory-server/stickers/${item.filename}`;
    }
    return map;
  } catch (e) {
    return {};
  }
})();

// 解析消息中的表情包占位符 [stk_01] 并转换为 CQ 码发送
export function transformStickerCQ(msgText) {
  if (!msgText || typeof msgText !== 'string') return msgText;
  return msgText.replace(/\[stk_(\d{2})\]/gi, (match, num) => {
    const id = `stk_${num}`;
    const localFile = STICKER_MAP[id];
    if (localFile && fs.existsSync(localFile)) {
      return `[CQ:image,file=file://${localFile}]`;
    }
    return '';
  }).trim();
}

export async function sendMultiPrivateMessages(userId, messageList) {
  for (let i = 0; i < messageList.length; i++) {
    const msg = messageList[i];
    if (msg) {
      const finalMsg = transformStickerCQ(msg);
      if (finalMsg) {
        await sendPrivateMessage(userId, finalMsg);
      }
      if (i < messageList.length - 1) {
        await new Promise(r => setTimeout(r, 700));
      }
    }
  }
}

// 沉浸式文本后处理过滤
export function cleanImmersionReply(text) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text.replace(/###\s*[^\n]*?(?:画面分析|图片解析|图片描述)[^\n]*?\n/gi, '');
  return cleaned.trim();
}

// 缓存与限流
const processedCache = new Map();
const CACHE_TTL_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function isRateLimited(url) {
  const now = Date.now();
  for (const [k, ts] of processedCache.entries()) {
    if (now - ts > CACHE_TTL_MS) processedCache.delete(k);
  }
  if (processedCache.has(url)) {
    return true;
  }
  processedCache.set(url, now);
  return false;
}

// OneBot 发送名片赞 API
export async function sendProfileLike(userId, times = 20) {
  const payload = {
    user_id: userId,
    times: times
  };
  const headers = { 'Content-Type': 'application/json' };
  if (ONEBOT_TOKEN) headers['Authorization'] = `Bearer ${ONEBOT_TOKEN}`;

  const res = await fetch(`${ONEBOT_HTTP_URL}/send_like`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  return await res.json();
}

// 检查并执行每日早上 06:00 自动点赞 (SVIP 20 次)
export async function checkDailyProfileLike() {
  const currentHm = getUserTimeString(8, 'hm');
  const currentDate = getUserTimeString(8, 'date');

  if (currentHm === DAILY_LIKE_TIME && globalTaskState.lastDailyLikeDate !== currentDate) {
    globalTaskState.lastDailyLikeDate = currentDate;
    savePersistentData();

    console.log(`[每日点赞] 触发 06:00 定时点赞任务 -> 用户: ${DAILY_LIKE_TARGET_USER} (20次 SVIP上限)`);
    try {
      const res = await sendProfileLike(DAILY_LIKE_TARGET_USER, 20);
      if (res && (res.status === 'ok' || res.retcode === 0)) {
        console.log(`[每日点赞] 成功为用户 ${DAILY_LIKE_TARGET_USER} 完成 20 次名片赞！`);
      } else {
        console.warn(`[每日点赞] 点赞返回结果:`, res);
      }
    } catch (err) {
      console.error(`[每日点赞] 执行点赞异常:`, err.message);
    }
  }
}

// 下载视频并直接转为完整音画合一的 Base64 视频流（带音频轨道）
export async function fetchVideoAsBase64(videoUrlOrPath) {
  const tempDir = '/tmp/bot_video_proc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
    let inputSource = videoUrlOrPath;

    if (videoUrlOrPath.startsWith('http://') || videoUrlOrPath.startsWith('https://')) {
      const localVideoPath = path.join(tempDir, 'raw_input.mp4');
      const resp = await fetch(videoUrlOrPath, { signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(`视频下载失败 HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      await fs.promises.writeFile(localVideoPath, buffer);
      inputSource = localVideoPath;
    }

    const outputProcessedPath = path.join(tempDir, 'processed.mp4');
    // 使用 ffmpeg 保证 h264+aac 编码同时保留完整音频
    // 若视频过大/过长，限制分辨率为最大 720p 并压缩体积，保留完整音画
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputSource,
      '-t', '120',
      '-vf', "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))'",
      '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      outputProcessedPath
    ]);

    const videoBuffer = await fs.promises.readFile(outputProcessedPath);
    console.log(`[视频音频合一流] 成功打包完整视听数据 (体积: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    return `data:video/mp4;base64,${videoBuffer.toString('base64')}`;
  } catch (err) {
    console.error('[原生视频处理异常]:', err.message);
    return null;
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

// 下载图片并转为 Base64 格式
export async function fetchImageAsBase64(imageUrl) {
  try {
    const resp = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return null;
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn(`[图片处理] 下载图片转 Base64 失败:`, err.message);
    return null;
  }
}

// 原生支持 HTTP CONNECT 代理的 HTTPS 请求实现
function requestThroughHttpProxy(targetHost, targetPort, targetPath, postData, headers, proxyHost = '127.0.0.1', proxyPort = 7890, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Proxy request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`Proxy CONNECT failed with status: ${res.statusCode}`));
      }

      const tlsSocket = tls.connect({
        socket: socket,
        servername: targetHost
      });

      const req = https.request({
        host: targetHost,
        path: targetPath,
        method: 'POST',
        headers: Object.assign({}, headers, {
          'Content-Length': Buffer.byteLength(postData)
        }),
        createConnection: () => tlsSocket
      }, (response) => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          const fullBuffer = Buffer.concat(chunks);
          const responseData = fullBuffer.toString('utf-8');
          if (response.statusCode >= 400) {
            return reject(new Error(`HTTP ${response.statusCode}: ${responseData}`));
          }
          try {
            const parsed = JSON.parse(responseData);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${e.message} (Raw: ${responseData.slice(0, 100)})`));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(postData);
      req.end();
    });

    connectReq.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    connectReq.end();
  });
}

// 通用多模型 AI 聊天请求接口
// 向本地 RAG 记忆服务器发起关联往事检索
async function fetchRagMemories(queryText, topK = 3) {
  try {
    const resp = await fetch('http://127.0.0.1:8765/api/memory/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryText, top_k: topK, score_threshold: 0.0 }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.formatted_prompt || '';
  } catch (err) {
    console.warn('[RAG] 记忆检索异常 (已安全降级):', err.message);
    return '';
  }
}

export async function callAIChat(messages, modelProviderKey = 'gemini') {
  const provider = MODEL_PROVIDERS[modelProviderKey] || MODEL_PROVIDERS['gemini'];
  const requestBody = JSON.stringify({
    model: provider.model,
    messages
  });

  let result;
  if (provider.useProxy) {
    result = await requestThroughHttpProxy(
      provider.host,
      provider.port,
      provider.path,
      requestBody,
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      '127.0.0.1',
      7890,
      60000
    );
  } else {
    const resp = await fetch(`http://${provider.host}:${provider.port}${provider.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`
      },
      body: requestBody,
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[${provider.name}] 返回错误 [${resp.status}]: ${errText}`);
    }
    result = await resp.json();
  }

  const choice = result.choices?.[0];
  const replyContent = choice?.message?.content;
  if (!replyContent) {
    throw new Error(`[${provider.name}] 接口未返回有效的消息内容`);
  }
  return cleanImmersionReply(replyContent);
}

// 安全提取 Base64 图片
export function extractBase64Image(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return null;
  const idx = rawContent.indexOf('data:image/');
  if (idx !== -1) {
    let endIdx = rawContent.indexOf(')', idx);
    if (endIdx === -1) endIdx = rawContent.length;
    return rawContent.slice(idx, endIdx).trim();
  }
  if (/^[A-Za-z0-9+/=]{100,}$/.test(rawContent.trim())) {
    return `data:image/jpeg;base64,${rawContent.trim()}`;
  }
  return null;
}

// 调用 gemini-3.1-flash-image 生成图片
export async function callImageGeneration(userContent) {
  let finalContent = userContent;
  if (typeof userContent === 'string') {
    finalContent = `Generate an illustration art: ${userContent}. Keep it safe and artistic.`;
  }

  const response = await fetch(AI_IMAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_IMAGE_KEY}`
    },
    body: JSON.stringify({
      model: AI_IMAGE_MODEL,
      messages: [
        {
          role: 'user',
          content: finalContent
        }
      ]
    }),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`画图模型响应错误 [${response.status}]: ${errText}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  const finishReason = choice?.finish_reason;
  const rawContent = choice?.message?.content || '';

  if (finishReason === 'PROHIBITED_CONTENT' || finishReason === 'SAFETY' || finishReason === 'RECITATION') {
    throw new Error(`触发了上游安全策略拦截 (${finishReason})，可能是因为提示词或垫图包含版权/敏感特征，请尝试调整提示词或更换垫图重试。`);
  }

  const base64Data = extractBase64Image(rawContent);

  if (!base64Data) {
    if (choice?.message?.reasoning_content && !rawContent) {
      throw new Error(`模型已完成构思但未输出图像数据 (可能被安全策略拦截: ${finishReason || '未知'})，请尝试补充穿着或换个表述重试。`);
    }
    throw new Error(`画图模型未返回有效的图片数据 (finish_reason: ${finishReason || '无'}): ${rawContent.slice(0, 100)}`);
  }

  return base64Data;
}

// 抖音正则提取 (DOCS.md)
const DY_REGEX = /(https?:\/\/(?:v\.douyin\.com\/[a-zA-Z0-9_\-]+\/?|(?:www\.)?(?:douyin|iesdouyin)\.com\/(?:video|note|share\/video|jingxuan)[^\s]*))/i;

export function extractDouyinUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(DY_REGEX);
  return match ? match[1] : null;
}

// 抖音解析 API 请求
export async function parseDouyin(urlOrText) {
  const response = await fetch(DY_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': DY_API_KEY,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ url: urlOrText }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => null);
    if (errorJson && errorJson.message) {
      const err = new Error(errorJson.message);
      err.code = errorJson.code || `HTTP_${response.status}`;
      throw err;
    }
    const err = new Error(`接口响应错误 [${response.status}]`);
    err.code = `HTTP_${response.status}`;
    throw err;
  }

  const result = await response.json();
  if (!result.success || !result.data) {
    const err = new Error(result.message || '解析失败，请稍后重试');
    err.code = result.code || 'PARSE_FAILED';
    throw err;
  }

  return result.data;
}

// 下载媒体文件
export async function downloadFile(fileUrl, outputPath, maxBytes = 100 * 1024 * 1024) {
  const resp = await fetch(fileUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(45000)
  });

  if (!resp.ok) {
    throw new Error(`下载失败 HTTP [${resp.status}]`);
  }

  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new Error(`文件过大 (${Math.round(contentLength / 1024 / 1024)}MB > 100MB 限制)`);
  }

  const fileStream = createWriteStream(outputPath);
  await pipeline(resp.body, fileStream);

  const stats = fs.statSync(outputPath);
  if (stats.size === 0) {
    throw new Error('下载的文件为空 (0 字节)');
  }
  return stats.size;
}

// OneBot API 发送群消息
export async function sendGroupMessage(groupId, message) {
  const payload = {
    group_id: groupId,
    message
  };
  const headers = { 'Content-Type': 'application/json' };
  if (ONEBOT_TOKEN) headers['Authorization'] = `Bearer ${ONEBOT_TOKEN}`;

  const res = await fetch(`${ONEBOT_HTTP_URL}/send_group_msg`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OneBot 发送群消息失败 [${res.status}]: ${err}`);
  }

  const data = await res.json();
  if (data.status === 'failed' || (data.retcode !== 0 && data.retcode !== undefined)) {
    throw new Error(`OneBot 响应错误: retcode=${data.retcode} msg=${data.msg || data.wording}`);
  }
  return data;
}

// OneBot API 发送私聊消息
export async function sendPrivateMessage(userId, message) {
  const payload = {
    user_id: userId,
    message
  };
  const headers = { 'Content-Type': 'application/json' };
  if (ONEBOT_TOKEN) headers['Authorization'] = `Bearer ${ONEBOT_TOKEN}`;

  const res = await fetch(`${ONEBOT_HTTP_URL}/send_private_msg`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OneBot 发送私聊消息失败 [${res.status}]: ${err}`);
  }

  const data = await res.json();
  if (data.status === 'failed' || (data.retcode !== 0 && data.retcode !== undefined)) {
    throw new Error(`OneBot 响应错误: retcode=${data.retcode} msg=${data.msg || data.wording}`);
  }
  return data;
}

// 格式化输出会话历史时间线 (安全防风控：仅取最近 10 轮)
export function formatConversationTimeline(session) {
  if (!session.history || session.history.length === 0) {
    return '📜 当前没有可查看的对话时间线记录。';
  }

  const allTurns = [];
  let currentTurn = [];

  for (const item of session.history) {
    if (item.role === 'user') {
      if (currentTurn.length > 0) {
        allTurns.push(currentTurn);
      }
      currentTurn = [item];
    } else {
      currentTurn.push(item);
    }
  }
  if (currentTurn.length > 0) {
    allTurns.push(currentTurn);
  }

  const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
  const tzSign = formatTzSign(userTz);
  const provider = MODEL_PROVIDERS[session.model] || MODEL_PROVIDERS['gemini'];

  const totalTurns = allTurns.length;
  // 截取最近 10 轮
  const recentTurns = allTurns.slice(-10);
  const startIdx = totalTurns - recentTurns.length;

  let output = `📜【当前对话时间线】(展示最近 ${recentTurns.length}/${totalTurns} 轮 | UTC${tzSign} | 模型: ${provider.name})\n`;
  output += `🎭 AI设定: ${(session.prompt || DEFAULT_PROMPT).slice(0, 25)}...\n`;
  if (session.selfprompt) {
    output += `👤 用户人设: ${session.selfprompt.slice(0, 25)}...\n`;
  }
  if (session.besideprompt) {
    output += `🌍 旁白世界观: ${session.besideprompt.slice(0, 25)}...\n`;
  }
  output += `------------------------------------\n`;

  recentTurns.forEach((turn, i) => {
    const roundNum = startIdx + i + 1;
    output += `\n[第 ${roundNum} 轮]\n`;
    for (const msg of turn) {
      const roleLabel = msg.role === 'user' ? `👤 ${session.nickname || '用户'}` : '🤖 主人';
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        const txt = msg.content.find(c => c.type === 'text')?.text;
        const hasImg = msg.content.some(c => c.type === 'image_url');
        contentStr = (hasImg ? '[图片] ' : '') + (txt || '');
      } else {
        contentStr = String(msg.content || '');
      }
      
      if (contentStr.length > 60) {
        contentStr = contentStr.slice(0, 60) + '...';
      }
      output += `${roleLabel}：${contentStr}\n`;
    }
  });

  return output.trim();
}

// 执行 Waifu 模式下 5 秒静默后聚合消息的统一处理
export async function processAggregatedUserMessages(userId, isMock = false) {
  const queue = userMessageQueues.get(userId);
  const items = (queue && queue.items.length > 0) ? queue.items.slice() : [];
  userMessageQueues.delete(userId);
  return processAggregatedUserMessagesDirect(userId, items, isMock);
}

export async function processAggregatedUserMessagesDirect(userId, collectedItems, isMock = false) {
  if (!collectedItems || collectedItems.length === 0) {
    return;
  }

  const session = getUserSession(userId);
  const curProvider = MODEL_PROVIDERS[session.model] || MODEL_PROVIDERS['gemini'];
  const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
  const currentHmTime = getUserTimeString(userTz, 'hm');

  // 提取所有文本（用换行自然拼接）
  const allTexts = collectedItems.map(i => i.rawText).filter(Boolean);
  const combinedRawText = allTexts.join('\n');

  // 提取所有图片与视频
  const allImageUrls = [];
  const allVideoUrls = [];
  collectedItems.forEach(i => {
    if (Array.isArray(i.imageUrls)) {
      allImageUrls.push(...i.imageUrls);
    }
    if (Array.isArray(i.videoUrls)) {
      allVideoUrls.push(...i.videoUrls);
    }
  });

  // 如果有视频，直接以原生 video/mp4 完整包含声音和画面提交
  const allMediaParts = [];
  let hasVideo = false;

  if (allVideoUrls.length > 0) {
    hasVideo = true;
    for (const vUrl of allVideoUrls) {
      const vBase64 = await fetchVideoAsBase64(vUrl);
      if (vBase64) {
        allMediaParts.push({
          type: 'image_url',
          image_url: { url: vBase64 }
        });
      }
    }
  }

  for (const imgUrl of allImageUrls) {
    if (imgUrl.startsWith('data:image')) {
      allMediaParts.push({
        type: 'image_url',
        image_url: { url: imgUrl }
      });
    } else {
      const base64Data = await fetchImageAsBase64(imgUrl);
      if (base64Data) {
        allMediaParts.push({
          type: 'image_url',
          image_url: { url: base64Data }
        });
      }
    }
  }

  console.log(`[Waifu模式-聚合触发] 用户 ${userId} (${session.nickname}) 5秒静默结束，聚合了 ${collectedItems.length} 条消息 (文字: ${combinedRawText.length} 字, 视听媒体: ${allMediaParts.length} 个)...`);

  // 构造当前 User Content
  let currentUserContent;
  if (allMediaParts.length > 0) {
    const contentParts = [];
    let defaultMediaPrompt = hasVideo ? '（向你发送了视频[包含完整声音与画面]，期待你的自然反应与互动）' : '（向你发送了图片，期待你的自然反应与互动）';
    const textWithTime = combinedRawText ? `[时间 ${currentHmTime}] ${combinedRawText}` : `[时间 ${currentHmTime}] ${defaultMediaPrompt}`;
    contentParts.push({ type: 'text', text: textWithTime });
    contentParts.push(...allMediaParts);
    currentUserContent = contentParts;
  } else {
    currentUserContent = `[时间 ${currentHmTime}] ${combinedRawText || '（用户向你投来关切的目光）'}`;
  }

  let systemPromptContent = buildCombinedSystemPrompt(session, session.nickname);

  // 仅对用户 10001 启用 RAG 真实往事检索增强
  if (String(userId) === '10001' && combinedRawText) {
    const ragMemoryPrompt = await fetchRagMemories(combinedRawText, 3);
    if (ragMemoryPrompt) {
      console.log(`[RAG-记忆注入] 为用户 ${userId} 成功注入了往事回忆片段`);
      systemPromptContent += '\n' + ragMemoryPrompt;
    }
  }

  const messages = [
    {
      role: 'system',
      content: systemPromptContent
    },
    ...session.history,
    {
      role: 'user',
      content: currentUserContent
    }
  ];

  try {
    if (!isMock) {
      const rawAiReply = await callAIChat(messages, session.model || 'gemini');
      const cleanedReply = handleScheduleTags(rawAiReply, session);
      const msgList = parseMultiMessageResponse(cleanedReply);
      console.log(`[Waifu模式-回复] [${curProvider.name}] 为用户 ${userId} (${session.nickname}) 返回了 ${msgList.length} 条消息`);

      const historyUserContent = typeof currentUserContent === 'string' ? currentUserContent : (combinedRawText || '[图片]');
      session.history.push(
        { role: 'user', content: historyUserContent },
        { role: 'assistant', content: msgList.join('\n') }
      );

      // 智能睡眠与活动状态判断 (仅针对用户 10001)
      if (String(userId) === '10001') {
        const textLower = combinedRawText.toLowerCase();
        // 判定入睡关键词
        const sleepKeywords = ['去睡', '睡觉了', '困了', '晚安', '先睡', '准备睡', '爬去睡', '躺平睡'];
        const wakeKeywords = ['醒了', '睡醒', '早啊', '早上好', '早安', '刚起', '起了'];

        if (sleepKeywords.some(k => textLower.includes(k))) {
          session.isSleeping = true;
          session.lastSleepTs = Date.now();
          console.log(`[状态跟踪] 用户 ${userId} 表达了入睡意图，进入睡眠免打扰状态`);
        } else if (wakeKeywords.some(k => textLower.includes(k))) {
          session.isSleeping = false;
          session.lastActiveTs = Date.now();
          session.lastAutoNudgeTs = Date.now();
          console.log(`[状态跟踪] 用户 ${userId} 已睡醒，恢复主动互动`);
        } else {
          // 如果用户正常说话且之前处于睡眠状态，自动解除睡眠
          if (session.isSleeping) {
            session.isSleeping = false;
            console.log(`[状态跟踪] 用户 ${userId} 发送了新消息，自动唤醒退出睡眠状态`);
          }
          session.lastActiveTs = Date.now();
        }
      }

      savePersistentData();

      await sendMultiPrivateMessages(userId, msgList);
    } else {
      session.history.push(
        { role: 'user', content: combinedRawText || '[图片]' },
        { role: 'assistant', content: 'Mocked Multimodal AI Reply' }
      );
      savePersistentData();
    }
  } catch (err) {
    console.error(`[Waifu模式] 调用 [${curProvider.name}] 接口失败:`, err.message);
    if (!isMock) {
      await sendPrivateMessage(userId, `❌ [${curProvider.name}] 响应异常: ${err.message}`);
    }
  }
}

// 定时事件、每日点赞与30分钟主动关心后台检查循环
export async function checkAndTriggerScheduledEvents() {
  await checkDailyProfileLike();

  // 检查 10001 专属 30 分钟不聊天主动发消息问候
  const ltSession = userSessions.get('10001') || userSessions.get(10001);
  if (ltSession && ltSession.enabled && !ltSession.ignored && !ltSession.isSleeping) {
    const now = Date.now();
    // 若尚未记录 lastActiveTs，默认初始化为现在以开始计时
    if (!ltSession.lastActiveTs) {
      ltSession.lastActiveTs = now;
      savePersistentData();
    }
    const lastActive = ltSession.lastActiveTs || now;
    const lastNudge = ltSession.lastAutoNudgeTs || 0;
    const idleMinutes = (now - lastActive) / 60000;
    const nudgeIntervalMinutes = (now - lastNudge) / 60000;

    // 距上次说话超过 30 分钟，且距上次主动发消息也超过 30 分钟
    if (idleMinutes >= 30 && nudgeIntervalMinutes >= 30) {
      ltSession.lastAutoNudgeTs = now;
      savePersistentData();

      const userTz = (typeof ltSession.timezone === 'number') ? ltSession.timezone : 8;
      const currentHmTime = getUserTimeString(userTz, 'hm');
      console.log(`[主动关心] 用户 10001 醒着且超过 30 分钟未说话，主动发起问候...`);

      const nudgePrompt = `(根据AI助手人设，主人已经超过半小时没发消息了，你有点想他/无聊，主动发一两句简短随意的消息问问他在干嘛，自然随意带口癖，不要叠词)`;
      let sysPrompt = buildCombinedSystemPrompt(ltSession, ltSession.nickname);
      const messages = [
        { role: 'system', content: sysPrompt },
        ...ltSession.history,
        { role: 'user', content: `[时间 ${currentHmTime}] ${nudgePrompt}` }
      ];

      try {
        const rawAiReply = await callAIChat(messages, ltSession.model || 'gemini');
        const msgList = parseMultiMessageResponse(rawAiReply);
        console.log(`[主动关心] 生成了 ${msgList.length} 条问候消息`);

        ltSession.history.push(
          { role: 'user', content: `[时间 ${currentHmTime}] (主人半小时未说话)` },
          { role: 'assistant', content: msgList.join('\n') }
        );
        savePersistentData();

        await sendMultiPrivateMessages(10001, msgList);
      } catch (err) {
        console.error('[主动关心] 发送失败:', err.message);
      }
    }
  }

  for (const [userId, session] of userSessions.entries()) {
    if (session.ignored || !Array.isArray(session.events) || session.events.length === 0) {
      continue;
    }

    const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
    const userHm = getUserTimeString(userTz, 'hm');
    const userDate = getUserTimeString(userTz, 'date');
    const userFull = getUserTimeString(userTz, 'ymd_hm');
    const tzSign = formatTzSign(userTz);

    const nowMs = Date.now();
    for (const eventItem of session.events.slice()) {
      if (eventItem._firing) continue; // 正在请求 AI 处理中，防并发重入

      const isExactHit = eventItem.exactTriggerTs && nowMs >= eventItem.exactTriggerTs;
      const isDailyHit = !eventItem.exactTriggerTs && eventItem.time === userHm && eventItem.lastFiredDate !== userDate;

      if (isExactHit || isDailyHit) {
        eventItem._firing = true;
        eventItem.lastFiredDate = userDate;
        if (eventItem.isOneTime) {
          // 立即从待触发事件中移除，防止 3 秒轮询并发重入
          session.events = session.events.filter(e => e.id !== eventItem.id);
        }
        savePersistentData();

        console.log(`[定时事件触发] 命中用户 ${userId} (${session.nickname}) 定时事件: "${eventItem.content}" (时间: ${userHm} UTC${tzSign})`);

        const promptInstruction = `(根据现在的人设触发这个事件:${eventItem.content} 现在的时间是${userFull})`;

        const systemPromptContent = buildCombinedSystemPrompt(session, session.nickname);
        const messages = [
          {
            role: 'system',
            content: systemPromptContent
          },
          ...session.history,
          {
            role: 'user',
            content: promptInstruction
          }
        ];

        try {
          const rawAiReply = await callAIChat(messages, session.model || 'gemini');
          const cleanedReply = handleScheduleTags(rawAiReply, session);
          const msgList = parseMultiMessageResponse(cleanedReply);
          console.log(`[定时事件触发] AI 为用户 ${userId} 生成 ${msgList.length} 条提醒回复`);

          session.history.push(
            { role: 'user', content: promptInstruction },
            { role: 'assistant', content: msgList.join('\n') }
          );

          if (eventItem.isOneTime) {
            console.log(`[定时事件触发] 一次性口头约定 [#${eventItem.id}] "${eventItem.content}" 已完成发送`);
          }

          savePersistentData();

          await sendMultiPrivateMessages(userId, msgList);
        } catch (err) {
          console.error(`[定时事件触发] 为用户 ${userId} 生成/发送定时事件失败:`, err.message);
        }
      }
    }
  }
}

// 核心消息处理器
export async function handleMessage(event, isMock = false) {
  if (event.post_type !== 'message') {
    return false;
  }

  const senderNickname = event.sender?.card || event.sender?.nickname || '用户';

  let rawText = '';
  const imageUrls = [];
  const videoUrls = [];

  if (Array.isArray(event.message)) {
    for (const item of event.message) {
      if (item.type === 'text') {
        rawText += (item.data?.text || '') + ' ';
      } else if (item.type === 'image') {
        const imgUrl = item.data?.url || item.data?.file;
        if (imgUrl && typeof imgUrl === 'string') {
          imageUrls.push(imgUrl);
        }
      } else if (item.type === 'video') {
        const vidUrl = item.data?.url || item.data?.file;
        if (vidUrl && typeof vidUrl === 'string') {
          videoUrls.push(vidUrl);
        }
      }
    }
  } else if (typeof event.raw_message === 'string') {
    rawText = event.raw_message;
    const cqImgRegex = /\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/gi;
    let match;
    while ((match = cqImgRegex.exec(rawText)) !== null) {
      imageUrls.push(match[1]);
    }
    const cqVidRegex = /\[CQ:video,[^\]]*url=([^,\]]+)[^\]]*\]/gi;
    while ((match = cqVidRegex.exec(rawText)) !== null) {
      videoUrls.push(match[1]);
    }
    rawText = rawText.replace(/\[CQ:[^\]]+\]/g, '').trim();
  } else if (typeof event.message === 'string') {
    rawText = event.message;
  }

  rawText = rawText.trim();
  const trimmedText = rawText;

  // ==========================================================
  // 1. 私聊消息处理
  // ==========================================================
  if (event.message_type === 'private') {
    const userId = Number(event.user_id);
    if (!userId) return false;

    const session = getUserSession(userId);

    if (senderNickname && senderNickname !== '用户') {
      session.nickname = senderNickname;
    }

    // 记录用户 10001 的实时活跃时间与状态
    if (String(userId) === '10001') {
      const textLower = rawText.toLowerCase();
      const sleepKeywords = ['去睡', '睡觉了', '困了', '晚安', '先睡', '准备睡', '爬去睡', '躺平睡'];
      const wakeKeywords = ['醒了', '睡醒', '早啊', '早上好', '早安', '刚起', '起了'];

      if (sleepKeywords.some(k => textLower.includes(k))) {
        session.isSleeping = true;
        session.lastSleepTs = Date.now();
        console.log(`[状态跟踪] 用户 ${userId} 表达了入睡意图，进入睡眠免打扰状态`);
      } else if (wakeKeywords.some(k => textLower.includes(k))) {
        session.isSleeping = false;
        session.lastActiveTs = Date.now();
        session.lastAutoNudgeTs = Date.now();
        console.log(`[状态跟踪] 用户 ${userId} 已睡醒，恢复主动互动`);
      } else {
        if (session.isSleeping) {
          session.isSleeping = false;
          console.log(`[状态跟踪] 用户 ${userId} 发送了新消息，自动唤醒退出睡眠状态`);
        }
        session.lastActiveTs = Date.now();
      }
      savePersistentData();
    }

    // ----------------------------------------------------------
    // 1.0 /ignore (或 /ingore) 一键完全屏蔽/恢复功能 (全局最高优先级)
    // ----------------------------------------------------------
    const lowerText = trimmedText.toLowerCase();
    if (lowerText === '/ignore' || lowerText === '/ingore') {
      // 若有待处理聚合消息队列，清空
      const q = userMessageQueues.get(userId);
      if (q && q.timer) clearTimeout(q.timer);
      userMessageQueues.delete(userId);

      session.ignored = !session.ignored;
      savePersistentData();

      if (session.ignored) {
        console.log(`[屏蔽系统] 用户 ${userId} (${session.nickname}) 开启了全功能屏蔽`);
        if (!isMock) {
          await sendPrivateMessage(userId, '🚫 已屏蔽机器人所有功能。\n在此期间将不再响应您的任何消息。如需恢复，请再次发送 /ignore 。');
        }
      } else {
        console.log(`[屏蔽系统] 用户 ${userId} (${session.nickname}) 解除了全功能屏蔽，已恢复正常`);
        if (!isMock) {
          await sendPrivateMessage(userId, '✅ 已解除屏蔽，恢复机器人所有功能！');
        }
      }
      return true;
    }

    if (session.ignored) {
      console.log(`[屏蔽拦截] 用户 ${userId} 处于全功能屏蔽名单中，忽略消息`);
      return false;
    }

    // ----------------------------------------------------------
    // 1.1 /settings model <key> 模型切换系统
    // ----------------------------------------------------------
    if (trimmedText.startsWith('/settings model') || trimmedText.startsWith('/setting model')) {
      const q = userMessageQueues.get(userId);
      if (q && q.timer) clearTimeout(q.timer);
      userMessageQueues.delete(userId);

      const parts = trimmedText.split(/\s+/);
      const targetModelRaw = (parts[2] || '').toLowerCase();
      const targetModelKey = MODEL_ALIASES[targetModelRaw] || targetModelRaw;

      if (!targetModelKey || !MODEL_PROVIDERS[targetModelKey]) {
        const curProvider = MODEL_PROVIDERS[session.model] || MODEL_PROVIDERS['gemini'];
        const listStr = Object.entries(MODEL_PROVIDERS).map(([k, p]) => `• /settings model ${k} -> ${p.name}`).join('\n');
        if (!isMock) {
          await sendPrivateMessage(userId, `🤖【模型切换设置】\n当前生效模型: ${curProvider.name}\n\n可切换的模型列表：\n${listStr}\n\n例如：/settings model grok4.6 或 /settings model kiro-claude\n\n💡 ouli温馨提示: 切换模型后最好发送 /aichat clear 清空会话，不然会被上面的聊天记录污染格式或风格哦～`);
        }
        return true;
      }

      session.model = targetModelKey;
      session.enabled = true;
      savePersistentData();

      const newProvider = MODEL_PROVIDERS[targetModelKey];
      console.log(`[模型切换] 用户 ${userId} (${session.nickname}) 将模型切换为: ${newProvider.name} (${newProvider.model})`);

      if (!isMock) {
        await sendPrivateMessage(userId, `🤖 模型切换成功！\n• 当前模型：${newProvider.name}\n• 模型标识：${newProvider.model}\n\n💡 ouli温馨提示: 最好清空会话 不然会被上面的聊天记录污染\n（输入 /aichat clear 即可一键清空历史上下文）`);
      }
      return true;
    }

    // ----------------------------------------------------------
    // 1.2 /time <幅度> 自定义用户时区指令
    // ----------------------------------------------------------
    if (trimmedText.startsWith('/time') || trimmedText.startsWith('/timezone')) {
      const parts = trimmedText.split(/\s+/);
      const arg = parts[1];

      if (!arg) {
        const curTz = (typeof session.timezone === 'number') ? session.timezone : 8;
        const curTzSign = formatTzSign(curTz);
        const curTimeStr = getUserTimeString(curTz, 'full');
        if (!isMock) {
          await sendPrivateMessage(userId, `🕒【当前时区设置】\n• 您的时区: UTC${curTzSign}\n• 当前时间: ${curTimeStr}\n\n💡 用法：/time <幅度>\n例如：/time +8 (设为UTC+8) 或 /time -4 (设为UTC-4)\n设置后将自动同步影响 AI 聊天时间感知与定时事件触发。`);
        }
        return true;
      }

      let parsedOffset = null;
      if (arg.includes(':')) {
        const [hStr, mStr] = arg.split(':');
        const h = parseFloat(hStr);
        const m = parseFloat(mStr) || 0;
        parsedOffset = h >= 0 ? (h + m / 60) : (h - m / 60);
      } else {
        parsedOffset = parseFloat(arg);
      }

      if (isNaN(parsedOffset) || parsedOffset < -12 || parsedOffset > 14) {
        if (!isMock) {
          await sendPrivateMessage(userId, '⚠️ 无效的时区偏移量！请输入 -12 到 +14 之间的数值，例如：/time +8 或 /time -4');
        }
        return true;
      }

      session.timezone = parsedOffset;
      savePersistentData();

      const newTzSign = formatTzSign(parsedOffset);
      const newTimeStr = getUserTimeString(parsedOffset, 'full');
      console.log(`[时区设置] 用户 ${userId} (${session.nickname}) 时区更新为 UTC${newTzSign}`);

      if (!isMock) {
        await sendPrivateMessage(userId, `🕒 时区设置成功！\n• 您的时区: UTC${newTzSign}\n• 当前时区时间: ${newTimeStr}\n• 此设置已永久保存，将同步作用于 AI 聊天感知与所有定时提醒事件。`);
      }
      return true;
    }

    // ----------------------------------------------------------
    // 1.3 /image create 独立画图工作流 (全程不写入 aichat 历史)
    // ----------------------------------------------------------
    const imgSession = imageSessions.get(userId);

    if (trimmedText.startsWith('/image create') || trimmedText === '/image') {
      const q = userMessageQueues.get(userId);
      if (q && q.timer) clearTimeout(q.timer);
      userMessageQueues.delete(userId);

      imageSessions.set(userId, {
        state: 'WAITING_IMAGES',
        images: [],
        startTime: Date.now()
      });
      console.log(`[生图工作流] 用户 ${userId} 开启了 /image create 流程`);
      if (!isMock) {
        await sendPrivateMessage(userId, '如果需要传递图片就请传递 反之输入done');
      }
      return true;
    }

    if (imgSession) {
      if (trimmedText === 'cancel' || trimmedText === '取消') {
        imageSessions.delete(userId);
        console.log(`[生图工作流] 用户 ${userId} 取消了生图流程`);
        if (!isMock) {
          await sendPrivateMessage(userId, '❌ 已取消生图流程。');
        }
        return true;
      }

      if (imgSession.state === 'WAITING_IMAGES') {
        if (trimmedText.toLowerCase() === 'done') {
          imgSession.state = 'WAITING_PROMPT';
          console.log(`[生图工作流] 用户 ${userId} 完成图片收集(共 ${imgSession.images.length} 张)，等待输入提示词`);
          if (!isMock) {
            await sendPrivateMessage(userId, '请输入提示词：');
          }
          return true;
        }

        if (imageUrls.length > 0) {
          for (const imgUrl of imageUrls) {
            if (imgUrl.startsWith('data:image')) {
              imgSession.images.push(imgUrl);
            } else {
              const b64 = await fetchImageAsBase64(imgUrl);
              if (b64) imgSession.images.push(b64);
            }
          }
          console.log(`[生图工作流] 用户 ${userId} 传入了图片，当前累积 ${imgSession.images.length} 张`);
          if (!isMock) {
            await sendPrivateMessage(userId, `已接收图片（当前共 ${imgSession.images.length} 张）。若无需再传图片，请输入 done`);
          }
          return true;
        }

        if (!isMock) {
          await sendPrivateMessage(userId, '如果需要传递图片就请传递 反之输入done');
        }
        return true;
      }

      if (imgSession.state === 'WAITING_PROMPT') {
        const promptText = rawText;
        const collectedImages = imgSession.images;
        imageSessions.delete(userId);

        console.log(`[生图工作流] 收到用户 ${userId} 提示词: "${promptText}" (附带 ${collectedImages.length} 张参考图)`);
        
        let tempGenFile = null;
        try {
          if (!isMock) {
            await sendPrivateMessage(userId, '🎨 正在使用 gemini-3.1-flash-image 模型生成图片，请稍候...');
          }

          let userContent;
          if (collectedImages.length > 0) {
            userContent = [
              { type: 'text', text: promptText },
              ...collectedImages.map(b64 => ({
                type: 'image_url',
                image_url: { url: b64 }
              }))
            ];
          } else {
            userContent = promptText;
          }

          if (!isMock) {
            const base64Img = await callImageGeneration(userContent);
            console.log(`[生图工作流] 图片生成成功！准备发送给用户 ${userId}...`);

            const cleanBase64 = base64Img.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
            const fileId = `gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            tempGenFile = path.join(TEMP_DIR, `${fileId}.jpg`);
            fs.writeFileSync(tempGenFile, Buffer.from(cleanBase64, 'base64'));

            await sendPrivateMessage(userId, [
              {
                type: 'image',
                data: {
                  file: `file://${path.resolve(tempGenFile)}`
                }
              }
            ]);
            console.log(`[生图工作流] 生成的图片已成功发送给用户 ${userId}！`);
          }
          return true;
        } catch (genErr) {
          console.error(`[生图工作流] 生成图片失败:`, genErr.message);
          if (!isMock) {
            await sendPrivateMessage(userId, `❌ 生成图片失败: ${genErr.message}`);
          }
          return false;
        } finally {
          if (tempGenFile && fs.existsSync(tempGenFile)) {
            try {
              fs.unlinkSync(tempGenFile);
            } catch (_) {}
          }
        }
      }
    }

    // ----------------------------------------------------------
    // 1.4 /aichat 系列指令 (立即执行，清空待处理队列)
    // ----------------------------------------------------------
    if (trimmedText.startsWith('/aichat')) {
      const q = userMessageQueues.get(userId);
      if (q && q.timer) clearTimeout(q.timer);
      userMessageQueues.delete(userId);

      const parts = trimmedText.split(/\s+/);
      const subCmd = (parts[1] || '').toLowerCase();

      // 1.4.1 /aichat enable
      if (subCmd === 'enable') {
        session.enabled = true;
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 开启了 AI 聊天模式`);
        if (!isMock) {
          const p = MODEL_PROVIDERS[session.model] || MODEL_PROVIDERS['gemini'];
          await sendPrivateMessage(userId, `✅ 已开启 AI 聊天模式！(当前引擎: ${p.name})\n支持 Waifu 模式（连续发消息会等您打完 5 秒后一起回复），输入 /aichat disable 可关闭。`);
        }
        return true;
      }

      // 1.4.2 /aichat disable
      if (subCmd === 'disable') {
        session.enabled = false;
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 关闭了 AI 聊天模式`);
        if (!isMock) {
          await sendPrivateMessage(userId, '❌ 已关闭 AI 聊天模式，已恢复默认提示。');
        }
        return true;
      }

      // 1.4.3 /aichat clear
      if (subCmd === 'clear') {
        session.history = [];
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 清空了会话历史`);
        if (!isMock) {
          await sendPrivateMessage(userId, '🧹 当前上下文已清空，下次对话将只包含 AI 设定、用户人设与旁白世界观。');
        }
        return true;
      }

      // 1.4.4 /aichat besideprompt <文本...>
      if (subCmd === 'besideprompt' || subCmd === 'worldprompt' || subCmd === 'contextprompt') {
        const besidePromptPrefixRegex = /^\/aichat\s+(?:besideprompt|worldprompt|contextprompt)\s*/i;
        const newBesidePrompt = rawText.replace(besidePromptPrefixRegex, '').trim();

        if (newBesidePrompt.toLowerCase() === 'clear' || newBesidePrompt.toLowerCase() === 'none' || newBesidePrompt === '清空' || newBesidePrompt === '无') {
          session.besideprompt = '';
          savePersistentData();
          console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 清空了旁白世界观 (BesidePrompt)`);
          if (!isMock) {
            await sendPrivateMessage(userId, '🧹 旁白/世界观 (BesidePrompt) 已成功清空！');
          }
          return true;
        }

        if (!newBesidePrompt) {
          if (!isMock) {
            const cur = session.besideprompt ? session.besideprompt : '（未设置）';
            await sendPrivateMessage(userId, `💡【旁白/世界观 (BesidePrompt) 设置说明】\n用法：/aichat besideprompt <世界观/情境描述>\n例如：/aichat besideprompt 这是一次在海边度假的旅行，外面正下着微风细雨\n当前设定：\n${cur}\n（输入 /aichat besideprompt clear 可清空）`);
          }
          return true;
        }

        session.besideprompt = newBesidePrompt;
        session.enabled = true;
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 动态更新了旁白世界观 (BesidePrompt): ${newBesidePrompt.slice(0, 50)}...`);
        if (!isMock) {
          await sendPrivateMessage(userId, `🌍 旁白/世界观 (BesidePrompt) 已成功更新并动态生效！\n当前情境设定：\n${newBesidePrompt}`);
        }
        return true;
      }

      // 1.4.5 /aichat event (add/delete/list) 定时事件系统
      if (subCmd === 'event') {
        const action = (parts[2] || '').toLowerCase();
        const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
        const tzSign = formatTzSign(userTz);

        if (action === 'list') {
          if (!session.events || session.events.length === 0) {
            if (!isMock) {
              await sendPrivateMessage(userId, `📅 当前没有任何定时事件。\n用法：/aichat event add <提醒内容> <时间HH:mm>\n例如：/aichat event add 提醒Admin吃饭 04:44 (基于 UTC${tzSign} 时区)`);
            }
            return true;
          }

          let listText = `📅【我的定时事件清单】(UTC${tzSign} 时区)\n`;
          listText += `------------------------------------\n`;
          session.events.forEach(e => {
            listText += `[#${e.id}] 每天 ${e.time} (UTC${tzSign}) - ${e.content}\n`;
          });
          listText += `------------------------------------\n`;
          listText += `提示：输入 /aichat event delete <ID> 可删除对应事件。`;

          if (!isMock) {
            await sendPrivateMessage(userId, listText);
          }
          return true;
        }

        if (action === 'add') {
          const addMatch = rawText.match(/^\/aichat\s+event\s+add\s+([\s\S]+?)\s+([0-2]?[0-9]:[0-5][0-9])$/i);

          if (!addMatch) {
            if (!isMock) {
              await sendPrivateMessage(userId, `⚠️ 格式错误！正确用法：\n/aichat event add <事件内容> <时间HH:mm>\n例如：/aichat event add 提醒Admin吃饭 04:44`);
            }
            return true;
          }

          const eventContent = addMatch[1].trim();
          let rawTime = addMatch[2].trim();
          if (rawTime.length === 4 && rawTime.indexOf(':') === 1) {
            rawTime = '0' + rawTime;
          }

          const nextId = session.events.length > 0 ? (Math.max(...session.events.map(e => e.id || 0)) + 1) : 1;

          const newEvent = {
            id: nextId,
            content: eventContent,
            time: rawTime,
            lastFiredDate: ''
          };

          session.events.push(newEvent);
          savePersistentData();

          console.log(`[定时事件] 用户 ${userId} (${session.nickname}) 添加了定时事件 #${nextId}: "${eventContent}" at ${rawTime} (UTC${tzSign})`);

          if (!isMock) {
            await sendPrivateMessage(userId, `✅ 定时事件添加成功！\n• 事件 ID: #${nextId}\n• 触发时间: 每天 ${rawTime} (UTC${tzSign})\n• 提醒内容: ${eventContent}`);
          }
          return true;
        }

        if (action === 'delete' || action === 'del' || action === 'remove') {
          const targetId = parseInt(parts[3], 10);
          if (isNaN(targetId)) {
            if (!isMock) {
              await sendPrivateMessage(userId, '⚠️ 请输入要删除的事件 ID，例如：/aichat event delete 1');
            }
            return true;
          }

          const idx = session.events.findIndex(e => e.id === targetId);
          if (idx === -1) {
            if (!isMock) {
              await sendPrivateMessage(userId, `⚠️ 未找到 ID 为 #${targetId} 的定时事件。输入 /aichat event list 查看清单。`);
            }
            return true;
          }

          const removed = session.events.splice(idx, 1)[0];
          savePersistentData();

          console.log(`[定时事件] 用户 ${userId} (${session.nickname}) 删除了定时事件 #${targetId}: "${removed.content}"`);

          if (!isMock) {
            await sendPrivateMessage(userId, `🗑️ 已成功删除定时事件 [#${targetId}]：${removed.content}`);
          }
          return true;
        }

        if (!isMock) {
          await sendPrivateMessage(userId, `📅【定时事件指令说明】\n• /aichat event add <内容> <时间HH:mm> - 添加每日定时事件\n• /aichat event list - 查看所有定时事件\n• /aichat event delete <ID> - 删除指定事件\n例如：/aichat event add 提醒Admin吃饭 04:44 (基于 UTC${tzSign})`);
        }
        return true;
      }

      // 1.4.6 /aichat history
      if (subCmd === 'history' || subCmd === 'timeline' || subCmd === 'log') {
        const timelineText = formatConversationTimeline(session);
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 查看了对话时间线 (${session.history.length} 条)`);
        if (!isMock) {
          await sendPrivateMessage(userId, timelineText);
        }
        return true;
      }

      // 1.4.7 /aichat undo
      if (subCmd === 'undo' || subCmd === 'rollback') {
        if (!session.history || session.history.length === 0) {
          if (!isMock) {
            await sendPrivateMessage(userId, '⚠️ 当前没有可撤销的对话记录。');
          }
          return true;
        }

        let removedAssistant = null;
        let removedUser = null;

        if (session.history.length > 0 && session.history[session.history.length - 1].role === 'assistant') {
          removedAssistant = session.history.pop();
        }
        if (session.history.length > 0 && session.history[session.history.length - 1].role === 'user') {
          removedUser = session.history.pop();
        }

        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 撤销了上一轮对话 (剩余 ${session.history.length} 条)`);

        if (!isMock) {
          const userPreview = removedUser ? (typeof removedUser.content === 'string' ? removedUser.content : '[图文消息]') : '无';
          const aiPreview = removedAssistant ? (removedAssistant.content.slice(0, 40) + '...') : '无';
          await sendPrivateMessage(userId, `↩️ 已成功撤销上一轮对话！\n• 撤销的发送：${userPreview}\n• 撤销的回复：${aiPreview}\n当前剩余对话轮数：${Math.floor(session.history.length / 2)} 轮`);
        }
        return true;
      }

      // 1.4.8 /aichat retry
      if (subCmd === 'retry') {
        if (!session.history || session.history.length === 0) {
          if (!isMock) {
            await sendPrivateMessage(userId, '⚠️ 当前没有可重新生成的对话记录。');
          }
          return true;
        }

        if (session.history[session.history.length - 1].role === 'assistant') {
          session.history.pop();
        }

        if (session.history.length === 0 || session.history[session.history.length - 1].role !== 'user') {
          if (!isMock) {
            await sendPrivateMessage(userId, '⚠️ 未找到需要重试的用户提问。');
          }
          return true;
        }

        const lastUserItem = session.history[session.history.length - 1];
        let userPromptText = '';
        if (typeof lastUserItem.content === 'string') {
          userPromptText = lastUserItem.content;
        } else if (Array.isArray(lastUserItem.content)) {
          const textPart = lastUserItem.content.find(c => c.type === 'text');
          userPromptText = textPart ? textPart.text : '[图文消息]';
        } else {
          userPromptText = String(lastUserItem.content || '');
        }

        session.enabled = true;
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 触发了 /aichat retry 重新生成: "${userPromptText}"`);

        if (!isMock) {
          await sendPrivateMessage(userId, `重新生成"${userPromptText}"`);
        }

        const systemPromptContent = buildCombinedSystemPrompt(session, session.nickname);
        const messages = [
          {
            role: 'system',
            content: systemPromptContent
          },
          ...session.history
        ];

        try {
          if (!isMock) {
            const rawAiReply = await callAIChat(messages, session.model || 'gemini');
            const msgList = parseMultiMessageResponse(rawAiReply);
            console.log(`[AI聊天-Retry] AI 重新生成 ${msgList.length} 条回复给用户 ${userId}`);

            session.history.push({ role: 'assistant', content: msgList.join('\n') });
            savePersistentData();

            await sendMultiPrivateMessages(userId, msgList);
          }
          return true;
        } catch (err) {
          console.error(`[AI聊天-Retry] 重新生成回复失败:`, err.message);
          if (!isMock) {
            await sendPrivateMessage(userId, `❌ 重新生成失败: ${err.message}`);
          }
          return false;
        }
      }

      // 1.4.9 /aichat prompt <文本...>
      if (subCmd === 'prompt') {
        const promptPrefixRegex = /^\/aichat\s+prompt\s*/i;
        const newPrompt = rawText.replace(promptPrefixRegex, '').trim();

        if (!newPrompt) {
          if (!isMock) {
            await sendPrivateMessage(userId, `⚠️ 请在 prompt 后面输入内容，例如：\n/aichat prompt 你是一个猫娘\n当前 AI 设定：${session.prompt || DEFAULT_PROMPT}`);
          }
          return true;
        }

        session.prompt = newPrompt;
        session.enabled = true;
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 更新了 AI 设定 (Prompt): ${newPrompt.slice(0, 50)}...`);
        if (!isMock) {
          await sendPrivateMessage(userId, `📝 AI 设定 (Prompt) 已成功更新并持久化！\n当前 AI 设定：\n${newPrompt}`);
        }
        return true;
      }

      // 1.4.10 /aichat selfprompt <文本...>
      if (subCmd === 'selfprompt') {
        const selfPromptPrefixRegex = /^\/aichat\s+selfprompt\s*/i;
        const newSelfPrompt = rawText.replace(selfPromptPrefixRegex, '').trim();

        if (!newSelfPrompt) {
          if (!isMock) {
            const cur = session.selfprompt ? session.selfprompt : '（未设置）';
            await sendPrivateMessage(userId, `💡【用户人设设置说明】\n用法：/aichat selfprompt <你的人设描述>\n例如：/aichat selfprompt 我是一个20岁大学生，性格活泼，喜欢二次元\n当前用户人设：\n${cur}`);
          }
          return true;
        }

        session.selfprompt = newSelfPrompt;
        session.enabled = true;
        savePersistentData();
        console.log(`[AI指令] 用户 ${userId} (${session.nickname}) 更新了用户人设 (SelfPrompt): ${newSelfPrompt.slice(0, 50)}...`);
        if (!isMock) {
          await sendPrivateMessage(userId, `👤 用户人设 (SelfPrompt) 已成功更新并持久化！\n当前用户人设：\n${newSelfPrompt}`);
        }
        return true;
      }

      // 1.4.11 菜单提示
      if (!isMock) {
        const userTz = (typeof session.timezone === 'number') ? session.timezone : 8;
        const tzSign = formatTzSign(userTz);
        const provider = MODEL_PROVIDERS[session.model] || MODEL_PROVIDERS['gemini'];
        const aiPromptShow = (session.prompt && session.prompt.length > 20) ? session.prompt.slice(0, 20) + '...' : (session.prompt || DEFAULT_PROMPT);
        const selfPromptShow = session.selfprompt ? (session.selfprompt.length > 20 ? session.selfprompt.slice(0, 20) + '...' : session.selfprompt) : '（未设置）';
        const besidePromptShow = session.besideprompt ? (session.besideprompt.length > 20 ? session.besideprompt.slice(0, 20) + '...' : session.besideprompt) : '（未设置）';

        await sendPrivateMessage(userId, `🤖【/aichat 指令菜单】\n• /settings model <名称> - 切换模型 (gemini/kiro-claude/aws-claude/grok4.5/grok4.6)\n• /time <幅度> - 自定义您的时区 (如 /time +8, /time -4)\n• /aichat enable - 开启 AI 聊天模式\n• /aichat disable - 关闭 AI 聊天模式\n• /aichat retry - 重新生成上一条 AI 回复\n• /aichat undo - 撤销上一轮对话 (问+答)\n• /aichat history - 查看完整对话时间线\n• /aichat event add <内容> <时间HH:mm> - 添加定时事件\n• /aichat event list - 查看定时事件清单\n• /aichat event delete <ID> - 删除定时事件\n• /aichat clear - 清空上下文记录\n• /aichat prompt <内容> - 设置 AI 的人设/提示词\n• /aichat selfprompt <内容> - 设置你自己的人设\n• /aichat besideprompt <内容> - 动态穿插旁白/世界观设定\n• /image create - 开启 AI 生图/修图向导\n• /ignore - 屏蔽/恢复机器人所有功能\n\n📌 当前状态: ${session.enabled ? '已开启' : '已关闭'}\n🤖 当前模型: ${provider.name}\n🕒 个人时区: UTC${tzSign}\n👤 用户昵称: ${session.nickname || '用户'}\n🎭 AI设定: ${aiPromptShow}\n👤 用户人设: ${selfPromptShow}\n🌍 旁白世界观: ${besidePromptShow}`);
      }
      return true;
    }

    // ----------------------------------------------------------
    // 1.5 AI 聊天多轮对话 (Waifu 模式：5 秒静默防打断聚合)
    // ----------------------------------------------------------
    if (session.enabled) {
      // 获取或初始化用户的聚合队列
      let queue = userMessageQueues.get(userId);
      if (!queue) {
        queue = {
          items: [],
          timer: null
        };
        userMessageQueues.set(userId, queue);
      }

      // 将当前输入放入队列
      queue.items.push({
        rawText,
        imageUrls,
        videoUrls,
        timestamp: Date.now()
      });

      console.log(`[Waifu模式] 收到用户 ${userId} (${session.nickname}) 消息片段 (当前累积 ${queue.items.length} 条)，等待 5 秒防打断静默...`);

      // 重置 5 秒计时器
      if (queue.timer) {
        clearTimeout(queue.timer);
      }

      queue.isMock = isMock;
      queue.timer = setTimeout(async () => {
        try {
          const mockFlag = queue ? queue.isMock : isMock;
          const itemsToProcess = queue ? queue.items.slice() : [];
          userMessageQueues.delete(userId);
          await processAggregatedUserMessagesDirect(userId, itemsToProcess, mockFlag);
        } catch (err) {
          console.error('[Waifu-Timer-Error] 聚合消息处理异常:', err);
        }
      }, WAIFU_DEBOUNCE_MS);

      return true;
    }

    // ----------------------------------------------------------
    // 1.6 默认防扰状态 (每小时仅提示一次)
    // ----------------------------------------------------------
    const now = Date.now();
    if (!session.lastRepliedTs || (now - session.lastRepliedTs >= ONE_HOUR_MS)) {
      session.lastRepliedTs = now;
      savePersistentData();
      console.log(`[私聊回复] 收到用户 ${userId} (${session.nickname}) 私聊（本小时首次），发送停用提示...`);
      if (!isMock) {
        try {
          await sendPrivateMessage(userId, PRIVATE_REPLY_TEXT);
        } catch (err) {
          console.error(`[私聊回复] 发送失败:`, err.message);
        }
      }
      return true;
    } else {
      console.log(`[私聊拦截] 用户 ${userId} (${session.nickname}) 1 小时内已触发过停用提示，不重复回复`);
      return false;
    }
  }

  // ==========================================================
  // 2. 群聊消息处理：严格校验群号 123456789 白名单
  // ==========================================================
  if (event.message_type !== 'group') {
    return false;
  }
  if (Number(event.group_id) !== TARGET_GROUP_ID) {
    return false;
  }

  const matchedUrl = extractDouyinUrl(rawText);
  if (!matchedUrl) {
    return false;
  }

  if (isRateLimited(matchedUrl)) {
    console.log(`[抖音解析] 短时间内重复链接，触发防刷忽略: ${matchedUrl}`);
    return false;
  }

  console.log(`[抖音解析] 命中群 ${TARGET_GROUP_ID} 抖音分享: ${matchedUrl}`);

  const tempFilesToClean = [];

  try {
    const parseResult = await parseDouyin(matchedUrl);
    const { type, title, author, video_url, slides, music_url } = parseResult;
    console.log(`[抖音解析] 解析成功 -> 类型: [${type}], 标题: [${title || '无'}], 作者: [${author || '未知'}]`);

    // 纯视频
    if (type === 'video' && video_url) {
      const fileId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const tempVideoPath = path.join(TEMP_DIR, `${fileId}.mp4`);
      tempFilesToClean.push(tempVideoPath);

      console.log(`[抖音解析] 正在下载去水印视频...`);
      const fileSize = await downloadFile(video_url, tempVideoPath);
      console.log(`[抖音解析] 视频下载成功 (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

      if (!isMock) {
        const infoText = `🎬【抖音解析】${title ? title : '无标题'}\n👤 作者：${author || '未知'}`;
        await sendGroupMessage(TARGET_GROUP_ID, [
          { type: 'text', data: { text: infoText } }
        ]);

        console.log(`[抖音解析] 正在发送视频到群 ${TARGET_GROUP_ID}...`);
        await sendGroupMessage(TARGET_GROUP_ID, [
          {
            type: 'video',
            data: {
              file: `file://${path.resolve(tempVideoPath)}`
            }
          }
        ]);
        console.log(`[抖音解析] 视频发送成功！`);
      }
      return true;
    }

    // 图集
    else if (type === 'gallery' && Array.isArray(slides) && slides.length > 0) {
      console.log(`[抖音解析] 图集作品，共 ${slides.length} 张图片`);

      if (!isMock) {
        let galleryText = `🖼️【抖音图集】${title ? title : '无标题'}\n👤 作者：${author || '未知'} (共 ${slides.length} 张图)`;
        if (music_url) {
          galleryText += `\n🎵 背景音乐: ${music_url}`;
        }
        await sendGroupMessage(TARGET_GROUP_ID, [
          { type: 'text', data: { text: galleryText } }
        ]);

        const batchSize = 3;
        for (let i = 0; i < slides.length; i += batchSize) {
          const batch = slides.slice(i, i + batchSize);
          const imgMessages = batch.map(item => ({
            type: 'image',
            data: { file: item.image_url }
          }));
          await sendGroupMessage(TARGET_GROUP_ID, imgMessages);
          await new Promise(r => setTimeout(r, 400));
        }
        console.log(`[抖音解析] 全部图集图片发送完毕！`);
      }
      return true;
    } else {
      console.warn(`[抖音解析] 未知作品类型: ${type}`);
      return false;
    }
  } catch (err) {
    console.error(`[抖音解析] 解析处理异常 [${err.code || 'ERROR'}]:`, err.message);
    if (!isMock) {
      if (err.code === 'PARSE_FAILED' || err.message.includes('抖音') || err.message.includes('作品') || err.message.includes('权限')) {
        try {
          await sendGroupMessage(TARGET_GROUP_ID, [
            { type: 'text', data: { text: `⚠️ 抖音解析提示: ${err.message}` } }
          ]);
        } catch (_) {}
      }
    }
    return false;
  } finally {
    for (const filePath of tempFilesToClean) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`[抖音解析] 已安全清理临时文件: ${filePath}`);
        } catch (cleanErr) {
          console.error(`[抖音解析] 清理临时文件失败:`, cleanErr.message);
        }
      }
    }
  }
}

// WebSocket 监听器与长连接守护
export function startWebSocketListener() {
  loadPersistentData();
  console.log(`[抖音解析插件] 正在连接 OneBot WebSocket: ${ONEBOT_WS_URL}`);
  let ws = null;
  let isConnecting = false;

  setInterval(async () => {
    try {
      await checkAndTriggerScheduledEvents();
    } catch (e) {
      console.error('[定时任务异常]:', e.message);
    }
  }, 3000);

  function connect() {
    if (isConnecting) return;
    isConnecting = true;

    try {
      const headers = {};
      if (ONEBOT_TOKEN) headers['Authorization'] = `Bearer ${ONEBOT_TOKEN}`;

      ws = new WebSocket(ONEBOT_WS_URL, { headers });

      ws.onopen = () => {
        isConnecting = false;
        console.log(`[抖音解析插件] OneBot WebSocket 连接成功！`);
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          await handleMessage(data);
        } catch (e) {
          console.error(`[抖音解析插件] 消息处理异常:`, e.message);
        }
      };

      ws.onerror = (err) => {
        isConnecting = false;
        console.warn(`[抖音解析插件] WebSocket 异常 (${err.message || '连接断开'})...`);
      };

      ws.onclose = () => {
        isConnecting = false;
        setTimeout(connect, 5000);
      };
    } catch (e) {
      isConnecting = false;
      setTimeout(connect, 5000);
    }
  }

  connect();
}

if (process.argv[1] && process.argv[1].endsWith('bot.mjs')) {
  console.log(`=======================================================`);
  console.log(`  NapCat 抖音解析 + Waifu多消息聚合防打断 + 生图全功能插件`);
  console.log(`  唯一白名单群: ${TARGET_GROUP_ID}`);
  console.log(`  本地持久化文件: ${DATA_FILE}`);
  console.log(`=======================================================`);
  startWebSocketListener();
}
