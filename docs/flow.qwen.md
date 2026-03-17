# 多 Agent 开发流程 (Multi-Agent Development Flow)

本文档描述了 DAO 项目中多 Agent 协作的完整开发流程，包括计划、Worktree 开发、审核、提交和合并回 main 等关键阶段。

## 状态图 (State Diagram)

```mermaid
stateDiagram-v2
    [*] --> Idle: 系统初始化

    state Planning {
        Idle --> Analyzing: 接收用户目标
        Analyzing --> Researching: 分析任务需求
        Researching --> PlanCreating: 查阅相关资料
        PlanCreating --> PlanReviewing: 制定开发计划
        PlanReviewing --> PlanApproved: 用户确认计划
        PlanReviewing --> Analyzing: 计划需调整
    }

    state Development {
        PlanApproved --> WorktreeCreating: 创建开发分支
        WorktreeCreating --> Coding: Worktree 准备就绪
        Coding --> SelfChecking: 完成代码编写
        SelfChecking --> Testing: 自检通过
        SelfChecking --> Coding: 自检失败
        Testing --> DocUpdating: 测试通过
        Testing --> Coding: 测试失败
    }

    state Review {
        DocUpdating --> PRCreating: 文档已更新
        PRCreating --> AwaitingReview: 创建 PR 请求
        AwaitingReview --> Reviewing: Agent 审核开始
        Reviewing --> ReviewPassed: 审核通过
        Reviewing --> AwaitingReview: 需修改
        ReviewPassed --> Merging: 准备合并
    }

    state Integration {
        Merging --> CI_Running: 合并到 main
        CI_Running --> Deploying: CI 通过
        CI_Running --> Merging: CI 失败需修复
        Deploying --> Monitoring: 部署完成
        Monitoring --> Idle: 监控正常
        Monitoring --> Analyzing: 发现新问题
    }

    %% 异常流程
    state Exception {
        Coding --> Blocked: 遇到技术卡点
        Blocked --> SelfCorrecting: 启动自救循环
        SelfCorrecting --> Researching: 查阅资料/试验
        SelfCorrecting --> Blocked: 问题未解决
    }

    %% 状态注释
    note right of Analyzing
        理解用户目标
        搜索相关代码
        识别关键约束
    end note

    note right of PlanCreating
        制定 TODO 列表
        评估技术风险
        确定验证方案
    end note

    note right of Coding
        实验室模式试验
        精准修改代码
        遵循项目规范
    end note

    note right of Reviewing
        代码质量检查
        类型验证
        测试覆盖率
    end note

    note right of CI_Running
        类型检查
        Lint 检查
        单元测试
        集成测试
    end note
```

## 流程图 (Flowchart)

```mermaid
flowchart TB
    subgraph S1[📋 计划阶段 Planning]
        A([开始 Start]) --> B[接收用户目标]
        B --> C{任务复杂度}
        C -->|简单 | D[直接制定计划]
        C -->|复杂 | E[深度研究分析]
        E --> F[查阅项目代码]
        F --> G[查阅依赖源码 .dao/ref]
        G --> H[必要时网上调研]
        H --> D
        D --> I[创建 TODO 列表]
        I --> J[用户确认计划]
        J -->|❌ 需调整 | D
        J -->|✅ 确认 | K([计划完成])
    end

    subgraph S2[🔧 开发阶段 Development]
        K --> L[创建 Git Worktree]
        L --> M[切换 ESM 环境检查]
        M --> N{是否需要试验？}
        N -->|是 | O[temp 目录建立最小案例]
        O --> P[验证技术方案]
        P -->|失败 | O
        P -->|成功 | Q
        N -->|否 | Q[精准修改代码]
        Q --> R[自检代码质量]
        R -->|❌ 有问题 | Q
        R -->|✅ 通过 | S[运行类型检查]
        S -->|❌ TS 错误 | Q
        S -->|✅ 通过 | T[运行测试用例]
        T -->|❌ 测试失败 | Q
        T -->|✅ 通过 | U[更新文档/注释]
        U --> V([开发完成])
    end

    subgraph S3[👀 审核阶段 Review]
        V --> W[创建 Pull Request]
        W --> X[自动触发 CI]
        X --> Y{Agent 审核}
        Y -->|❌ 需修改 | Z[生成修改建议]
        Z --> Q
        Y -->|✅ 通过 | AA[批准合并]
        AA --> AB([审核完成])
    end

    subgraph S4[🔗 合并阶段 Integration]
        AB --> AC[合并到 main 分支]
        AC --> AD{CI 验证}
        AD -->|❌ 失败 | AE[回滚并通知]
        AE --> Q
        AD -->|✅ 通过 | AF[部署到生产]
        AF --> AG[监控运行状态]
        AG --> AH{是否稳定？}
        AH -->|❌ 异常 | AI[创建修复任务]
        AI --> B
        AH -->|✅ 稳定 | AJ([流程结束])
    end

    subgraph S5[🆘 异常处理 Exception Handling]
        Q --> AK{遇到卡点？}
        AK -->|是 | AL[启动自救循环]
        AL --> AM[搜索项目类似实现]
        AM --> AN[查阅 .dao/ref 依赖源码]
        AN --> AO[回到 temp 试验]
        AO --> AP{问题解决？}
        AP -->|否 | AM
        AP -->|是 | Q
        AK -->|否 | R
    end

    %% 样式定义
    style S1 fill:#e1f5ff,stroke:#0077b6
    style S2 fill:#fff4e1,stroke:#f77f00
    style S3 fill:#e1ffe1,stroke:#2d6a4f
    style S4 fill:#f0e1ff,stroke:#5a189a
    style S5 fill:#ffe1e1,stroke:#c1121f

    %% 连接样式
    linkStyle default stroke:#333,stroke-width:2px
```

