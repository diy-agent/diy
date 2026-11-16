// local.ts — 进程内接线：一个 actor + 一个 client + 一条内存链路，外加一个本地扇出端口。
//
// 存在的理由不是“方便”，是**测试和文档要能跑**：docs 里每一段示例都用它，
// 于是示例不会烂（tests/ 里就是这么跑的）。生产接线（ws / http）在各端的适配器里。
//
// 注意：这里**没有**任何全局注册表。actor 的地址只用于扇出回执对照和日志，
// 谁连谁由调用方接线决定（这也让 placement 不进协议，见 docs/02-wire.md）。

import { ActorClient, createClient } from './client.js';
import type { FanoutPort } from './fanout.js';
import type { Kind } from './kinds.js';
import { Actor, createActor, type CreateActorOptions } from './runtime.js';
import { createInProcessPair } from './transport.js';

export interface LocalActorOptions<K extends Kind> extends CreateActorOptions<K> {
    /** client 侧单请求超时 */
    readonly timeoutMs?: number;
}

export interface LocalActorHandle<K extends Kind> {
    readonly actor: Actor<K>;
    readonly client: ActorClient<K>;
    /** 拆链路（actor 还活着） */
    detach(): void;
}

export async function createLocalActor<K extends Kind>(opts: LocalActorOptions<K>): Promise<LocalActorHandle<K>> {
    const pair = createInProcessPair();
    const actor = createActor(opts);
    await actor.start();
    const detach = actor.attach(pair.actor);
    const client = createClient({ link: pair.caller, kind: opts.kind, timeoutMs: opts.timeoutMs });
    return { actor, client, detach };
}

/**
 * 进程内扇出端口：按 target 地址找 client。
 *
 * 找不到 = 这个 target 不可达（回 `E_NOT_FOUND`），由 fanout 折成一条 `answered: false` ——
 * 于是“某个成员所在节点掉线”在业务层就是一个有位置的 `unknown`，不是一个消失的成员。
 */
export function createLocalPort(resolve: (target: string) => ActorClient<Kind> | undefined): FanoutPort {
    return {
        async query({ target, name, data, timeoutMs }) {
            const client = resolve(target);
            if (!client) {
                const err = new Error(`找不到 target：${target}`);
                throw Object.assign(err, { code: 'E_NOT_FOUND' });
            }
            const outcome = await client.rawQuery(name, data, { timeoutMs });
            if (!outcome.ok) {
                throw Object.assign(new Error(outcome.message), { code: outcome.code });
            }
            return outcome.data;
        },
    };
}
