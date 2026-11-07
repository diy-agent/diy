# @diy-agent/kb

知识库目录：多级 markdown + yaml 头，**文件名即索引**。

## 为什么是文件

218 个任务的完整 `llm.jsonl` 实测：

```
facts    写入 861 条 claims  /  读取 20 次   = 43 : 1
journal  写入 416 条         /  读取  4 次   = 104 : 1
218 个任务里只有 3 个用过 facts（1.4%）
```

根因**不是投递方式**，而是「要求模型主动查」这个前提不成立 —— AGENTS.md 天天生效是因为
它**不需要模型做任何动作**。所以知识退化成模型天然会用的形态：文件（`rg` / `cat` 是肌肉记忆）。

## 三条铁律

1. **多级目录**，根目录不许散文件（只有 `INDEX.md`）；中文目录名 / 文件名欢迎
2. 元数据只留 `desc` + `updated`
3. 本包只做**写 + 整理**（write / check / index / move），**不提供查询** —— 模型自己 `rg`

## 与 docs 的判据

```
docs/             「为什么这么设计」—— 改代码不一定 要改它
.diy/knowledge/   「现在是什么」    —— 改代码就该 改它
```

可执行判据：这条知识在代码改动后**会变**吗？会 → knowledge。

## 用法

```ts
import { scanKb, writeEntry, writeIndex, moveEntry } from '@diy-agent/kb';

scanKb('/repo/.diy/knowledge');                    // 条目 + 问题
writeEntry(root, 'rules/通用硬约束.md', content);   // 根目录散文件会被拒
writeIndex(root, '项目 diy');                       // 重新生成 INDEX.md
moveEntry(root, 'app/旧名.md', 'app/新名.md');
```

| 函数 | 说明 |
|---|---|
| `scanKb(root)` | 扫全部 `*.md`，返回 `entries` + `problems`（`kb/root-file` / `kb/no-desc` / `kb/no-frontmatter` / `kb/empty-body`） |
| `renderIndex(entries, label)` | 纯函数，生成 INDEX 文本 |
| `writeIndex(root, label)` | 扫 + 生成并落盘 |
| `writeEntry(root, path, content)` | **路径校验的唯一强制点**（根目录散文件 / 越界 / `INDEX.md` / 非 `.md` 一律拒） |
| `moveEntry(root, from, to)` | 改走 `writeEntry` 的同一道闸 |
| `readFrontmatter` / `bodyOf` / `sectionsOf` | yaml 头（`>-` 与 `\|` 都收成单行）/ 正文 / 二级标题数 |
