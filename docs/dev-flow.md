---
title: 开发规范
tags: [dao, 开发]
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
│   ├── dao-feature-auth/
│   ├── dao-bug-xxx/
│   └── ...
├── src/
└── README.md
```

**守则：**
- ⚠️ **禁止** 直接在 main 分支进行修改
- ✅ 合并前确保测试通过

## 纯local工作流 + 自定义脚本 (Local Standard Workflow)

[ ] TODO 纯local工作流 + 自定义脚本 (Local Standard Workflow)

1. **创建 worktree** - 在主分支（main）上执行，创建新的特性分支和 worktree：
```bash
# 确保 main 是最新的
./sha.sh work new
# 脚本内主要工作：
# git checkout main
# git pull origin main
# 创建特性分支并在 .worktree/ 目录添加 worktree
# git worktree add .worktree/dao-feature-<name> -b dao-feature-<name>
# 例：git worktree add .worktree/dao-feature-auth -b dao-feature-auth
# 例：git worktree add .worktree/dao-bug-xxx -b dao-bug-xxx
```

新worktree分支创建后首先同步各项资源:
```bash
# npm install , .dao/ref sync , gitmodule sync ...
cd .worktree/dao-feature-<name>
./sha.sh sync all
```


## github工作流 + 自定义脚本 (Github Standard Workflow)

本项目使用 **GitHub Project + gh CLI** 作为任务看板，配合自定义脚本实现全命令行开发工作流。

**前提条件：**
- 已安装 GitHub CLI (`gh`)
- 已认证并添加 `project` 权限：`gh auth refresh -s project`
- 项目看板地址：https://github.com/users/chen56/projects/13

**完整流程**（从创建任务到合并）：

### 1. 创建新任务

在 GitHub 创建 issue 并自动添加到项目看板，同时创建本地分支：

```bash
# 在 main 分支执行
./sha.sh work new <branch-name> "问题描述"

# 示例
./sha.sh work new feature/add-work-commands "在 sha.sh 新增 work 命令集"
```

该命令会自动：
1. 在 `whonb/dao` 创建新 issue
2. 将 issue 添加到 project 13
3. 创建并切换到你指定的分支

### 2. 领取任务

如果 issue 已经创建，在开始开发前领取任务，移动状态到 `In Progress`：

```bash
./sha.sh work accept <issue-number>

# 示例
./sha.sh work accept 42
```

### 3. 开发

在当前分支进行开发，遵循 [CLAUDE.md](../CLAUDE.md) 验证规范：

```bash
# 开发完成后验证
npm run check
# 或
npm run test
```

### 4. 提交并创建 PR

```bash
# 提交变更
git add .
git commit -m "feat: 实现xxx (close #<issue-number>)"
git push -u origin <branch-name>

# 创建 PR
gh pr create --base main --head <branch-name> \
  --title "feat: 你的功能标题" \
  --body "Closes #<issue-number>"
```

### 5. 合并并移动到 Done

```bash
# 合并 PR
gh pr merge <pr-number> --squash

# 切回 main 拉取最新
git checkout main
git pull

# 清理本地分支
git branch -d <branch-name>
```

在 GitHub 上 PR 合并后会自动关闭 issue，你可以手动在看板上标记为 Done：

```bash
# 如果需要手动更新：获取 item ID 然后编辑状态
./sha.sh work list  # 得到 item ID
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "Done"
```

### 常用命令速查

| 命令 | 功能 |
|------|------|
| `./sha.sh work new <branch> "desc"` | 创建新任务 + 分支 |
| `./sha.sh work accept <issue-num>` | 领取任务 → In Progress |
| `./sha.sh work list` | 列出所有**未完成**任务 |
| `gh project item-list 13 --owner chen56` | 列出项目所有 items |

### 多仓库关联

GitHub Project V2 支持关联多个仓库，所有关联仓库新建的 issue/PR 会自动同步：

```bash
# 关联新仓库
gh project link 13 --owner chen56 --repo owner/repo-name

# 取消关联
gh project unlink 13 --owner chen56 --repo owner/repo-name
```

> 注意：当前 gh CLI 没有内置命令查看已关联仓库，需要到 GitHub Web UI 查看。


## 纯local工作流+纯 Git 命令（Local + Pure git command Workflow)

纯 Git 命令操作最为核心逻辑示范，所有 worktree 都放在项目内的 `.worktree/` 目录下：

**开发流程：**

1. **创建 worktree** - 在主分支（main）上执行，创建新的特性分支和 worktree：
```bash
# 确保 main 是最新的
git checkout main
git pull origin main

# 创建特性分支并在 .worktree/ 目录添加 worktree
git worktree add .worktree/dao-feature-<name> -b dao-feature-<name>
# 例：git worktree add .worktree/dao-feature-auth -b dao-feature-auth
# 例：git worktree add .worktree/dao-bug-xxx -b dao-bug-xxx
```

2. **进入 worktree 开发**：
```bash
cd .worktree/dao-feature-<name>
# 进行开发、测试、提交
git commit -m "..."
```

3. **跟进 main 分支的更新**（开发过程中）：
```bash
# 在特性 worktree 中执行
git rebase main
# 或者如果你喜欢合并：git merge main
```

4. **合并回 main 分支**（开发完成后）：
```bash
# 回到项目根目录（main 分支）
cd ../.. # 或者直接 cd 到项目根
git checkout main
git pull origin main

