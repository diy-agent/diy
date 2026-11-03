// src/shared/docs.ts — 仓库文档索引的**契约**（##404 #3：docs/plans 动态索引）
//
// 两个消费面：
//   · 入口 `diy docs index`（RPC `docs.index`）—— **按需取**的全量索引；
//   · 上下文变量树的 `docs` 单元 —— 只放**摘要**（根 + 篇数 + 最新改动日），不放逐篇条目。
//
// 为什么每轮上下文只给摘要（##5 实测账）：逐篇 18 行 ≈ 2 KB/轮，全仓所有任务都付；
// 而"有哪些文档"是一次性好奇，不是每轮必需 —— 按需 query 一次（约一次请求）通常更划算。
// 索引全文永远只经 `diy docs index` 取，这也是它与 kb 索引（每轮给全部主题）的关键区别：
// kb 的主题数**有限且稳定**，docs 的篇数**随开发线性增长**。
import { z } from "zod";

/** 一篇文档的索引条目 */
export const DocsEntrySchema = z.object({
    path: z.string().describe("仓库相对路径（`diy tool read <path>` 读它）"),
    title: z.string().describe("首个 `# ` 标题（去掉尾部日期括注），缺失写 `(无 H1)`"),
    size: z.number().describe("字节数的 KB 取整（0 = 小于 1 KB）"),
    docDate: z.string().optional().describe("文档**自述**日期（`YY-MM-DD`，取自文件名 / 标题）。与 `touched` 不一致 = 值得点开看看"),
    touched: z.string().optional().describe("git 最后一次改动日（`YY-MM-DD`）；非 git 仓库 / 未提交过则缺席"),
    status: z.string().optional().describe("开篇引用块里的「状态：…」（启发式，≤20 字）。**抽不到就不给** —— 编出来的状态比没有更坏"),
});

/** 全量索引（`diy docs index` 的返回；也是页面渲染的数据源） */
export const DocsIndexSchema = z.object({
    roots: z.array(z.string()).describe("实际扫过的根（仓库相对）：缺省只有 `docs/plans`，可 `--roots` 扩"),
    entries: z.array(DocsEntrySchema).describe("按路径排序的索引；被 `--max` 截断时条数 < 目录实有篇数"),
});

/** 变量树里的 `docs` 单元 = **摘要**（不是全量索引，见文件头注） */
export const DocsSummarySchema = z.object({
    roots: z.array(z.string()).describe("扫描根（仓库相对）"),
    count: z.number().describe("可索引篇数（= `diy docs index` 的 entries 条数上限内）"),
    newest: z.string().optional().describe("全部文档里最新的 git 改动日（`YY-MM-DD`）；非 git / 未提交则缺席"),
});

export type DocsEntry = z.infer<typeof DocsEntrySchema>;
export type DocsIndex = z.infer<typeof DocsIndexSchema>;
export type DocsSummary = z.infer<typeof DocsSummarySchema>;
