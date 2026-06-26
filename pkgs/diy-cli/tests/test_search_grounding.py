import os
import google.generativeai as genai
import sys

# 检查是否配置了 API Key
# 注意：在 diy 环境中，密钥应由 diy 框架管理，这里尝试读取环境变量
api_key = os.environ.get("GOOGLE_API_KEY")
if not api_key:
    print("错误: 环境变量 GOOGLE_API_KEY 未设置。")
    print("请确认是否通过 `diy llm auth set google --key ...` 配置，并确保其在当前 shell 可用。")
    sys.exit(1)

genai.configure(api_key=api_key)

# 启用 Google 搜索工具
tools = [{"google_search_retrieval": {}}]

# 初始化支持 Tool Calling 的模型
model = genai.GenerativeModel(
    model_name="gemini-2.0-flash",
    tools=tools
)

query = "今天比特币的价格是多少？"
print(f"提问: {query}")

try:
    response = model.generate_content(query)

    print("\n--- 回答 ---")
    print(response.text)

    # 检查引用来源 (Grounding Metadata)
    if response.candidates and response.candidates[0].grounding_metadata:
        metadata = response.candidates[0].grounding_metadata
        print("\n--- 来源信息 ---")
        if metadata.grounding_chunks:
            print(f"引用了 {len(metadata.grounding_chunks)} 个来源。")
            # 打印第一个来源的标题
            if metadata.grounding_chunks[0].web.title:
                print(f"首个来源标题: {metadata.grounding_chunks[0].web.title}")
    else:
        print("\n注意: 未检测到 Grounding 引用信息（模型可能未触发工具调用）。")

except Exception as e:
    print(f"\n执行出错: {e}")
