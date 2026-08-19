import json
import os
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Generator

def parse_iso_or_ts(ts_val) -> float:
    """Parse timestamp (either epoch ms/s or ISO string)"""
    if isinstance(ts_val, (int, float)):
        return ts_val / 1000.0 if ts_val > 1e11 else float(ts_val)
    if isinstance(ts_val, str):
        try:
            dt = datetime.fromisoformat(ts_val.replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            pass
    return 0.0

def format_elements(elements: List[Dict[str, Any]]) -> str:
    """Convert QQ rich media elements into clean descriptive text"""
    parts = []
    for elem in elements:
        etype = elem.get("type", "")
        edata = elem.get("data", {})
        if etype == "text":
            parts.append(edata.get("text", ""))
        elif etype == "image":
            parts.append("[图片]")
        elif etype == "face":
            parts.append(f"[表情_{edata.get('id', '')}]")
        elif etype == "audio":
            parts.append("[语音]")
        elif etype == "video":
            parts.append("[视频]")
    return "".join(parts)

def parse_jsonl_file(
    file_path: str,
    peer_uid: str = "u_YYmBa3PWxA37-QmPtweoqQ",
    peer_name: str = "Persona",
    self_name: str = "User"
) -> List[Dict[str, Any]]:
    """Read a JSONL file and return raw clean message objects"""
    messages = []
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except Exception:
                continue

            sender_uid = data.get("sender", {}).get("uid", "")
            time_str = data.get("time", "")
            ts = parse_iso_or_ts(data.get("timestamp", 0) or time_str)
            
            raw_text = data.get("content", {}).get("text", "") or ""
            elements = data.get("content", {}).get("elements", [])
            
            if not raw_text and elements:
                raw_text = format_elements(elements)
            elif not raw_text:
                continue

            # Identify sender
            is_peer = (sender_uid == peer_uid) or (data.get("sender", {}).get("name", "") == peer_name)
            sender_label = peer_name if is_peer else self_name

            messages.append({
                "ts": ts,
                "time_str": time_str[:19].replace("T", " "),
                "sender": sender_label,
                "text": raw_text
            })
    return messages

def chunk_messages_into_conversations(
    messages: List[Dict[str, Any]],
    split_minutes: int = 30,
    max_msgs: int = 15,
    min_msgs: int = 2
) -> List[Dict[str, Any]]:
    """Group continuous messages into semantic conversation chunks"""
    if not messages:
        return []

    # Sort messages by timestamp
    messages.sort(key=lambda x: x["ts"])

    chunks = []
    current_chunk = []
    last_ts = messages[0]["ts"]

    for msg in messages:
        # Check time gap (session split)
        gap_minutes = (msg["ts"] - last_ts) / 60.0
        
        if (gap_minutes > split_minutes or len(current_chunk) >= max_msgs) and len(current_chunk) >= min_msgs:
            # Seal current chunk
            formatted_text = "\n".join([f"{m['sender']}: {m['text']}" for m in current_chunk])
            time_start = current_chunk[0]["time_str"]
            time_end = current_chunk[-1]["time_str"]
            header = f"[时间: {time_start}]" if time_start == time_end else f"[时间: {time_start} ~ {time_end}]"
            
            chunks.append({
                "chunk_text": f"{header}\n{formatted_text}",
                "start_time": time_start,
                "end_time": time_end,
                "message_count": len(current_chunk),
                "senders": list(set(m["sender"] for m in current_chunk))
            })
            current_chunk = []

        current_chunk.append(msg)
        last_ts = msg["ts"]

    # Flush last chunk
    if len(current_chunk) >= min_msgs:
        formatted_text = "\n".join([f"{m['sender']}: {m['text']}" for m in current_chunk])
        time_start = current_chunk[0]["time_str"]
        time_end = current_chunk[-1]["time_str"]
        header = f"[时间: {time_start}]" if time_start == time_end else f"[时间: {time_start} ~ {time_end}]"
        chunks.append({
            "chunk_text": f"{header}\n{formatted_text}",
            "start_time": time_start,
            "end_time": time_end,
            "message_count": len(current_chunk),
            "senders": list(set(m["sender"] for m in current_chunk))
        })

    return chunks
