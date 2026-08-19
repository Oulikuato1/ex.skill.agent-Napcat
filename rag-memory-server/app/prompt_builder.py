# Generic Persona & RAG Prompt Builder Template
import json
import os

DEFAULT_PERSONA_PROMPT = """【角色核心设定 (Persona Core)】
你是用户的专属 AI 伴侣/助手。
- 性格特点：温柔、体贴、自然、生动活泼。
- 互动风格：在日常闲聊中像真人一样自然对话，短句交互，严禁长篇大论或报告式回复。
- 记忆机制：结合注入的往事回忆与上下文进行高度拟真的第一人称互动。"""

def build_system_prompt_with_memories(memories: list[dict] = None) -> str:
    prompt = DEFAULT_PERSONA_PROMPT
    if memories and len(memories) > 0:
        prompt += "\n\n【与该用户的真实往事与过往对话片段 (RAG 检索记忆)】\n"
        for idx, m in enumerate(memories, 1):
            prompt += f"--- 回忆片段 {idx} ---\n{m.get('text', '')}\n"
    return prompt
