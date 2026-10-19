// tests/core/env-watch-hub.test.ts
// ═══════════════════════════════════════════════════════════════
// ##384 main 侧「环境感知」中心：**自动消 / 静音 / 订阅回放 / 同 type 去重**。
//
// 这几条是用户视角的硬要求，且都只能在服务层验（判据纯函数验不了生命周期）：
//   ① 条件恢复 → 红条**自己消失**（用户不该为"它已经好了"去点 ✕）
//   ② ✕ = 「这个条件我知道了」→ 条件不变不再弹（否则 30s 轮询一次，✕ 等于没关）
//   ③ 订阅即回放（页面重载后 bar 能自己回来）
//   ④ 同 type 只留最新一条（轮询每 30s 采一次，不该堆出 20 条同样的红条）
//
// 全部用**注入的假 statfs**（绝不真填盘）：`EnvDiskPoller` 的探针是构造参数。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWatchHub, EnvDiskPoller, noteWriteError, type EnvWatchProbe } from "../../src/main/services/env-watch";
import { setWriteErrorHook, writeFileAtomic } from "../../src/main/core/atomic-write";
import { envNoticeFromDisk, envNoticeFromNetwork, type DiskSample, type EnvNoticeEvent } from "../../src/shared/env-watch";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const sample = (availBytes: number): DiskSample => ({ mount: "/probe", availBytes, totalBytes: 500 * GiB });

/** 可编程假探针：`next` 决定下一次 statfs 返回什么（不碰真盘） */
function fakeProbe(initial: DiskSample): EnvWatchProbe & { next: (s: DiskSample) => void } {
    let cur = initial;
    return {
        intervalMs: 1000,
        async statfs() {
            return cur;
        },
        next(s) {
            cur = s;
        },
    };
}

/** 收 n 个事件（带超时：不成立的实现该报超时而不是挂住） */
async function take(stream: AsyncIterable<EnvNoticeEvent>, n: number, timeoutMs = 2000): Promise<EnvNoticeEvent[]> {
    const it = stream[Symbol.asyncIterator]();
    const out: EnvNoticeEvent[] = [];
    for (let i = 0; i < n; i++) {
        const r = await Promise.race([
            it.next(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("等事件超时")), timeoutMs)),
        ]);
        if (r.done) break;
        out.push(r.value);
    }
    void it.return?.();
    return out;
}

beforeEach(() => {
    envWatchHub.reset();
});

describe("EnvDiskPoller（主动轮询）", () => {
    it("水位低 → 推 disk-full；水位恢复 → 自动 resolve（不要用户手动关）", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        await poller.tick();
        const low = envWatchHub.list();
        expect(low).toHaveLength(1);
        expect(low[0]?.type).toBe("disk-full");

        // 恢复：空间腾出来了
        probe.next(sample(100 * GiB));
        const events: EnvNoticeEvent[] = [];
        const sub = envWatchHub.subscribe();
        const reading = (async () => {
            for await (const ev of sub) {
                events.push(ev);
                if (ev.kind === "resolve") break;
            }
        })();
        await poller.tick();
        await reading;
        expect(events.some((e) => e.kind === "resolve" && e.data.id === low[0]!.id)).toBe(true);
        expect(envWatchHub.list()).toHaveLength(0);
    });

    it("**id 在条件持续期间稳定**（否则用户点 ✕ 会打空：界面拿的是上一轮的 id）", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        await poller.tick();
        const first = envWatchHub.list()[0]!.id;
        await poller.tick(); // 还是满的：数字刷新，但 id 必须不变
        const second = envWatchHub.list()[0]!.id;
        expect(second).toBe(first);
        // 槽内 kind 变了（low → full）是**新事实** → 换新 id
        probe.next(sample(1 * GiB)); // low
        await poller.tick();
        const low = envWatchHub.list()[0]!;
        expect(low.type).toBe("disk-low");
        expect(low.id).not.toBe(first);
    });

    it("同 type 只留最新一条（轮询重复采到同一状态不堆积）", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        for (let i = 0; i < 5; i++) await poller.tick();
        expect(envWatchHub.list()).toHaveLength(1);
    });

    it("full → low 是降级：只留 low（同一个卷的两种水位，不该并存）", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        await poller.tick();
        probe.next(sample(1 * GiB));
        await poller.tick();
        // full → low 是**同一个 type 族**的两种水位：新的一条替换旧的（不该并存两条说同一件事）
        const rows = envWatchHub.list();
        expect(rows.map((n) => n.type)).toEqual(["disk-low"]);
        // 恢复 ok 时撤掉
        probe.next(sample(100 * GiB));
        await poller.tick();
        expect(envWatchHub.list()).toHaveLength(0);
    });

    it("statfs 抛错不带走轮询（只留日志，不伪造数字）", async () => {
        const probe: EnvWatchProbe = {
            intervalMs: 1000,
            async statfs() {
                throw Object.assign(new Error("volume gone"), { code: "ENOENT" });
            },
        };
        const poller = new EnvDiskPoller(probe, "/probe");
        await expect(poller.tick()).resolves.toBeUndefined();
        expect(envWatchHub.list()).toHaveLength(0);
    });
});

