from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class SearchRequest(BaseModel):
    query: str = Field(..., description="用户发起的查询或当前输入的消息")
    top_k: int = Field(default=3, ge=1, le=10, description="返回最相关的记忆片段数量")
    score_threshold: float = Field(default=0.0, description="BM25 分数阈值过滤（大于该值才返回）")

class MemoryItem(BaseModel):
    id: str
    text: str
    timestamp_start: str
    timestamp_end: str
    score: float
    metadata: Dict[str, Any] = {}

class SearchResponse(BaseModel):
    query: str
    count: int
    memories: List[MemoryItem]
    formatted_prompt: str

class ChatCompleteRequest(BaseModel):
    message: str = Field(..., description="用户最新发送的一句话")
    history: List[Dict[str, str]] = Field(default_factory=list, description="近期上下文聊天历史 [{'role':'user'/'assistant','content':'...'}]")
    enable_memory: bool = Field(default=True, description="是否自动检索记忆并注入")
    top_k: int = Field(default=3, ge=1, le=5)

class ChatCompleteResponse(BaseModel):
    reply: str
    memory_found: bool
    used_memories: List[MemoryItem] = []

class IndexDirectoryRequest(BaseModel):
    directory_path: str = Field(..., description="存放 jsonl 文件的目录路径")
    peer_name: str = Field(default="Persona", description="前任昵称")
    self_name: str = Field(default="User", description="你的昵称")

class IndexStatusResponse(BaseModel):
    collection_name: str
    total_memories: int
    db_path: str
