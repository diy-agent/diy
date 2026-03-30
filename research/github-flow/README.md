# GitHub Project + gh CLI 开发工作流

本仓库使用 GitHub Project 作为看板项目管理工具，配合 gh CLI 实现全命令行开发工作流。

## 项目信息

- **Owner**: `chen56`
- **Project**: `dao` (编号 **13**)
- **Project ID**: `PVT_kwHOAB8fvs4BTGD4`
- **Repositories**:
  - `whonb/dao` - 主仓库 monorepo
  - `chen56/sha` - 辅助工具仓库
- **看板结构**: 标准 GitHub 看板模板，包含 `Status` 单选项字段

## 完整开发工作流

### 1. 创建新任务 (新建 Issue 添加到 Backlog)

```bash
# 创建新 issue 并自动添加到 project 13
gh issue create --title "实现功能: xxx" --body "详细描述需要做什么" --label "feature" --project 13
```

输出会返回 issue 编号和 item ID，记录下来。

### 2. 查看所有任务获取 Item ID

```bash
gh project item-list 13 --owner chen56
```

输出格式：
```
Issue  [标题]  [编号]  whonb/dao  [ITEM-ID]
```

### 3. 规划：从 Backlog 移动到 Ready

```bash
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "Ready"
```

### 4. 开始开发：移动到 In Progress

```bash
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "In Progress"
```

### 5. 创建功能分支开发

```bash
# 从 main 拉取最新
git checkout main
git pull

# 创建功能分支 (建议带上 issue 编号)
git checkout -b feature/dao-[issue-num]-xxx-feature

# 开发完成后验证 (遵循 CLAUDE.md)
npm run check
# 或
npm run test

# 提交推送
git add .
git commit -m "feat: implement xxx (close #[issue-num])"
git push -u origin feature/dao-[issue-num]-xxx-feature
```

### 6. 创建 Pull Request，移动到 In Review

```bash
# 创建 PR
gh pr create --base main --head feature/dao-[issue-num]-xxx-feature \
  --title "feat: 实现 xxx 功能" \
  --body "Closes #[issue-num]"

# 获取 PR 编号后，将 PR 也添加到项目 (可选但推荐)
gh project item-add 13 --owner chen56 --pull-request [pr-num]

# 移动状态到 In Review
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "In Review"
```

### 7. 合并 PR，移动到 Done

```bash
# 代码审查通过后合并 (squash 保持历史干净)
gh pr merge [pr-num] --squash

# 清理本地分支
git checkout main
git pull
git branch -d feature/dao-[issue-num]-xxx-feature

# 如果没自动关闭，手动关闭 Issue
gh issue close [issue-num]

# 看板移动到 Done
gh project item-edit \
  --id <ITEM-ID> \
  --owner chen56 \
  --project-id PVT_kwHOAB8fvs4BTGD4 \
  --field "Status" \
  --option "Done"
```

## 常用命令速查

### 项目查看

| 命令 | 说明 |
|------|------|
| `gh project list --owner chen56` | 列出所有项目 |
| `gh project item-list 13 --owner chen56` | 列出项目中所有 items |
| `gh project view 13 --owner chen56` | 查看项目信息 |
| `gh project view 13 --owner chen56 --web` | 在浏览器打开项目 |
| `gh issue list --assignee @me` | 查看分配给我的 issues |
| `gh pr list --state open` | 查看打开的 PR |

### 状态移动速查表

| 起点 → 终点 | 命令选项 |
|------------|----------|
| Backlog → Ready | `--option "Ready"` |
| Ready → In Progress | `--option "In Progress"` |
| In Progress → In Review | `--option "In Review"` |
| In Review → Done | `--option "Done"` |

## `gh issue create` vs `gh project item-create`

| 特性 | `gh issue create` | `gh project item-create` |
|------|------------------|--------------------------|
| 创建位置 | GitHub Issue 系统 (仓库级) | Project 看板草稿卡片 |
| 正式 Issue | ✅ 是，有编号 | ❌ 草稿，仅在看板显示 |
| 仓库可见 | ✅ Issues 列表可见 | ❌ 仅 Project 可见 |
| PR 自动关闭 | ✅ 支持 `Closes #N` | ❌ 不支持 |
| 适用场景 | 正式开发任务 | 头脑风暴、临时想法 |

> **推荐**：开发任务一律使用 `gh issue create --project 13`

## 完整速记流程

```bash
# 1. 新建任务
gh issue create --title "..." --body "..." --label feature --project 13

# 2. 看 item ID
gh project item-list 13 --owner chen56

# 3. 移动到 Ready
gh project item-edit --id ITEM_ID --field Status --option "Ready"

# 4. 开始开发，移动到 In Progress
gh project item-edit --id ITEM_ID --field Status --option "In Progress"

# 5. 创建分支 -> 开发 -> 提交 -> 推送

# 6. 创建 PR
gh pr create --base main --head branch --title "..." --body "Closes #N"

# 7. 移动到 In Review
gh project item-edit --id ITEM_ID --field Status --option "In Review"

# 8. 合并 PR
gh pr merge PR_NUM --squash

# 9. 移动到 Done
gh project item-edit --id ITEM_ID --field Status --option "Done"
```

## 项目状态列定义 (标准看板)

| 状态 | 含义 |
|------|------|
| `Backlog` | 待规划，还没准备好做 |
| `Ready` | 规划完成，准备就绪，可以开始 |
| `In Progress` | 正在开发中 |
| `In Review` | 代码审查中 |
| `Done` | 完成 |

## 管理关联仓库

GitHub Project V2 支持关联多个仓库，所有关联仓库中新建的 issue 和 PR 会自动同步到项目看板。

### 关联新仓库

```bash
# 语法: gh project link <project-number> --owner <owner> --repo <owner/repo>
gh project link 13 --owner chen56 --repo chen56/sha
```

### 列出所有已关联仓库

> **Note**: 当前 gh CLI (v2.86.0) 没有内置命令列出已关联仓库，只能通过 GitHub Web UI 在项目设置中查看。

### 取消关联仓库

```bash
# 语法: gh project unlink <project-number> --owner <owner> --repo <owner/repo>
gh project unlink 13 --owner chen56 --repo chen56/sha
```

> **效果说明**: 关联仓库只用于自动同步新 issue/PR，已有的 issue/PR 需要手动添加到项目。取消关联不会移除项目中已有的 items。

## 参考链接

- [GitHub CLI 官方文档](https://cli.github.com/manual/)
- [GitHub Project 文档](https://docs.github.com/en/issues/planning-and-tracking-with-projects)
- [Adding your project to a repository (Project V2)](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/adding-your-project-to-a-repository)
