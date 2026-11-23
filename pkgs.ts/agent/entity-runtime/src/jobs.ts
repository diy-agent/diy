// jobs.ts —— 后台作业（`@diy-agent/jobs`）在 diy2 这一侧的接线。
//
// 账本、判活、tail、四态、`job` 工具面全在内核（`@diy-agent/jobs/node`）；
// 本文件只回答两件内核不知道的事：
//   1. **一条 run 是谁起的** —— 归属串 `<roomId>#<botId>`（房间 / 成员都是 diy2 的概念）；
//   2. **收口之后叫醒谁** —— 内核只把 `JobDoneEvent` 交出来，路由回房间是宿主的事。
//
// 没有房间身份（CLI / 单测自己 new 的账本）时 `taskUri` 对不上，`parseJobOwner` 返回
// undefined ⇒ 静默收口，不会误唤醒任何东西。

import { RunRegistry, type JobDoneEvent } from '@diy-agent/jobs/node';

/** 归属串的分隔符：roomId 里不会有 `#`（id 是 uuid / `proj:xxx` 这类） */
const SEP = '#';

export interface JobOwner {
    roomId: string;
    botId: string;
}

export function jobOwnerOf(roomId: string, botId: string): string {
    return `${roomId}${SEP}${botId}`;
}

/** 归属串 → 房间 / 成员；不是本形态（或被别的宿主起的）返回 undefined */
export function parseJobOwner(owner: string | undefined): JobOwner | undefined {
    if (owner === undefined) return undefined;
    const at = owner.lastIndexOf(SEP);
    if (at <= 0 || at === owner.length - 1) return undefined;
    return { roomId: owner.slice(0, at), botId: owner.slice(at + 1) };
}

export interface RoomJobsHost {
    /** 运行产物根（账本的 `meta.json` / `out.log` 落这里；diy2 = `<home>/log/job/runs`） */
    rootDir: string;
    /** 一条 run 收口之后去哪（房间自己决定是插话还是只留一条 notice） */
    onDone: (event: JobDoneEvent, owner: JobOwner) => void;
}

/**
 * 进程级账本（一张表一个进程 —— 包不提供单例，谁 new 谁负责）。
 *
 * **必须与 `RoomActor` 共用同一个实例**：`bash(background:true)` 起的 run 和 `job` 工具
 * 查的是同一张表，否则模型起了活却查不到自己那条。
 */
export function createJobRegistry(host: RoomJobsHost): RunRegistry {
    return new RunRegistry({
        rootDir: host.rootDir,
        notifier: (event) => {
            const owner = parseJobOwner(event.taskUri);
            if (owner === undefined) return;
            host.onDone(event, owner);
        },
    });
}
