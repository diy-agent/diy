---
name: find-context
description: >
  在任何涉及文件读写、查看、修改的编码或文档任务，
  必须先执行此 skill，从目标文件向上发现各级 AGENTS.md 和 skills。
  触发词：改代码、修bug、写代码、读代码、提交、测试、编辑文档、任何文件操作。
---

# find-context

从 🎯 目标文件向上遍历目录树，发现路径上的 AGENTS.md 和 `.agents/skills/`，
解决 monorepo 中根 AGENTS.md 看不到子包上下文的问题。

## 流程

### 1. 运行脚本

```bash
python $SKILL_DIR/scripts/find.py <目标文件或目录>
```

示例：目标文件 `packages/backend/src/routes/api.js`

```
demo-repo/
├── ✅ AGENTS.md
├── ✅ .agents/skills/shared-lint/
│   └── ✅ SKILL.md
├── packages/
│   ├── backend/
│   │   ├── ✅ AGENTS.md
│   │   ├── ✅ .agents/skills/deploy-check/
│   │   │   └── ✅ SKILL.md
│   │   └── src/routes/
│   │       └── 🎯 api.js
│   └── frontend/
│       ├── 🚫 AGENTS.md
│       ├── 🚫 .agents/skills/screenshot-diff/
│       │   └── 🚫 SKILL.md
│       └── ...
```

### 2. 读取关键文件

对脚本输出中排在前面的文件用 `read` 读取。至少读取：
- 目标文件所在子包的 AGENTS.md
- 任何匹配当前任务的 SKILL.md

### 3. 确认理解

口头确认："已加载 xxx/AGENTS.md（定义了 yyy 约束）"。

## 排除说明

- 脚本只检查 `AGENTS.md` 和 `.agents/skills/*/SKILL.md`，不需要排除 `node_modules`/`.venv`/`.gitignore` 等目录
- 树洞口不会横向扫描侧枝目录，只沿目标路径向上
