# 腾讯云 TokenHub — 参考文档

## 价格
- **模型价格（官方）：** https://cloud.tencent.com/document/product/1823/130055
- 最近更新时间：2026-06-13
- 计价单位：元/百万 tokens（人民币）

### 当前已配置模型价格

| 模型 | 输入 | 缓存命中 | 输出 |
|---|---|---|---|
| DeepSeek V4 Flash | 1 | 0.2 | 2 |
| DeepSeek V4 Pro | 3 | 0.025 | 6 |
| DeepSeek R1 | — | — | — |

> `—` 表示尚未在 TokenHub 控制台确认价格，目前沿用 DeepSeek 官方 USD 价。

## API
- **调用指南：** https://cloud.tencent.com/document/product/1823/129603
- **模型列表：** https://cloud.tencent.com/document/product/1823/129605
- 协议：OpenAI 兼容（`/v1/chat/completions`）
- 认证：`Authorization: Bearer <api_key>`
