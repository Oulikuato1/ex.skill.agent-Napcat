import json
import os
import shutil
import tempfile
import requests
from pathlib import Path
from typing import List, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.models import (
    SearchRequest,
    SearchResponse,
    MemoryItem,
    ChatCompleteRequest,
    ChatCompleteResponse,
    IndexDirectoryRequest,
    IndexStatusResponse
)
from app.parser import (
    parse_jsonl_file,
    chunk_messages_into_conversations
)
from app.vector_store import vector_store
from app.prompt_builder import (
    format_memory_prompt,
    build_full_messages,
    build_rerank_messages,
    DEFAULT_PERSONA
)

app = FastAPI(
    title="Ex-Skill RAG Memory Server",
    description="专属聊天记录 RAG 向量记忆检索与对话服务",
    version="1.0.0"
)

# Enable CORS for local/bot integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def index():
    return {
        "service": "Ex-Skill RAG Memory Server",
        "status": "running",
        "collection": settings.COLLECTION_NAME,
        "total_memories": vector_store.count(),
        "docs_url": "/docs"
    }

@app.get("/api/memory/status", response_model=IndexStatusResponse)
def get_status():
    """获取当前记忆库状态与条数"""
    return IndexStatusResponse(
        collection_name=settings.COLLECTION_NAME,
        total_memories=vector_store.count(),
        db_path=settings.MEMORY_STORE_PATH
    )

@app.post("/api/memory/search", response_model=SearchResponse)
def search_memory(req: SearchRequest):
    """根据当前对话或关键词检索最相关的往事记忆"""
    try:
        results = vector_store.query(
            query_text=req.query,
            top_k=req.top_k,
            score_threshold=req.score_threshold
        )
        formatted_prompt = format_memory_prompt(results)
        memories = [MemoryItem(**m) for m in results]
        return SearchResponse(
            query=req.query,
            count=len(memories),
            memories=memories,
            formatted_prompt=formatted_prompt
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"检索记忆失败: {str(e)}")

@app.post("/api/memory/upload")
async def upload_and_index_file(
    file: UploadFile = File(...),
    peer_name: str = Form("Persona"),
    self_name: str = Form("User")
):
    """上传单个 .jsonl 导出文件并自动分块索引入库"""
    suffix = Path(file.filename).suffix.lower()
    if suffix not in [".jsonl", ".txt"]:
        raise HTTPException(status_code=400, detail="只支持上传 .jsonl 或 .txt 格式的聊天记录文件")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        raw_msgs = parse_jsonl_file(tmp_path, peer_name=peer_name, self_name=self_name)
        chunks = chunk_messages_into_conversations(
            raw_msgs,
            split_minutes=settings.SESSION_SPLIT_MINUTES,
            max_msgs=settings.MAX_MESSAGES_PER_CHUNK,
            min_msgs=settings.MIN_MESSAGES_PER_CHUNK
        )
        added_count = vector_store.add_chunks_batch(chunks)
        return {
            "status": "success",
            "file": file.filename,
            "parsed_messages": len(raw_msgs),
            "generated_chunks": len(chunks),
            "indexed_count": added_count,
            "total_collection_count": vector_store.count()
        }
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

@app.post("/api/memory/index_directory")
def index_directory(req: IndexDirectoryRequest):
    """直接指定本地目录扫描其中的所有 jsonl 文件并全量入库"""
    dir_path = Path(req.directory_path)
    if not dir_path.exists() or not dir_path.is_dir():
        raise HTTPException(status_code=400, detail=f"目录不存在: {req.directory_path}")

    jsonl_files = list(dir_path.glob("**/*.jsonl"))
    if not jsonl_files:
        raise HTTPException(status_code=404, detail="该目录下未找到任何 .jsonl 文件")

    total_parsed_msgs = 0
    all_chunks = []

    for jf in jsonl_files:
        msgs = parse_jsonl_file(str(jf), peer_name=req.peer_name, self_name=req.self_name)
        total_parsed_msgs += len(msgs)
        chunks = chunk_messages_into_conversations(
            msgs,
            split_minutes=settings.SESSION_SPLIT_MINUTES,
            max_msgs=settings.MAX_MESSAGES_PER_CHUNK,
            min_msgs=settings.MIN_MESSAGES_PER_CHUNK
        )
        all_chunks.extend(chunks)

    added_count = vector_store.add_chunks_batch(all_chunks)

    return {
        "status": "success",
        "scanned_files": len(jsonl_files),
        "total_parsed_messages": total_parsed_msgs,
        "total_chunks": len(all_chunks),
        "indexed_chunks": added_count,
        "total_collection_count": vector_store.count()
    }

@app.delete("/api/memory/clear")
def clear_memory():
    """清空当前记忆库"""
    vector_store.clear()
    return {"status": "cleared", "total_memories": 0}

def call_llm(messages: List[Dict[str, str]], temperature: float = 0.7) -> str:
    """Call upstream LLM (OpenAI-compatible chat completions)"""
    url = f"{settings.LLM_API_BASE.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.LLM_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "temperature": temperature
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]

@app.post("/api/chat/complete", response_model=ChatCompleteResponse)
def chat_complete(req: ChatCompleteRequest):
    """一站式智能聊天代理接口：自动查记忆 -> 拼 Prompt -> 请求 LLM -> 返回回复"""
    if not settings.LLM_API_KEY:
        raise HTTPException(status_code=500, detail="未配置 LLM_API_KEY，请在 .env 中配置大模型 API Key！")

    # 1. 直接通过倒排索引秒级检索 top_k 条最相关记忆
    used_memories = []
    if req.enable_memory and vector_store.count() > 0:
        raw_mem = vector_store.query(req.message, top_k=req.top_k or 3)
        used_memories = [MemoryItem(**m) for m in raw_mem]

    # 2. 组装全量 messages (Persona + 真实回忆片段 + 上下滑动历史 + 当前消息)
    messages = build_full_messages(
        user_message=req.message,
        history=req.history,
        memories=[m.model_dump() for m in used_memories]
    )

    # 3. 单次调用大模型生成最终回复
    try:
        reply_content = call_llm(messages)
        return ChatCompleteResponse(
            reply=reply_content,
            memory_found=len(used_memories) > 0,
            used_memories=used_memories
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"调用大模型失败: {str(e)}")

def main():
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=True)

if __name__ == "__main__":
    main()
