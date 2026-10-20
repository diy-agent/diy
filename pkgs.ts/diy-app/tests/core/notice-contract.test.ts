// tests/core/notice-contract.test.ts
// ═══════════════════════════════════════════════════════════════
// ##391「提示体系规范化」的**契约测试**（纯 node，不起 Electron）。
//
// 用户原话（起点是那条没来由的绿色 toast「会话实时更新已恢复」）：
//   「所有用户可见的提示都需要有来源 / 原因 / 详情等，需提供详情按钮展开 2 级信息，
//     不然我也不知道 app 在干啥，提示这个是啥意思，详情里需要介绍机制。」
//
// 这里钉三件事，缺一件本任务就等于没做：
//   1. **反例护栏**：`addToast` 传空 source / reason / detail ⇒ 抛错（不是警告）。
//      没有它，下次有人图快写 `addToast("success", "好了")` 就能悄悄退化成裸文案。
//   2. **聚合**：同来源同文案连续发生 ⇒ 只留一条、`count` 递增（否则密集重连会刷屏）。
//   3. **遗留清单可数**：`addToastLegacy` 的调用点数按**文件**钉死 ——
//      改少了才许改基线（"不许局部改完就宣称统一"，验收 3 的字面要求）。
//
// 另附**样板断言**：ops 断线恢复的二级信息必须带「断了几秒 + 起止时刻 + 重订次数」，
// 那是验收 1 的硬指标（文案真源 `src/renderer_solid/lib/notice-ops.ts`）。
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { notificationStore, type Toast } from "../../src/renderer_solid/store/notificationStore";
import { formatClock, formatDuration, noticeCopyText } from "../../src/renderer_solid/lib/notice";
import { opsDownMeta, opsLiveMeta } from "../../src/renderer_solid/lib/notice-ops";

const SRC = join(__dirname, "..", "..", "src", "renderer_solid");

/** 一条合法二级信息（各用例只改自己关心的字段） */
const meta = (over: Partial<{ source: string; reason: string; detail: string }> = {}) => ({
    source: "测试 · notice-contract.test.ts",
    reason: "单测显式构造（无业务含义）",
    detail: "机制说明占位。",
    ...over,
});

const clear = () => {
    for (const t of notificationStore.toasts) notificationStore.removeToast(t.id);
};

beforeEach(clear);

describe("R1 反例护栏：空 source / reason / detail 一律拒绝", () => {
    it("空 source ⇒ 抛错（文案里点明缺哪个字段）", () => {
        expect(() => notificationStore.addToast("success", "好了", meta({ source: "" }))).toThrow(/source/);
    });

    it("空 reason ⇒ 抛错", () => {
        expect(() => notificationStore.addToast("success", "好了", meta({ reason: "   " }))).toThrow(/reason/);
    });

    it("空 detail（机制）⇒ 抛错：只给结论不给机制同样不许上屏", () => {
        expect(() => notificationStore.addToast("success", "好了", meta({ detail: "" }))).toThrow(/detail/);
    });

    it("整个 meta 缺失也拒（tsc 会先拦，但 JS 调用点也得守住）", () => {
        expect(() =>
            notificationStore.addToast("success", "好了", undefined as unknown as ReturnType<typeof meta>),
        ).toThrow(/source/);
    });

    it("空文案 ⇒ 抛错（提示至少得让人看见一句话）", () => {
        expect(() => notificationStore.addToast("success", "  ", meta())).toThrow(/message/);
    });

    it("合法调用的三段都进了 toast（详情面板的数据来源）", () => {
        notificationStore.addToast("info", "一条正常提示", meta({ source: "S", reason: "R", detail: "D" }));
        const t = notificationStore.toasts[0] as Toast;
        expect([t.source, t.reason, t.detail]).toEqual(["S", "R", "D"]);
        expect(t.legacy).toBeUndefined();
        expect(t.count).toBe(1);
    });
});

describe("R2 聚合：同源密集发生只留一条", () => {
    it("同 source + 同 message 两次 ⇒ 一条、count=2、原因取最新", () => {
        notificationStore.addToast("error", "重连失败", meta({ source: "S", reason: "第 1 次" }));
        notificationStore.addToast("error", "重连失败", meta({ source: "S", reason: "第 2 次" }));
        const list = notificationStore.toasts;
        expect(list).toHaveLength(1);
        expect(list[0]!.count).toBe(2);
        expect(list[0]!.reason).toBe("第 2 次");
    });

    it("不同 message 不聚合（两件事就两条）", () => {
        notificationStore.addToast("error", "A 失败", meta());
        notificationStore.addToast("error", "B 失败", meta());
        expect(notificationStore.toasts).toHaveLength(2);
    });

    it("aggregate:false 时即使同源同文案也逐条弹（要用户逐条确认的场景）", () => {
        notificationStore.addToast("info", "同一条", meta(), { aggregate: false });
        notificationStore.addToast("info", "同一条", meta(), { aggregate: false });
        expect(notificationStore.toasts).toHaveLength(2);
    });
});

