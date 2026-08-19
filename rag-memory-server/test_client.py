import requests
import json

BASE_URL = "http://127.0.0.1:8765"

def test_server():
    print("1. 检查服务器状态...")
    try:
        r = requests.get(f"{BASE_URL}/")
        print("   状态:", r.json())
    except Exception as e:
        print("   无法连接服务器，请先运行 run.bat 启动服务！错误:", e)
        return

    print("\n2. 测试检索记忆接口 (/api/memory/search)...")
    payload = {
        "query": "你还记得去年我们在哪个机房弄服务器吗？",
        "top_k": 2,
        "score_threshold": 0.3
    }
    r = requests.post(f"{BASE_URL}/api/memory/search", json=payload)
    print("   返回结果:", json.dumps(r.json(), ensure_ascii=False, indent=2))

    print("\n3. 测试一站式对话接口 (/api/chat/complete)...")
    chat_payload = {
        "message": "老婆，我今天好累呀",
        "enable_memory": True
    }
    r = requests.post(f"{BASE_URL}/api/chat/complete", json=chat_payload)
    print("   AI 回复:", json.dumps(r.json(), ensure_ascii=False, indent=2))

if __name__ == "__main__":
    test_server()
