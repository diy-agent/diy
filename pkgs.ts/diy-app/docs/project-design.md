# project 替代 subject — 设计定稿

worktree: `diy-feat-project`（分支 `feat/project`，基于 main 724c39f）

## 数据模型（定稿）

```
$DIY_HOME/projects/<id>/            ← 项目数据目录（id = 系统自动生成的数字自增）
  meta.yaml                         ← 权威注册表 {id, path, label, desc, state, created}
  tasks/<tid>/AGENTS.md             ← 任务数据（按项目聚合；tid = 项目内数字自增）

~/git/some-project/diy.yaml         ← 目标仓库的"名片"（自描述/共享）
  project: { id, name }
```

- `project` id 数字自增（扫描 `$DIY_HOME/projects/` 取最大 +1），删除后 `remove` 摘除
  目标仓库 diy.yaml 名片 + 删除整个数据目录（**连带该项目的全部任务一次性清空**）
- `task` URI = `projects/<pid>/tasks/<tid>`，**project 由路径推导**，不再写 frontmatter
  `project` 字段（读侧兼容旧 `subject`/frontmatter）
- 删项目 = `rm -rf $DIY_HOME/projects/<id>`，符合"按项目分组存放物品"的直觉

## 核心设计原则：task 集中隔离存放，按项目聚合

task **仍然全部收在 $DIY_HOME 里**（diy 管的存储），不会散进用户真实仓库
`~/git/some-project/`。变的只是集中目录从平铺的 `$DIY_HOME/task/` 改为按项目聚合的
`$DIY_HOME/projects/<id>/tasks/` —— "集中隔离存放"语义不变，粒度从"所有 task 摊一层"
变成"一个项目一个目录"，使"删除一个项目就删掉它全部任务"成为一次目录删除。

对比历史：之前曾定稿"task 物理目录永不进 project 目录"（仅以 frontmatter 关联标签）。
本轮**有意识地反转**——按项目聚合，代价是 URI 从 `local/<n>` 变为 `projects/<pid>/tasks/<tid>`，
但换来"删除项目=一次性删除目录"和 tree/list 天然按项目分组、无需 frontmatter 冗余。

## 相对 subject 的变化

| 维度 | subject（旧） | project（新） |
|------|--------------|--------------|
| 注册 key | 磁盘路径 `$HOME/work` | 自动数字 id（`project create` 返回） |
| 注册/元数据存储 | state.yaml subjects | `$DIY_HOME/projects/<id>/meta.yaml` |
| 目标仓库 | 无 | diy.yaml 写 `project:` 名片（合并不覆盖 `ref:`） |
| task 存放 | `$DIY_HOME/task/local/<n>` + frontmatter | `$DIY_HOME/projects/<id>/tasks/<tid>`，路径即归属 |
| 树节点 kind | `subject` | `project` |
| 命令 | `diy subject add/list/remove` | `diy project create/list/remove` |
| list 筛选 | `relPath.startsWith(路径)`（死的） | 按目录/project id 精确匹配 |

## 接口

```
diy project create <path> --label --desc --state   → {id}   (id 自动数字自增；path 下写 diy.yaml 名片)
diy project list                  → [{id, info:{label,path,desc,state}}]
diy project remove <id>           → 删数据目录(连带任务) + 摘除目标仓库名片
diy task create <title> <projectId> --parent --detail --body   → {uri}   (uri = projects/<pid>/tasks/<tid>)
diy task list [--project <id>]
```

## 已否决：方案 A「task 物理进用户 project 目录」

曾提过把 task 移到 `~/git/some-project/.diy/` 之类目标仓库内部。**已否决** —— task 不应
散进用户真实仓库（污染、无法统一管理、删除项目时可能误删用户文件）。task 集中放
`$DIY_HOME/` 下，按项目聚合即可获得分组合并/一次性删除，无需放进用户仓库。

## 影响面

`state.ts`（projectsRoot/projectDir/taskDir=join(diyHome,uri)/projectFromUri，移除
state.yaml projects 段）/ `project.ts`（meta.yaml + diy.yaml 名片）/ `task.ts` /
`task-tree.ts`（路径即分组）/ `api-def.ts` / `api-impl.ts` / 意图测试
（cli.intent.project.test.ts / cli.intent.task.test.ts 独立成文件）。