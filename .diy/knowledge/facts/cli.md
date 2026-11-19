---
desc: 知识库的读入口（diy2 facts）；写侧 diy kb，yaml 事实库已退役
updated: 2026-11-19
---

## read

`diy2 facts brief <主题>` · `get <路径>#<小节>` · `find <词,...>` · `status` —— 真源 `.diy/knowledge/**/*.md`（项目库优先，`~/.diy/knowledge` 兜底）；**只读投影**，不建索引、不引入 claim / evidence。实现：`pkgs.ts/core/kb/src/query.ts` + `apps/diy2/src/cli/facts.ts`。

## write

写侧仍是 `diy kb write | move | index`（`@diy-agent/kb`）。yaml 事实库（`diy facts submit / get --in task:` 那套 + `knowledge/facts/*.yaml`）**已退役** —— 数据已迁成 md；任务级长期知识暂放任务 body 或项目库，别再用 yaml。
