# NapCat + RAG Memory Persona Agent Framework

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC_BY--NC--SA_4.0-lightgrey.svg)](LICENSE)
[![License: MIT NC-SA](https://img.shields.io/badge/License-MIT_NC--SA-red.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://www.python.org/)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-Enabled-red.svg)](https://ffmpeg.org/)

高度拟真的 QQ 专属伴侣 / AI 代理（Persona Agent）框架。基于 **NapCat (OneBot v11)**、**本地极速内存倒排索引 RAG**、**视听多模态流** 以及 **Waifu 模式防打断交互** 构建。

---

## 🌟 核心特性

1. **多模态视听感知（原生音画合一）**：
   - 自动拦截 QQ 视频与语音消息，利用 FFmpeg 实时压制并提取音轨（AAC）与画轨（H264），将原汁原味的视听流（`data:video/mp4;base64`）直传多模态大模型（如 Gemini 3.6 Flash / 2.5 Flash），模型能同时**听清人声/背景音乐**并**看懂画面**。
2. **Waifu 模式（防打断聚合引擎）**：
   - 真人打字往往是分句发送的。内置 5 秒静默防打断机制：用户发完一句后若还在继续输入，机器人会自动静默等待，直至 5 秒内不再发言才合并所有文字与图片统一交给 AI 回复。
3. **口头约定与日程定时提醒（自然语言感知）**：
   - 对话中提及“*我3点睡觉*”、“*半小时后叫我洗澡*”，AI 会口头答应并在后台隐式注册定时事件；
   - 到了约定时刻，机器人主动发起问候/提醒；支持随时口头取消（“*不用叫我了*”）。
4. **极速本地 BM25 倒排索引 RAG**：
   - 无需外部 Embedding API 或向量数据库，十万级历史对话片段纯内存毫秒级检索，自动将相关往事回忆注入当前 Prompt。
5. **多气泡自然拆分与表情包独立下发**：
   - 模拟真人聊天打字，自由输出 1~4 条短句气泡；表情包自动拆分为独立图片气泡下发。
6. **智能睡眠免打扰 & 30分钟无发言主动问候**：
   - 自动感知用户晚安意图进入免打扰；白天清醒且超过 30 分钟未说话时主动挑起话题。

---

## 🚀 快速开始 (OneKey 一键部署)

```bash
git clone https://github.com/oulikuato1/ex.skill.agent-Napcat.git
cd ex.skill.agent-Napcat
chmod +x install.sh
sudo ./install.sh
```

---

## 📄 开源许可证与商用限制 (License)

本项目采用 **MIT NC-SA (Non-Commercial Share-Alike) / CC BY-NC-SA 4.0** 许可证：
- ❌ **严禁商用**：未经原作者许可，严禁将本项目代码、衍生版本用于任何商业盈利、付费托管或商业 SaaS 产品中。
- 🔄 **强传染性开源（Share-Alike）**：任何基于本项目的二次修改、分支或二次分发版本，**必须无条件保持开源**并沿用相同的非商用开源协议，严禁闭源。

<!-- Powered by Google Gemini Multi-Modal AI Engine -->