describe("dismiss 语义（✕ = 这个条件我知道了）", () => {
    it("关掉后条件不变 → 再探测也不再弹（否则 30s 弹一次，✕ 等于没关）", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        await poller.tick();
        const id = envWatchHub.list()[0]!.id;
        envWatchHub.dismiss(id);
        expect(envWatchHub.list()).toHaveLength(0);
        // 条件仍是满盘 → 再采一次**不该**重新弹
        await poller.tick();
        expect(envWatchHub.list()).toHaveLength(0);
    });

    it("条件恢复后静音解除：再坏要能重新提醒", async () => {
        const probe = fakeProbe(sample(100 * MiB));
        const poller = new EnvDiskPoller(probe, "/probe");
        await poller.tick();
        envWatchHub.dismiss(envWatchHub.list()[0]!.id);
        probe.next(sample(100 * GiB)); // 恢复
        await poller.tick();
        probe.next(sample(100 * MiB)); // 又满了
        await poller.tick();
        expect(envWatchHub.list().map((n) => n.type)).toEqual(["disk-full"]);
    });

    it("不给 id = 全关（bar 的批量语义）", async () => {
        envWatchHub.push(envNoticeFromDisk(sample(100 * MiB), "poll")!);
        envWatchHub.push(envNoticeFromNetwork({ code: "ETIMEDOUT", message: "x" }, 3)!);
        expect(envWatchHub.list()).toHaveLength(2);
        envWatchHub.dismiss();
        expect(envWatchHub.list()).toHaveLength(0);
    });
});

describe("写失败被动升级（ENOSPC → 立刻 disk-full，不等轮询）", () => {
    it("ENOSPC → 推 disk-full（source=write-error），数字来自失败路径所在卷", async () => {
        // 用 /tmp 当"失败路径"（真 statfs，不填盘）：验的是**接线**，不是真满盘
        const err = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        await noteWriteError(err, "/tmp/whatever.txt");
        const rows = envWatchHub.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.type).toBe("disk-full");
        const data = rows[0]!.type === "disk-full" ? rows[0]!.data : null;
        expect(data?.source).toBe("write-error");
        // mount 是失败文件的**父目录**（目标文件此刻可能不存在，statfs 它会 ENOENT）
        expect(data?.mount).toBe("/tmp");
        expect(data!.availBytes).toBeGreaterThan(0);
    });

    it("非 ENOSPC 的写失败不报（权限 / 其它错误不是「磁盘满」）", async () => {
        for (const code of ["EACCES", "EIO", "EROFS"]) {
            await noteWriteError(Object.assign(new Error(code), { code }), "/tmp/x");
        }
        expect(envWatchHub.list()).toHaveLength(0);
    });

    it("原子写的失败钩子带上**失败路径**（磁盘满只跟那个卷有关）", async () => {
        const seen: Array<{ code: unknown; path: string }> = [];
        setWriteErrorHook((e, path) => seen.push({ code: (e as NodeJS.ErrnoException).code, path }));
        try {
            // 真失败注入：目标路径的父"目录"是一个普通文件 → mkdir 必然 ENOTDIR
            const blocker = join(mkdtempSync(join(tmpdir(), "t384-hook-")), "blocker");
            writeFileSync(blocker, "x");
            const target = join(blocker, "sub", "x.txt");
            expect(() => writeFileAtomic(target, "x")).toThrow();
            expect(seen).toHaveLength(1);
            expect(seen[0]!.path).toBe(target);
            expect(seen[0]!.code).toBe("ENOTDIR");
        } finally {
            setWriteErrorHook(null);
        }
    });
});

describe("订阅（订阅即回放 + 增量）", () => {
    it("先回放现存，再收增量（页面重载后 bar 能自己回来）", async () => {
        envWatchHub.push(envNoticeFromDisk(sample(100 * MiB), "poll")!);
        const events = await take(envWatchHub.subscribe(), 1);
        expect(events[0]?.kind).toBe("upsert");
        expect(events[0]?.kind === "upsert" && events[0].data.type).toBe("disk-full");
    });

    it("**别人关掉**（CLI / 另一个窗口）也要推 resolve：订阅者手上那条必须跟着消失", async () => {
        // 实测踩过：CLI `diy env dismiss` 只改 ring 不推事件 → 页面上的 bar 一直亮到重载
        const n = envNoticeFromDisk(sample(100 * MiB), "poll")!;
        envWatchHub.push(n);
        const sub = envWatchHub.subscribe();
        const it = sub[Symbol.asyncIterator]();
        await it.next(); // 回放
        envWatchHub.dismiss(n.id);
        const r = await it.next();
        expect(r.value).toEqual({ kind: "resolve", data: { id: n.id } });
        await it.return?.();
    });

    it("resolve 是显式事件（bar 侧据此移除，不靠再拉全量猜）", async () => {
        envWatchHub.push(envNoticeFromDisk(sample(100 * MiB), "poll")!);
        const sub = envWatchHub.subscribe();
        const it = sub[Symbol.asyncIterator]();
        await it.next(); // 回放
        envWatchHub.resolveDisk("/probe");
        const r = await it.next();
        expect(r.value?.kind).toBe("resolve");
        await it.return?.();
    });
});