describe("遗留清单：addToastLegacy 的条数按文件钉死（只许减少）", () => {
    /**
     * ##391 落地（2026-10-20）时的**未改造清单**：文件 → 调用点数。
     * 规则：迁移掉一处就把这里的数字改小（并同步任务 ##391 正文的清单）；
     * **不许**往上加 —— 新代码一律用 `addToast`（三段齐全）。
     */
    const LEGACY_BASELINE: Record<string, number> = {
        "App.tsx": 8,
        "store/personaStore.ts": 7,
        "components/PromptLabV4Page.tsx": 5,
        "components/ModelConfigPage.tsx": 17,
        "components/TaskRoomRoster.tsx": 4,
        "components/TaskDetailContent.tsx": 3,
        "components/TrafficLogCleanup.tsx": 1,
        "components/flow/ParamForm.tsx": 2,
        "components/CreateProjectSheet.tsx": 2,
        "components/TaskParentControls.tsx": 4,
        "components/TaskTree.tsx": 8,
        "components/RoomsPage.tsx": 7,
        "components/PersonaDrawer.tsx": 4,
        "components/ContextLabPage.tsx": 3,
        "components/SessionOverviewPage.tsx": 5,
        "components/LlmPage.tsx": 3,
        "components/CompactSessionPanel.tsx": 2,
        "components/FlowPage.tsx": 1,
        "components/CreateTaskSheet.tsx": 2,
        "components/SidebarRoom.tsx": 5,
        "components/InstancesPage.tsx": 2,
    };

    function scan(dir: string): Record<string, number> {
        const out: Record<string, number> = {};
        const walk = (d: string) => {
            for (const name of readdirSync(d)) {
                const p = join(d, name);
                if (statSync(p).isDirectory()) {
                    walk(p);
                    continue;
                }
                if (!/\.(ts|tsx)$/.test(name)) continue;
                const src = readFileSync(p, "utf8");
                // 只数**调用点**（带 notificationStore. 前缀），不算定义/注释里的名字
                const n = src.split("notificationStore.addToastLegacy(").length - 1;
                if (n > 0) out[relative(SRC, p)] = n;
            }
        };
        walk(dir);
        return out;
    }

    it("当前调用点与清单逐文件一致（迁移了就改小基线，别偷偷长回来）", () => {
        expect(scan(SRC)).toEqual(LEGACY_BASELINE);
    });

    it("总数 = 95（##391 v1 之后剩下的），且每条详情面板都如实说「未登记」", () => {
        notificationStore.addToastLegacy("error", "一条历史提示");
        const t = notificationStore.toasts[0] as Toast;
        expect(t.legacy).toBe(true);
        expect(t.source).toContain("未登记");
        expect(t.detail).toContain("##391");
        expect(Object.values(LEGACY_BASELINE).reduce((a, b) => a + b, 0)).toBe(95);
    });
});

describe("样板（验收 1）：ops 断线恢复的二级信息必须带数字与时刻", () => {
    it("恢复：说清断了几秒、哪段时间、重订几次", () => {
        const from = new Date(2026, 9, 20, 12, 31, 5).getTime();
        const to = new Date(2026, 9, 20, 12, 31, 19).getTime();
        const m = opsLiveMeta({ from, to, reconnects: 1 });
        expect(m.reason).toContain("14s");
        expect(m.reason).toContain("12:31:05 → 12:31:19");
        expect(m.reason).toContain("重订 1 次");
        expect(m.source).toContain("opsWatch");
        // 机制必须介绍「在监测什么 / 为什么会断 / 怎么恢复 / 怎么消」，而不是复述一句结论
        expect(m.detail).toContain("只有一条通道");
        expect(m.detail).toContain("1 秒");
        expect(m.detail).toContain("补发");
        expect(m.detail).toContain("轮末");
    });

    it("常驻条：原因带起点时刻与已断时长；起点缺失时如实说未知（不编时间）", () => {
        const since = new Date(2026, 9, 20, 12, 31, 5).getTime();
        const m = opsDownMeta({ since, now: since + 45_000, reconnects: 3 });
        expect(m.reason).toContain("12:31:05");
        expect(m.reason).toContain("45s");
        expect(m.reason).toContain("重订 3 次");
        const unknown = opsDownMeta({ since: null, now: since, reconnects: 0 });
        expect(unknown.reason).toContain("未知");
    });

    it("复制文本三段齐全（反馈时贴回来就能定位代码）", () => {
        const text = noticeCopyText(meta({ source: "S", reason: "R", detail: "D" }), { message: "M", when: 0 });
        expect(text).toContain("提示：M");
        expect(text).toContain("来源：S");
        expect(text).toContain("原因：R");
        expect(text).toContain("机制：");
    });

    it("时长/时刻格式（10s 以上取整秒，避免「14.3s」这种噪声）", () => {
        expect(formatDuration(14_000)).toBe("14s");
        expect(formatDuration(1_200)).toBe("1.2s");
        expect(formatDuration(83_000)).toBe("1m23s");
        expect(formatClock(new Date(2026, 9, 20, 9, 5, 3).getTime())).toBe("09:05:03");
    });
});
