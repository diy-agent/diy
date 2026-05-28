---
name: diy-project-manager
description: >
  GitHub Project issue 组织与管理规范。在创建、编辑、归类 issue 时自动触发。
  核心原则：Issue 是短生命周期工作项，长期目标用 Goal 字段表达，不用父 issue 做容器。
  触发词：创建 issue、新建问题、issue 归类、project 管理、任务组织、添加子问题、
  设置父 issue、issue 分类、backlog 整理、sprint 规划、Goal 分类。
---

# diy-project-manager

GitHub Project 的 issue 组织规范，解决"树形层级 vs 多维切片"的认知冲突。

## 核心心智模型：三层分离

```
docs/goals/*.md          ← 语义层（长期愿景，活文档）
Project fields/views     ← 查询层（Goal/Module/Priority 多维切片）
Issues/PRs               ← 执行层（可完成的具体工作）
```

**关键原则：不要让"长期概念"变成"会关闭的 issue"。**

Issue 天生是 ephemeral（短生命周期），Goal 是 persistent semantic object（长期语义对象）。
把目标写成 issue 会导致：目标被污染、被关闭、出现在 sprint 里、和真实任务混杂。

## 写操作前必须备份

GitHub Projects 没有版本历史，字段删除和值覆盖不可逆。任何写操作前必须先快照。

**备份目录**: `.diy/data/diy-project-manager/`

**备份规则**:
- 批量修改字段值 → 导出整个 project 的 item 列表
- 修改单个 issue → 只导出该 issue
- 删除字段/选项 → 导出整个 project 含字段定义

**备份命令**:

```bash
# 批量操作前：导出整个 project
mkdir -p .diy/data/diy-project-manager
gh project item-list 3 --owner diy-agent --limit 100 --format json \
  > ".diy/data/diy-project-manager/project3-$(date +%Y%m%d-%H%M%S).json"

# 单 issue 操作前：只导出该 issue
gh issue view <number> --repo diy-agent/diy --json number,title,body,labels,state \
  > ".diy/data/diy-project-manager/issue-<number>-$(date +%Y%m%d-%H%M%S).json"
```

**备份文件命名**: `{project3|issue-N}-{YYYYMMDD-HHMMSS}.json`

**恢复方式**: 读取备份 JSON，用 `gh project item-edit` 或 `gh issue edit` 逐条还原。

## 字段体系

| 字段 | 语义 | 示例 | 用途 |
|------|------|------|------|
| **Goal** | 长期战略意图（带描述） | 开发流优化、TUI/面板框架、CLI 体验、基础设施 | 替代"目标 issue"，不会关闭，每个选项有 30-50 字描述，用于分组/切片 |
| **Module** | 技术域/代码位置 | diy-cli、diydev、diyui.py、diy/ref | 定位改动范围 |
| **Priority** | 紧急程度 | P0-P3 | 排序 |
| **Status** | 生命周期 | Backlog → Ready → In progress → Done | 进度追踪 |
| **Size** | 工作量估算 | XS/S/M/L/XL | 规划 |

## 创建 Issue 检查清单

1. **这是工作项还是目标？** 如果是长期存在的方向/愿景，不要建 issue，写入 `docs/goals/` 或加 Goal 选项
2. **填写 Goal** — 每个 issue 必须属于一个 Goal（战略意图），没有合适的就新增选项（附 30-50 字描述）
3. **填写 Module** — 明确改动范围
4. **填写 Priority** — Backlog 的 issue 也要有优先级
5. **body 写清楚** — 包含：问题描述、期望行为、相关上下文

## Parent-Child 使用规则

**只用 parent-child 做真正的 work breakdown（工作分解）**，即：
- 父 issue 是可完成的、有明确交付物的
- 子 issue 是父 issue 的具体实现步骤
- 生命周期短（一个 sprint 内完成）

**不要用 parent-child 做：**
- 长期目标容器（用 Goal 字段）
- 知识分类/认知地图（用字段切片）
- 跨领域归类（一个 issue 只能有一个 parent，会毁掉知识结构）

**判断标准：** 如果父 issue 永远不会被 close，它就不该是 issue。

## 依赖关系

用 issue body 里的链接表达依赖，比 sub-issue 更灵活：

```markdown
Depends on #92
Blocks #95
Related: #8
```

这样依赖是图结构（多对多），而不是树结构（单继承）。

## 维护检查清单

定期执行：

- [ ] 新 issue 是否填写了 Goal/Module/Priority？
- [ ] 是否有 issue 被当作"长期目标"使用？（检查长期不关闭的 parent issue）
- [ ] Goal 选项是否需要新增？（新战略方向出现时，附 30-50 字描述）
- [ ] 重复 issue 是否合并或关闭？
- [ ] Done 的 issue 是否真的完成了？

## 视图建议

| 视图 | 分组 | 用途 |
|------|------|------|
| 默认 | Goal 分组 | 按战略方向看全局 |
| Sprint | Status 过滤 + Priority 排序 | 当前迭代规划 |
| 模块视角 | Module 分组 | 按技术域看改动 |
| 待办清理 | Status=Backlog + Priority 排序 | 定期清理 backlog |

## 反模式

| 反模式 | 问题 | 正确做法 |
|--------|------|----------|
| 用 parent issue 做目标容器 | slice/filter 失效，跨领域 issue 跳跃 | 用 Goal 字段 |
| issue 永远不关闭 | 目标混入执行层 | 转为 goal 文档或 Goal 选项 |
| 所有 issue 挂同一个 parent | 树退化为列表，失去结构意义 | 扁平化 + 字段切片 |
| 依赖用 sub-issue 表达 | 僵硬，只能单继承 | body 里写 `Depends on #N` |
| Goal 选项没有描述 | 意图模糊，后续 issue 归类困难 | 新增选项时必写 30-50 字描述 |
