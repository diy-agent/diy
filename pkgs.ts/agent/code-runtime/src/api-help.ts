// api-help.ts —— 把 RPC 契约树摊成**给模型看的清单**。
//
// 为什么必须有这份：注入的 `api` 是 `createTypedClient` 造的 Proxy（`get` 陷阱拼路径），
// `Object.keys(api)` 是空数组 —— 模型没法枚举它，只能靠清单检索"我能调什么"。
//
// 这份清单同时也是"策略不变面"的一部分：换引擎（vm → worker → 子进程）时，
// 模型看到的清单要一模一样（所以它只含纯数据，不含任何活对象）。

import { _flattenRouter, type _AnyProcedureMeta, type _Router } from '@diy-agent/rpc';

import type { ApiHelpItem } from './globals.js';

/**
 * 摊平契约树 → 方法清单。
 *
 * @param tree   契约树（`diy2Api` / `workbenchRoutes` 这种 `RpcSchema.group`）
 * @param opts.prefix  传输层前缀（`diy2`）。**会从 path 里剥掉** —— 前缀是挂载点，
 *                     模型看到的是 `api.bots.list(...)`，不是 `api.diy2.bots.list(...)`；
 *                     不剥的话模型照抄清单必然调错。
 */
export function apiHelpOf(
    tree: _Router | _AnyProcedureMeta,
    opts: {
        prefix?: string | undefined;
        /**
         * 方法用途的外部说明（`meta.desc` 没写时兜底）。`path` 是**剥过 prefix 的**，
         * 也就是模型看到的那一个 —— 这样宿主那张表和清单用的是同一套名字。
         */
        descOf?: ((path: string) => string | undefined) | undefined;
        /** 只取一个域（`chat`）；不传 = 全部。模型通常只想知道「这个域有什么」 */
        group?: string | undefined;
    } = {},
): ApiHelpItem[] {
    const strip = opts.prefix === undefined || opts.prefix === '' ? '' : `${opts.prefix}.`;
    return (
        Object.entries(_flattenRouter(tree))
            .map(([rawPath, meta]) => {
                const path = strip !== '' && rawPath.startsWith(strip) ? rawPath.slice(strip.length) : rawPath;
                const desc =
                    meta.desc === undefined ? opts.descOf?.(path) : (meta.desc.split('\n')[0]?.trim() ?? meta.desc);
                return {
                    path,
                    ...(desc === undefined ? {} : { desc }),
                    mode: meta._streamMode,
                };
            })
            .filter((item) =>
                opts.group === undefined ? true : item.path === opts.group || item.path.startsWith(`${opts.group}.`),
            )
            // 不再 filter group：`_flattenRouter` 用 `_routeLeaves`，父命令本来就进不来。
            // 多一层「防御」实际是第二份真相 —— flatten 将来变了会静默对不上。
            .sort((a, b) => a.path.localeCompare(b.path))
    );
}
