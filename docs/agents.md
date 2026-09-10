# Agent 架构说明

## 当前方案：Local Agent（ai-sdk 块协议）

UI 层当前使用 **Local Agent**（`local-agent.ts`）作为唯一的对话后端，基于 ai-sdk 块协议（JSONL Op 流），独立于 ACP 通道。

**保留的 RPC 端点：**
- `diy.agent.local.chat` — 流式对话
- `diy.agent.local.cancel` — 中断生成
- `diy.agent.local.history` — 读取 Op 日志
- `diy.agent.local.clear` — 清空会话
- `diy.agent.local.models` — 可选模型列表
- `diy.agent.local.limits` — 运行限制查询

**对应的前端模块：**
- `localChatStore.ts` — 会话状态管理（按 taskUri 隔离）
- `LocalChatPage.tsx` — 对话页面（密度分级渲染）

## ACP Agent（已从 UI 层移除）

2025-07 从 `pkgs.ts/diy-app` 中移除了 ACP agent 相关代码，原因：
- Local agent 已测试通过，能力可替代 ACP
- ACP 依赖 `@agentclientprotocol/sdk` 和外部 agent 进程（opencode），部署复杂度高
- 暂时不关注 ACP，后续有需要可从 Python 侧或 git history 恢复

**已删除的 TypeScript 文件：**
- `acp-agent-v2.ts` — ACP 客户端（官方 SDK 常驻连接）
- `acp-sessions-v2.ts` — task 级 ACP session 池
- `acp-sessions-persist.ts` — sessionId 持久化到 meta.yaml
- `ChatPage.tsx` — ACP 聊天页面
- `chatStore.ts` — ACP 聊天状态管理
- `agentStore.ts` — ACP agent 全局设置（模型列表/自动审批）

**已清理的 TypeScript 文件：**
- `api-def.ts` — 移除 `diy.agent.chat/chatStream/...` 等 ACP RPC 定义
- `api-impl.ts` — 移除 `getSessionPool()`、`mapConfigOptions()` 及 ACP handler 绑定
- `TaskDetailPanel.tsx` — 移除 🤖 Agent tab
- `App.tsx` — 移除独立聊天导航页

**未动的 Python 代码：** `acp_agent.py`、`agent_manager.py`、`_agent_chat.py` 等保持原样，Python 侧 ACP 能力不受影响。
