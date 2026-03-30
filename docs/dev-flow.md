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

[ ] TODO github工作流 + 自定义脚本 (Github Standard Workflow)


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

[ ] TODO github工作流+纯 Git 命令（Github + Pure git command Workflow)
