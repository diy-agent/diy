/**
 * src/ref/api.ts — ref 域 RPC 纯定义（meta，无 call）
 *
 * 命名对齐旧 Python `diy ref <命令>`：add / remove / sync / list。
 * 实现绑定见 impl.ts（bindRefHandlers 注册到 ServerBinding）。
 *
 * 语义（v1 简化版，无项目边界探测、无 node/python 依赖扫描）：
 *   - cwd 即作用域：diy.yaml 在哪个目录，dev ref 就在哪个目录操作
 *   - add 写 cwd/diy.yaml 的 ref.source（无 diy.yaml 则建模板）
 *   - sync clone 到 $DIY_HOME/ref/<host>/<owner>/<repo>/<version>/，写 cwd/.diy/ref.lock.yaml
 *   - list 读 cwd/.diy/ref.lock.yaml，对齐本地目录存在性（缺失提示 sync）+ 最后 sync 时间
 */

import { RpcSchema } from "@diy/rpc";
import { z } from "zod";

/** list 单条输出：lock 条目 + 本地目录实时对齐 */
export const RefEntrySchema = z.object({
    /** host/owner/repo 去重键 */
    key: z.string(),
    /** 完整 source 串（含版本，如 https://github.com/org/repo@v1.0.0） */
    url: z.string(),
    /** @ 后版本段；null = 按 main 处理 */
    version: z.string().nullable(),
    /** 镜像目录（list 输出为拼 home 后的绝对路径，可直接使用） */
    dir: z.string(),
    /** 运行时对齐：目录是否存在 */
    exists: z.boolean(),
    /** 最后 sync 时间（ISO）；tag 类无 pull，显示创建/检出时间 */
    lastSync: z.string().nullable(),
});
export type RefEntry = z.infer<typeof RefEntrySchema>;

export const refApi = RpcSchema.router({
    ref: RpcSchema.group({
        desc: `
    dev ref — 本地源码镜像管理（简化版）
    按 URL 下载外部 git 仓库源码到 $DIY_HOME/ref/，不做依赖扫描，只处理人工指定的 source。

    数据流:
      dev ref add <url>     注册 source 到 cwd/diy.yaml（无则建模板）
      dev ref sync          批量 clone 已注册 source，写 cwd/.diy/ref.lock.yaml
      dev ref list          查看 lock 映射表（对齐本地目录 + 最后 sync 时间）
      dev ref remove <key>  从 diy.yaml 移除（不动已下载镜像）

    版本语义: @ 后段或 /tree/ 后段为 tag（v1.0.0）/ SHA → 检出后不更新；
    为分支（main/develop，斜杠分支整体作 ref 名）或无版本 → 检出后 sync 时 git pull。
    非 semver tag（如 nightly）按 clone 到的本地 refs/tags/ 自动消歧。
    `,
        children: {
            add: RpcSchema.unary({
                desc: `注册 source 到 cwd/diy.yaml（URL 可带 @版本）`,
                input: {
                    url: z.string().min(1, "URL 不能为空").cliArg({
                        desc: "Git 仓库 URL，如 https://github.com/org/repo 或 …@v1.0.0",
                    }),
                },
                output: z.object({
                    status: z.string(),
                    data: z.object({
                        name: z.string(),
                        spec: z.string(),
                    }),
                }),
            }),

            remove: RpcSchema.unary({
                desc: `从 cwd/diy.yaml 移除 source（本地镜像保留不动）`,
                input: {
                    name: z
                        .string()
                        .cliArg({ desc: "owner/repo、完整 URL 或 diy.yaml 中的原字符串" }),
                },
                output: z.object({
                    status: z.string(),
                    data: z.object({
                        removed: z.string(),
                    }),
                }),
            }),

            /** sync 逐条进度 chunk：每处理完一个 source yield 一条；最后一条 action=done 带汇总 */
            sync: RpcSchema.serverStream({
                desc: `批量 clone 已注册 source 到 $DIY_HOME/ref/ 并写 cwd/.diy/ref.lock.yaml（流式进度）`,
                input: {},
                output: z.object({
                    spec: z.string(),
                    /** cloned=新克隆 pulled=分支更新 tagSkipped=tag 固定跳过 error=失败 done=结束汇总 */
                    action: z.enum(["cloned", "pulled", "tagSkipped", "error", "done"]),
                    message: z.string().optional(),
                    summary: z
                        .object({
                            synced: z.number(),
                            tagSkipped: z.number(),
                            total: z.number(),
                            errors: z.array(z.object({ spec: z.string(), message: z.string() })),
                        })
                        .optional(),
                }),
            }),

            list: RpcSchema.unary({
                desc: `查看 cwd/.diy/ref.lock.yaml 映射表（对齐本地目录存在性 + 最后 sync 时间）`,
                input: {},
                output: z.array(RefEntrySchema),
            }),
        },
    }),
});