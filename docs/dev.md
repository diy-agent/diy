---
title: 开发规范
tags: [dao, 开发]
category: 开发
description: 开发流程、规范
draft: false
---
# 开发规范

## 开发工作流 (Standard Workflow)

### Git Worktree 开发流程

本项目采用 **Worktree 隔离开发模式**，主分支 (main) 保持稳定，不直接修改。

**开发流程：**

1. **创建 worktree** - 开始新功能前必须执行：
   ```bash
   ./sha.sh worktree add dao-feature-<name>
   # 例：./sha.sh worktree add dao-feature-auth
   # 例：./sha.sh worktree add dao-fix-bug-something-wrong
   ```
   这将在 `.worktree/dao-feature-<name>` 创建独立的开发环境

2. **进入 worktree 开发**：
   ```bash
   cd .worktree/dao-feature-<name>
   # 进行开发、测试、提交
   ```

3. **合并回 main** - 开发完成后必须执行：
   ```bash
   ./sha.sh worktree merge dao-feature-<name>
   ```
   此命令会自动：
  - 运行测试验证
  - 更新 main 分支
  - 合并 worktree 分支
  - 清理临时 worktree `./sha.sh worktree remove dao-feature-auth`

**常用命令：**
```bash
./sha.sh worktree list                # 查看所有 worktree 状态
```

**AI Agent 守则：**
- ⚠️ **禁止** 直接在 main 分支进行修改
- ⚠️ **禁止** 绕过 `./sha.sh worktree` 脚本创建分支
- ✅ 每次开发前必须通过 `./sha.sh worktree add` 创建隔离环境
- ✅ 合并前确保测试通过

### 纯 Git 命令版本（项目内 .worktree 布局）

如果你不想使用封装脚本，可以直接用纯 Git 命令操作，所有 worktree 都放在项目内的 `.worktree/` 目录下：

**开发流程：**

1. **创建 worktree** - 在主分支（main）上执行，创建新的特性分支和 worktree：
   ```bash
   # 确保 main 是最新的
   git checkout main
   git pull origin main

   # 创建特性分支并在 .worktree/ 目录添加 worktree
   git worktree add .worktree/dao-feature-<name> -b dao-feature-<name>
   # 例：git worktree add .worktree/dao-feature-auth -b dao-feature-auth
   # 例：git worktree add .worktree/dao-fix-bug-xxx -b dao-fix-bug-xxx
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
   cd ../../.. # 或者直接 cd 到项目根
   git checkout main
   git pull origin main

   # 合并特性分支
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

# 删除废弃的 worktree
git worktree remove .worktree/old-feature-branch

# 清理失效的 worktree 条目
git worktree prune
```

**布局结构：**
```
project-root/        # 项目根目录，main 分支（主工作树）
├── .git/
├── .worktree/       # 所有特性 worktree 都放在这里
│   ├── dao-feature-auth/
│   ├── dao-fix-bug-xxx/
│   └── ...
├── src/
└── README.md
```

这种方式的优点：
- ✅ 纯 Git 原生命令，无需脚本
- ✅ 所有 worktree 集中在 `.worktree/` 目录，便于管理
- ✅ 根目录始终是 main 分支，符合直觉
- ✅ 符合本项目的隔离开发原则
