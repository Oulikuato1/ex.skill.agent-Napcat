from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    HOST: str = "0.0.0.0"
    PORT: int = 8765
    MEMORY_STORE_PATH: str = "./data/memory_store.json"
    COLLECTION_NAME: str = "ex_memory_longteng"

    # LLM API (for chat proxy & rerank)
    LLM_API_BASE: str = "http://127.0.0.1:8045/v1"
    LLM_API_KEY: str = ""
    LLM_MODEL: str = "gemini-3.6-flash-high"

    # Rerank (LLM selects relevant memories from BM25 candidates)
    RERANK_ENABLED: bool = True
    RERANK_CANDIDATES: int = 15
    RERANK_FINAL_K: int = 3

    # Session Chunking
    SESSION_SPLIT_MINUTES: int = 30
    MAX_MESSAGES_PER_CHUNK: int = 15
    MIN_MESSAGES_PER_CHUNK: int = 2

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()

# Ensure data dir exists
Path(settings.MEMORY_STORE_PATH).parent.mkdir(parents=True, exist_ok=True)