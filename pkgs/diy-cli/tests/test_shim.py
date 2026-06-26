import requests

def test_shim():
    url = "http://127.0.0.1:8000/v1/chat/completions"
    payload = {
        "model": "gemini-2.0-flash",
        "messages": [{"role": "user", "content": "你好，这是一次测试。"}]
    }
    try:
        response = requests.post(url, json=payload)
        print(f"Status: {response.status_code}")
        print(f"Response: {response.json()}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_shim()
