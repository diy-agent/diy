/**
 * api-domains/kb/api.ts — `kb` 域的 RPC 契约
 *
 * 用户 2026-11-06：「知识库退化成 md 目录，diyapp 对项目的 .diy/knowledge 和
 * ~/.diy/knowledge 进行维护…可以提供写入的工具，但查询就不提供了，自己读 index 自己找」。
 *
 * **只写不查**是刻意的：实测 facts 写入 861 条 / 读取 20 次（43:1），
 * 根因是「要模型主动查」的前提不成立。所以这里不给 get/brief/find —— 模型 `rg` 就行。
 *
 * 目录约定同 `seed`：
 *   kb/api.ts    ← 手写，唯一真源（生成器扫描约定）
 *   kb/gen/      ← 生成的 `.d.ts`（别手改）
 *   kb/impl.ts   ← handler 绑定
 */
import { z } from "zod";
import { RpcSchema, defineService } from "@diy-agent/rpc";

/** 库根：缺省 = cwd 下 `.diy/knowledge`；`global` = `$DIY_HOME/knowledge` */
const RootInput = {
    dir: z.string().optional().cliOption({
        desc: "库根目录（缺省：cwd 下 `.diy/knowledge`；给 `global` = `$DIY_HOME/knowledge`）",
    }),
    /**
     * 调用方 cwd（CLI parser 注入，见 `cliOption({ callerCwd: true })`）。
     *
     * **不传就会用主进程 cwd**（= 应用目录 = 主仓），worktree 里的命令会写错库 ——
     * 与 ##437 同一类坑，判据也同一句：库根必须按**敲命令的那个 shell** 找。
     */
    cwd: z.string().optional().cliOption({ callerCwd: true }),
};

export const KbProblemSchema = z.object({
    path: z.string().describe("相对路径；空串 = 根目录层面的问题"),
    code: z.string().describe("机器码：kb/root-file · kb/no-frontmatter · kb/no-desc · kb/empty-body"),
    message: z.string().describe("给人看的一句话"),
});

export const KbEntrySchema = z.object({
    path: z.string().describe("相对库根的路径（`rules/通用硬约束.md`）"),
    desc: z.string().describe("yaml 头的 desc（INDEX 上靠它说明这是什么）"),
    updated: z.string().describe("yaml 头的 updated（`YYYY-MM-DD`；缺失 = 空串）"),
    sections: z.number().describe("正文里 `##` 小节数"),
    bytes: z.number().describe("正文字节数"),
});

export const kbRoutes = RpcSchema.group({
    desc:
        `知识库（**只写不查**）：多级 markdown + yaml 头，文件名即索引。` +
        `\n\n**为什么不提供 get/brief/find**：实测 facts 写入 861 条 / 读取 20 次（43:1），` +
        `根因是「要模型主动查」的前提不成立 —— 所以知识就是文件，你自己 rg / cat。` +
        `\n\n**与 docs 的判据**：改代码后**会变**的知识放这里；「为什么这么设计」放 docs/`,
    children: {
        write: RpcSchema.unary({
            desc:
                `写一条知识（覆盖）。**根目录散文件会被拒** —— 多级目录是铁律，这是唯一的强制点。` +
                `\n\n正文从 stdin 读（--body-file -）或 --body-file 路径；updated 由工具自动补`,
            input: {
                path: z.string().cliArg({ desc: "相对库根的路径，必须含子目录且以 .md 结尾（如 `rules/通用硬约束.md`）" }),
                bodyFile: z.string().cliOption({ desc: "正文来源：`-` = stdin，或文件路径" }),
                desc: z.string().cliOption({ desc: "yaml 头的 desc（一行说明，进 INDEX）" }),
                ...RootInput,
            },
            output: z.object({
                path: z.string().describe("落盘的绝对路径"),
                bytes: z.number().describe("写入字节数"),
            }),
        }),
        check: RpcSchema.unary({
            desc: `体检：条目 / 问题清单（根目录散文件 · 缺 yaml 头 · 缺 desc · 空正文）。有问题时退出码非 0`,
            input: RootInput,
            output: z.object({
                root: z.string().describe("库根绝对路径"),
                entries: z.array(KbEntrySchema).describe("合格的条目"),
                problems: z.array(KbProblemSchema).describe("问题（空数组 = 干净）"),
            }),
        }),
        index: RpcSchema.unary({
            desc: `重新生成 <root>/INDEX.md（有问题的条目**不进索引** —— 宁可少一条，也不让索引里出现没有说明的行）`,
            input: {
                label: z.string().optional().cliOption({ desc: "索引抬头的一句说明（如「项目 diy」）" }),
                ...RootInput,
            },
            output: z.object({
                path: z.string().describe("INDEX.md 绝对路径"),
                entries: z.number().describe("进了索引的条目数"),
                problems: z.array(KbProblemSchema).describe("被跳过的条目原因"),
            }),
        }),
        move: RpcSchema.unary({
            desc: `改名 / 移动（走 write 的同一道闸：目标也不能是根目录散文件）`,
            input: {
                from: z.string().cliArg({ desc: "源路径（相对库根）" }),
                to: z.string().cliArg({ desc: "目标路径（相对库根）" }),
                ...RootInput,
            },
            output: z.object({
                from: z.string().describe("原绝对路径"),
                to: z.string().describe("新绝对路径"),
            }),
        }),
    },
});

export const kbService = defineService({ name: "diy.kb", api: kbRoutes });
