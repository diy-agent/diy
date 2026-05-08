---
title: 开发规范
tags: [xx, 开发]
category: 开发
description: 开发流程、规范
draft: false
---
# 开发规范

## 规则

本项目采用 **Worktree 隔离开发模式**，主分支 (main) 保持稳定，不直接修改。

**项目布局：**
```
project-root/        # 项目根目录，main 分支（主工作树）
├── .git/
├── .worktree/       # 所有特性 worktree 都放在这里
│   ├── 42-hot-reload/
│   ├── 43-fix-xxx/
│   └── ...
├── src/
└── README.md
```

**守则：**
- ⚠️ **禁止** 直接在 main 分支进行修改
- ✅ 合并前确保测试通过

## GitHub 工作流

基于 **GitHub Project + gh CLI + sha.sh 脚本** 的全命令行开发工作流。

**前提条件：**
- 已安装 GitHub CLI (`gh`)
- 已认证：`gh auth refresh -s project`
- 项目看板：https://github.com/users/chen56/projects/13

**流程总览：**

```
issue new → issue dev → (开发) → dev pr → (合并) → 清理 worktree
  Backlog    In progress            In review              Done
```

### 1. 创建新任务

```bash
./sha.sh issue new <问题描述>
# 示例
./sha.sh issue new "支持插件热加载"
```

实际执行：
```bash
gh issue create --repo xx-agent/xx --title "支持插件热加载" --body "支持插件热加载"
# 提取 issue 编号 N
gh project item-add --owner chen56 13 --url https://github.com/xx-agent/xx/issues/N
# → Project Status: Backlog
```

### 2. 开始开发

```bash
./sha.sh issue dev <编号> [分支名]
# 示例
./sha.sh issue dev 42 hot-reload   # 分支: 42-hot-reload
./sha.sh issue dev 42              # 分支: 42
```

实际执行：
```bash
# 1. Project Status → In progress (自动解析 item_id → field_id → option_id) "Status" "In progress"
gh project item-edit --id <ITEM_ID:42> --project-id <PORJECT_ID> --field-id <FIELD_ID:> --single-select-option-id <OPTION_ID:In progress>

# 2. 创建 worktree + 推送远端
git worktree add -b 42-hot-reload .worktree/42-hot-reload main
git push -u origin 42-hot-reload
```

进入 worktree 开发：
```bash
cd .worktree/42-hot-reload
./sha.sh sync all   # npm install + submodule + .xx/ref 同步
# ... 编码、提交 ...
```

### 3. 查看状态

```bash
# 所有 worktree 总览（分支/PR/Project状态/ahead数）
./sha.sh dev list
# 输出: Path | Branch | Ahead | PR | PR State | Project Status

# 当前分支详情（Git/Issue/PR/Project）
./sha.sh dev status
```

### 4. 提交 PR

```bash
./sha.sh dev pr
```

实际执行：
```bash
# 从分支名提取 issue 编号 (格式: {N}-xxx / issue-{N} / {N})
gh issue view 42 --repo xx-agent/xx --json title -q .title   # → PR 标题
git push origin 42-hot-reload
# 已有 open PR 则跳过，否则：
gh pr create --repo xx-agent/xx --base main --head 42-hot-reload --title "<issue标题>" --body "Complete #42"
# → Project 自动化: Status → In review
```

### 5. 合并 PR

```bash
./sha.sh dev merge_pr
```

实际执行（自动从当前分支查找 open PR）：
```bash
gh pr merge <pr-number> --repo xx-agent/xx --squash
```

### 6. 清理 worktree

```bash
./sha.sh dev remove
```

实际执行：
```bash
git checkout main && git pull
git worktree remove .worktree/<branch>
git branch -d <branch>
```

> ⚠️ 以上两个命令必须在 worktree 子目录中执行，在主分支执行会报错。

### 命令速查

| 命令 | 功能 |
|------|------|
| `./sha.sh issue new "描述"` | 创建 Issue → Project (Backlog) |
| `./sha.sh issue dev <编号> [名称]` | 开始开发 → In progress + worktree |
| `./sha.sh issue list` | 列出所有未完成任务 |
| `./sha.sh dev list` | 查看所有 worktree 状态总览 |
| `./sha.sh dev status` | 当前分支详情（Issue/PR/Project） |
| `./sha.sh dev pr` | 推送 + 创建 PR → In review |
| `./sha.sh dev merge_pr` | Squash merge 当前分支的 PR |
| `./sha.sh dev remove` | 切回 main + 清理当前 worktree 和分支 |

### 多仓库关联

```bash
gh project link 13 --owner chen56 --repo owner/repo-name     # 关联
gh project unlink 13 --owner chen56 --repo owner/repo-name   # 取消关联
```

> 注意：查看已关联仓库需到 GitHub Web UI。

## GitHub 数据结构参考

### 1. Project Item
`gh project item-list 13 --owner chen56 --format json`

```json
{
  "items": [
    {
      "id": "PVTI_...",
      "status": "In progress",
      "title": "feat: xxx",
      "content": {
        "type": "Issue",
        "number": 8,
        "repository": "xx-agent/xx",
        "title": "feat: xxx",
        "url": "https://github.com/xx-agent/xx/issues/8"
      },
      "module": "dev-flow",
      "priority": "P2",
      "repository": "https://github.com/xx-agent/xx"
    }
  ]
}
```

### 2. Issue
`gh issue view <num> --json number,title,body,labels,state,url`

```json
{
  "number": 8,
  "title": "feat: xxx",
  "state": "OPEN",
  "url": "https://github.com/xx-agent/xx/issues/8",
  "labels": [],
  "assignees": [],
  "author": { "login": "chen56", "name": "Chen Peng" }
}
```

### 3. Pull Request
`gh pr view <num> --json number,title,state,headRefName,baseRefName,mergeable`

```json
{
  "number": 2,
  "title": "Add agentic workflow",
  "state": "MERGED",
  "headRefName": "feature-branch",
  "baseRefName": "main",
  "mergeable": "UNKNOWN",
  "url": "https://github.com/xx-agent/xx/pull/2"
}
```

### 4. 项目自定义字段

项目 ID: `PVT_kwHOAB8fvs4BTGD4` (number 13)

| 字段名 | 类型 | 选项 |
|--------|------|------|
| **Status** | Single Select | Backlog, Ready, In progress, In review, Closed |
| **Priority** | Single Select | P0, P1, P2, P3 |
| **Size** | Single Select | XS, S, M, L, XL |
| **Module** | Single Select | sources, xx-tui, acp, cli, tui, dev-flow |
| **Resolution** | Single Select | Duplicate, Wontfix, Invalid |
| **Estimate** | Number | - |
| **Start date** | Date | - |
| **Target date** | Date | - |
