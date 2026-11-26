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
    opts: { prefix?: string | undefined } = {},
): ApiHelpItem[] {
    const strip = opts.prefix === undefined || opts.prefix === '' ? '' : `${opts.prefix}.`;
    return (
        Object.entries(_flattenRouter(tree))
            .map(([rawPath, meta]) => {
                const path = strip !== '' && rawPath.startsWith(strip) ? rawPath.slice(strip.length) : rawPath;
                return {
                    path,
                    ...(meta.desc === undefined ? {} : { desc: meta.desc.split('\n')[0]?.trim() ?? meta.desc }),
                    mode: meta._streamMode,
                };
            })
            // 父命令（`group`）不是可调方法：列进去只会让模型试一次必然失败的调用
            .filter((item) => item.mode !== 'group')
            .sort((a, b) => a.path.localeCompare(b.path))
    );
}