# 合并特性分支, --no-ff 保commit log 原始阵型
git merge --no-ff dao-feature-<name>

# 推送到远端
git push origin main

# 清理：删除 worktree 和分支
git worktree remove .worktree/dao-feature-<name>
git branch -d dao-feature-<name>
```

**常用命令：**
```bash
# 查看所有 worktree 状态
git worktree list

# 清理失效的 worktree 条目
git worktree prune
```


这种方式的优点：
- ✅ 纯 Git 原生命令，无需脚本
- ✅ 所有 worktree 集中在 `.worktree/` 目录，便于管理
- ✅ 根目录始终是 main 分支，符合直觉
- ✅ 符合本项目的隔离开发原则

## github工作流+纯 Git 命令（Github + Pure git command Workflow)

如果不使用自动化脚本，可以手动执行完整流程，基于 GitHub Project + 纯 Git worktree：

**项目配置：**
- Owner: `chen56`
- Project #: `13`
- Project ID: `PVT_kwHOAB8fvs4BTGD4`

**完整手动流程：**

### 1. 创建 Issue 并添加到项目

```bash
# 在 main 分支，确保最新
git checkout main
git pull origin main

# 创建 issue，并添加到 project
gh issue create --title "实现功能: xxx" --body "详细描述" --label "feature" --project 13
```

输出会得到 issue 编号和 URL，记下 issue 编号和 item ID。

### 2. 创建 worktree

```bash
# 创建特性分支和 worktree
# 分支命名建议带上 issue 编号: dao-<num>-description
git worktree add .worktree/dao-<num>-description -b dao-<num>-description
```

### 3. 进入 worktree 开发

```bash
cd .worktree/dao-<num>-description
# 同步依赖
./sha.sh sync all
```

领取任务，移动到 `In Progress`：

```bash
# 需要先找到 item ID
gh project item-list 13 --owner chen56

# 移动状态
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "In Progress"
```

### 4. 开发、验证、提交

```bash
# 开发完成验证
npm run check

# 提交
git add .
git commit -m "feat: implement xxx (close #<issue-num>)"
git push -u origin dao-<num>-description
```

### 5. 创建 PR 并合并

```bash
# 创建 PR
gh pr create --base main --head dao-<num>-description \
  --title "feat: xxx" --body "Closes #<issue-num>"

# 审查通过后合并
gh pr merge <pr-num> --squash
```

### 6. 清理

```bash
# 回到主目录 main 分支
cd ../..
git checkout main
git pull

# 删除 worktree 和分支
git worktree remove .worktree/dao-<num>-description
git branch -d dao-<num>-description
```

### 状态移动速查表

| 起点 → 终点 | 命令选项 |
|------------|----------|
| Backlog → Ready | `--option "Ready"` |
| Ready → In Progress | `--option "In Progress"` |
| In Progress → In Review | `--option "In Review"` |
| In Review → Done | `--option "Done"` |

## GitHub 数据结构参考 (Field Reference)

在编写自动化脚本（如 `sha.sh` 或 TypeScript 工具）时，可以参考以下 `gh` CLI 输出的 JSON 结构。

### 1. Project Item (项目看板条目)
命令：`gh project item-list 13 --owner chen56 --format json`

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
        "repository": "whonb/dao",
        "title": "feat: xxx",
        "url": "https://github.com/whonb/dao/issues/8"
      },
      "module": "dev-flow",   // 自定义字段
      "priority": "P2",       // 自定义字段
      "repository": "https://github.com/whonb/dao"
    }
  ]
}
```

### 2. Issue (议题)
命令：`gh issue view <num> --json number,title,body,labels,state,url`

```json
{
  "number": 8,
  "title": "feat: xxx",
  "state": "OPEN",
  "url": "https://github.com/whonb/dao/issues/8",
  "labels": [],
  "assignees": [],
  "author": { "login": "chen56", "name": "Chen Peng" }
}
```

### 3. Pull Request (拉取请求)
命令：`gh pr view <num> --json number,title,state,headRefName,baseRefName,mergeable`

```json
{
  "number": 2,
  "title": "Add agentic workflow",
  "state": "MERGED",
  "headRefName": "feature-branch",
  "baseRefName": "main",
  "mergeable": "UNKNOWN",
  "url": "https://github.com/whonb/dao/pull/2"
}
```

### 4. 项目自定义字段 (Custom Fields)
项目 ID: `PVT_kwHOAB8fvs4BTGD4` (number 13)

| 字段名 | 类型 | 选项 (Options) |
|--------|------|--------------|
| **Status** | Single Select | Backlog, Ready, In progress, In review, Closed |
| **Priority**| Single Select | P0, P1, P2, P3 |
| **Size**     | Single Select | XS, S, M, L, XL |
| **Module**   | Single Select | sources, dao-tui, acp, cli, tui, dev-flow |
| **Resolution**| Single Select | Duplicate, Wontfix, Invalid |
| **Estimate** | Number | - |
| **Start date**| Date | - |
| **Target date**| Date | - |
