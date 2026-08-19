import json
import math
import re
from pathlib import Path
from collections import Counter
from typing import List, Dict, Any

import jieba

from app.config import settings


class MemoryStore:
    """High-performance in-memory inverted index + BM25"""

    def __init__(self, path: str = None):
        self.path = Path(path or settings.MEMORY_STORE_PATH)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.chunks: List[Dict[str, Any]] = []
        # Precomputed term frequencies per doc: [ {term: count}, ... ]
        self.doc_tfs: List[Dict[str, int]] = []
        self.doc_lens: List[int] = []
        # Inverted index: term -> list of doc indices
        self.inverted_index: Dict[str, List[int]] = {}
        self.doc_freq: Counter = Counter()
        self.doc_count = 0
        self.avg_len = 0.0
        self._load()

    # ---------- persistence ----------
    def _load(self):
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self.chunks = data.get("chunks", [])
                self._rebuild_index()
            except Exception as e:
                print(f"[MemoryStore] load error: {e}")
                self.chunks = []

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"chunks": self.chunks}, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    # ---------- tokenize & index ----------
    @staticmethod
    def _tokenize(text: str) -> List[str]:
        text = re.sub(r"[\[\]【】:：~～\-–—・。，、；！？…\s]+", " ", text)
        return [t.strip() for t in jieba.lcut(text) if t.strip()]

    def _rebuild_index(self):
        self.doc_count = len(self.chunks)
        self.doc_tfs = []
        self.doc_lens = []
        self.inverted_index = {}
        self.doc_freq = Counter()

        total_len = 0
        for doc_id, c in enumerate(self.chunks):
            terms = self._tokenize(c["chunk_text"])
            tf = Counter(terms)
            self.doc_tfs.append(dict(tf))
            dl = len(terms)
            self.doc_lens.append(dl)
            total_len += dl

            unique_terms = set(tf.keys())
            for t in unique_terms:
                self.doc_freq[t] += 1
                if t not in self.inverted_index:
                    self.inverted_index[t] = []
                self.inverted_index[t].append(doc_id)

        self.avg_len = total_len / max(self.doc_count, 1)
        print(f"[MemoryStore] Inverted index built: {self.doc_count} docs, {len(self.inverted_index)} unique terms")

    # ---------- add ----------
    def add_chunks_batch(self, chunks: List[Dict[str, Any]], batch_size: int = 64) -> int:
        existing = set(c["id"] for c in self.chunks)
        added = 0
        for idx, c in enumerate(chunks):
            cid = f"mem_{c['start_time'].replace(' ', '_').replace(':', '')}_{idx:05d}"
            if cid in existing:
                continue
            self.chunks.append({
                "id": cid,
                "chunk_text": c["chunk_text"],
                "start_time": c["start_time"],
                "end_time": c["end_time"],
                "message_count": c.get("message_count", 0),
                "senders": c.get("senders", [])
            })
            existing.add(cid)
            added += 1
        if added:
            self._rebuild_index()
            self._save()
        return added

    # ---------- query (Inverted Index BM25 - O(terms) instant speed) ----------
    def query(self, query_text: str, top_k: int = 3, score_threshold: float = 0.0) -> List[Dict[str, Any]]:
        if not self.chunks or not self.doc_count:
            return []
        terms = self._tokenize(query_text)
        if not terms:
            return []

        k1, b = 1.5, 0.75
        scores: Dict[int, float] = {}

        for t in set(terms):
            matching_docs = self.inverted_index.get(t)
            if not matching_docs:
                continue
            df = self.doc_freq.get(t, 0)
            idf = math.log(1 + (self.doc_count - df + 0.5) / (df + 0.5))

            for doc_id in matching_docs:
                n = self.doc_tfs[doc_id].get(t, 0)
                dl = self.doc_lens[doc_id]
                s = idf * (n * (k1 + 1)) / (n + k1 * (1 - b + b * dl / max(self.avg_len, 1)))
                scores[doc_id] = scores.get(doc_id, 0.0) + s

        if not scores:
            return []

        ranked_doc_ids = sorted(scores.keys(), key=lambda did: scores[did], reverse=True)
        results = []
        for did in ranked_doc_ids:
            score = scores[did]
            if score < score_threshold:
                break
            c = self.chunks[did]
            results.append({
                "id": c["id"],
                "text": c["chunk_text"],
                "score": round(score, 4),
                "timestamp_start": c["start_time"],
                "timestamp_end": c["end_time"],
                "metadata": {
                    "message_count": c.get("message_count", 0),
                    "senders": c.get("senders", [])
                }
            })
            if len(results) >= top_k:
                break
        return results

    def count(self) -> int:
        return len(self.chunks)

    def clear(self):
        self.chunks = []
        self.doc_tfs = []
        self.doc_lens = []
        self.inverted_index = {}
        self.doc_freq = Counter()
        self.doc_count = 0
        self.avg_len = 0.0
        self._save()


vector_store = MemoryStore()