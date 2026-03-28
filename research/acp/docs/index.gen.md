---
title: agent acp 协议使用报告
workflow: @dao/research
status: completed
date: 2026-03-24
---

# 报告index

## 调研结论摘要

### 核心发现

1. **分层架构设计**
   - 协议层: ACP-RPC (ndJsonStream via stdin/stdout)
   - 能力层: 握手阶段声明 Agent/Client 能力
   - 业务层: CodingAgent 接口抽象

2. **四大核心模块**
   - 连接管理: `acp.ndJsonStream()` + `acp.ClientSideConnection`
   - 认证: `initialize()` + `authenticate()` 握手
   - 会话: `newSession()` 支持 cwd/MCP 配置
   - 文件系统: `AcpFileSystemService` 桥接客户端 FS

3. **dao-core 集成方案**
   - `AcpClientAdapter`: 通用 ACP 适配器类
   - 映射 ACP 事件到 `AgentStreamEvent[]`
   - 回调映射: `requestPermission` → TUI prompt

### 实现状态

- [x] 在 dao-core 中实现 `AcpClientAdapter` 基础框架
  - 文件: `packages/dao-core/src/acp-adapter.ts`
  - 导出: `AcpClientAdapter`, `AcpAdapterOptions`
- [ ] 测试 `gemini --acp` 接入
- [ ] 实现 TUI 权限确认流程
- [ ] 支持 MCP 服务器配置

详见: 
- [gemini-cli acp](./gemini-acp.md)
