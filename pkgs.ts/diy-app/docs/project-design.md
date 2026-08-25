# project 替代 subject — 设计定稿

worktree: `diy-feat-project`（分支 `feat/project`，基于 main 724c39f）

## 数据模型（定稿）

```
state.yaml
  projects:                    ← 标签/元数据层，key = 短 id
    diy:
      label: diy 主仓          # 可选
      path: ~/git/diy/diy      # 可选，规范化存储
      desc: 描述               # 可选
      state: active            # 可选

~/.diy/task/<uri>/AGENTS.md    ← task 隔离集中存，物理目录不变
  frontmatter:
    project: diy               # 仅一个引用字段，关联到 projects
    title: ...
```

## 核心设计原则：task 隔离存放，project 只是关联标签

**task 物理目录永远不放进 project 目录下。** 就像 GitHub 的 issue 隔离存在
库里、通过 repo/标签关联，而不是 issue 文件塞进项目目录树一样——task 集中
存 `~/.diy/task/`，project 只是让 task 归组的一个元数据标签，不决定物理位置。

看到这个对应关系的后果：
- 存储布局**零改动**，URI 仍 `local/<ts>`（历史兼容）
- `project remove` 只删 state.yaml 里的标签，**绝不碰 task 数据**
- 无映射表——task 到 project 就是 frontmatter 一个字符串字段

## 相对 subject 的变化

| 维度 | subject（旧） | project（新） |
|------|--------------|--------------|
| 注册 key | 磁盘路径 `$HOME/work` | 短 id `work` |
| 元数据 | `{label, desc}` | `{label, path, desc, state}`（+path/+state） |
| task 字段 | `subject` | `project`（读兼容旧 `subject`） |
| 树节点 kind | `subject` | `project` |
| 命令 | `diy subject add/list/remove` | `diy project create/list/remove` |
| list 筛选 | `relPath.startsWith(路径)`——对 `local/xx` 永远 false，死的 | 按 `meta.project` 真实匹配 |

## 接口

```
diy project create <id> --label --path --desc --state
diy project list                  → [{id, info:{label,path,desc,state}}]
diy project remove <id>
diy task create <title> <projectId> --parent --detail --body
diy task list [--project <id>]
```

## 已否决：方案 A「task 物理进 project 目录」

曾提过把 task 移到 `~/.diy/project/<id>/`、URI 变 `<id>/<slug>`、tree 顶层按
目录分组的方案。**已否决**——违反"task 隔离存放"原则（同 GitHub issue），
且引入物理迁移、URI 重构、star/list 全链路大改造，收益相对破坏不值。

## 影响面

`state.ts` / `project.ts`（新，替代 `subject.ts`）/ `task.ts` / `task-tree.ts` /
`tree-format.ts` / `api-def.ts` / `api-impl.ts` / renderer `taskStore.ts` /
`TaskTree.tsx` / `App.tsx` / `tests/cli.intent.test.ts`。
读取时兼容旧 `subject` 字段（project ?? subject），写入只写 project。