## 关键节点说明 (Key Nodes Description)

### 1. 计划阶段 (Planning)

| 节点 | 职责 | 输出物 |
|------|------|--------|
| 接收用户目标 | 理解用户需求，识别核心目标 | 需求摘要 |
| 深度研究分析 | 分析技术可行性，识别风险点 | 风险评估报告 |
| 查阅相关资料 | 按优先级查阅：项目代码 → .dao/ref → node_modules → 网络 | 参考资料列表 |
| 创建 TODO 列表 | 拆解任务为可执行步骤 | TODO 列表 (todo_write) |
| 用户确认计划 | 与用户对齐预期，获取授权 | 用户确认记录 |

### 2. 开发阶段 (Development)

| 节点 | 职责 | 强制规范 |
|------|------|----------|
| 创建 Git Worktree | 隔离开发环境，避免污染主分支 | 分支命名规范 |
| ESM 环境检查 | 确认 package.json type: module | 模块系统验证 |
| 实验室模式 | 在 temp 目录试验，验证方案 | 最小可验证案例 |
| 精准修改代码 | 使用 replace 工具，避免大改 | 禁止 // ... rest of code |
| 自检代码质量 | 检查代码规范、逻辑完整性 | 自检清单 |
| 运行类型检查 | npx tsc --noEmit 或项目 check 脚本 | TS 验证通过 |
| 运行测试用例 | npm run test 或项目测试命令 | 测试覆盖率报告 |
| 更新文档/注释 | 同步更新相关文档和代码注释 | 文档变更记录 |

### 3. 审核阶段 (Review)

| 节点 | 检查项 | 通过标准 |
|------|--------|----------|
| 创建 Pull Request | 描述变更内容、关联 Issue | PR 模板完整 |
| 自动触发 CI | 类型检查、Lint、测试 | 全部绿色通过 |
| Agent 审核 | 代码质量、架构一致性、性能影响 | 审核清单通过 |
| 批准合并 | 确认无遗留问题 | 至少 1 个 Agent 批准 |

### 4. 合并阶段 (Integration)

| 节点 | 职责 | 回滚策略 |
|------|------|----------|
| 合并到 main | 执行 git merge/rebase | 保留完整历史 |
| CI 验证 | 最终集成测试 | 失败自动回滚 |
| 部署到生产 | 发布新版本/更新服务 | 灰度发布策略 |
| 监控运行状态 | 观察日志、指标、错误率 | 实时告警机制 |

### 5. 异常处理 (Exception Handling)

| 场景 | 响应动作 | 升级路径 |
|------|----------|----------|
| 技术卡点 | 启动自救循环 | 搜索 → 查阅 → 试验 |
| CI 失败 | 分析错误日志，定位问题 | 回滚 → 修复 → 重跑 |
| 测试失败 | 补充/修复测试用例 | 本地复现 → 修复 → 验证 |
| 类型错误 | 修正类型定义，禁止 as any | 查阅类型定义 → 修正 |
| 用户否定 | 重新理解需求，调整计划 | 沟通确认 → 重新规划 |

## 护栏与约束 (Guardrails & Constraints)

### 文件编辑约束

```json
{
  "protected_paths": [
    "config/evolution.json",
    "AGENTS.md",
    "package.json"
  ],
  "allowed_edit_roots": [
    "src/",
    "packages/",
    "tests/",
    "docs/",
    "temp/"
  ]
}
```

### 验证规范

1. **无验证，不交付**: 所有代码修改必须紧跟类型检查
2. **禁止 `as any`**: 除非用户明确授权
3. **最小化修改**: 每轮进化只包含最小可验证改动
4. **可观测性优先**: 优先增加日志、心跳或其他可观测手段

## 版本历史 (Version History)

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 1.0.0 | 2026-03-17 | 初始版本，定义完整多 Agent 开发流程 |
