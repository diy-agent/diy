// tests/core/local-blocks.test.ts
// 🎯 块协议 G —— fold 语义验证：区间即树，id 即节点

import { describe, it, expect } from "vitest";
import {
    INTERRUPTED_STATUS,
    INTERRUPTED_TOOL_NOTICE,
    interruptedToolPatches,
    BlockStore,
    replay,
    toTree,
    blocksToMessages,
    type Op,
} from "../../src/main/services/local-blocks";

/** 复刻 UI 的 leavesOf（容器递归，叶子入列）——用于验证"整轮可渲染" */
function leavesOfIds(store: BlockStore, rootId: string): string[] {
    const out: string[] = [];
    const walk = (id: string) => {
        const b = store.blocks.get(id)!;
        for (const cid of b.children) {
            const c = store.blocks.get(cid)!;
            if (c.kind === "step" || c.children.length > 0) walk(cid);
            else out.push(cid);
        }
    };
    walk(rootId);
    return out;
}

const ops = (...ops: Op[]) => {
    const s = new BlockStore();
    for (const op of ops) s.apply(op);
    return s;
};

describe("start/stop 区间与 parent", () => {
    it("缺省 parent = 当前最深打开节点（配对糖）", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "s1", kind: "step" },
            { op: "start", id: "a1", kind: "text" },
            { op: "stop", id: "a1" },
            { op: "stop", id: "s1" },
            { op: "stop", id: "t1" },
        );
        const tree = toTree(s, "t1");
        expect(tree.children[0]!.children[0]!.id).toBe("a1");
        expect(s.roots().map((r) => r.id)).toEqual(["t1"]);
    });

    it("显式 parent 可指向任意更早打开的块", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "s1", kind: "step", parent: "t1" },
            { op: "start", id: "e1", kind: "error", parent: "t1" }, // 挂在 turn 而非 step
        );
        const tree = toTree(s, "t1");
        expect(tree.children.map((c) => c.id)).toEqual(["s1", "e1"]);
    });

    it("允许交叉闭合（并行子树）", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "x1", kind: "tool", parent: "t1" },
            { op: "start", id: "x2", kind: "tool", parent: "t1" },
            { op: "delta", id: "x1", fields: { output: "a" } },
            { op: "delta", id: "x2", fields: { output: "b" } },
            { op: "stop", id: "x2" },
            { op: "stop", id: "x1" },
        );
        const b1 = s.blocks.get("x1")!;
        const b2 = s.blocks.get("x2")!;
        expect(b1.stopped).toBe(true);
        expect(b2.stopped).toBe(true);
        expect(b1.children).toEqual([]);
        // 交叉不产生父子（都是显式 parent=t1）
        expect(s.blocks.get("t1")!.children).toEqual(["x1", "x2"]);
    });

    it("未闭合块 = stopped false（toTree 标 interrupted，崩溃现场免费得到）", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "r1", kind: "think", parent: "t1" }, // 无 stop
        );
        const tree = toTree(s, "t1");
        expect(tree.children[0]!.attrs.interrupted).toBe(true);
        expect(tree.attrs.interrupted).toBe(true);
    });

    it("stop 未知块 / 重复 start 记 issue 不抛异常", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1", kind: "turn" },
            { op: "stop", id: "nope" },
        );
        expect(s.issues.length).toBe(2);
    });
});

describe("delta/patch 合并语义", () => {
    it("Text 字段 delta 累加，patch 整段重写", () => {
        const s = ops(
            { op: "start", id: "r1", kind: "think" },
            { op: "delta", id: "r1", fields: { content: "你好" } },
            { op: "delta", id: "r1", fields: { content: "，世界" } },
        );
        expect(s.blocks.get("r1")!.content).toBe("你好，世界");
        s.apply({ op: "patch", id: "r1", fields: { content: "重写" } });
        expect(s.blocks.get("r1")!.content).toBe("重写");
    });

    it("Flag 字段拒绝 delta（记 issue 并忽略）", () => {
        const s = ops({
            op: "start",
            id: "x1",
            kind: "tool",
            meta: { tool: "bash", status: "running" },
        });
        s.apply({ op: "delta", id: "x1", fields: { status: "done" } });
        expect(s.blocks.get("x1")!.status).toBe("running");
        expect(s.issues.some((i) => i.reason.includes("Flag"))).toBe(true);
    });

    it("List 字段 delta push；值为数组时逐元素追加", () => {
        const s = ops(
            { op: "start", id: "p1", kind: "plan" },
            { op: "delta", id: "p1", fields: { items: "做 A" } },
            { op: "delta", id: "p1", fields: { items: ["做 B", "做 C"] } },
        );
        expect(s.blocks.get("p1")!.items).toEqual(["做 A", "做 B", "做 C"]);
    });

    it("嵌套路径 patch（usage.in）与未知字段前向兼容（delta 降级 patch）", () => {
        const s = ops({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "patch", id: "t1", fields: { "usage.in": 10 } });
        expect((s.blocks.get("t1")!.usage as Record<string, unknown>).in).toBe(10);
        s.apply({ op: "delta", id: "t1", fields: { futureField: "x" } });
        expect(s.issues.some((i) => i.reason.includes("未知字段"))).toBe(true);
        expect(s.blocks.get("t1")!.futureField).toBe("x");
    });
});

describe("replay 与 blocksToMessages", () => {
    it("op 日志重放 = 同构块树", () => {
        const seq: Op[] = [
            { op: "start", id: "t1", kind: "turn", meta: { model: "mimo-v2.5" } },
            { op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user" } },
            { op: "delta", id: "u1", fields: { content: "几点了" } },
            { op: "stop", id: "u1" },
            { op: "start", id: "s1", kind: "step", parent: "t1" },
            { op: "start", id: "call_1", kind: "tool", parent: "s1", meta: { tool: "bash" } },
            {
                op: "patch",
                id: "call_1",
                fields: { args: { command: "date" }, status: "running", title: "date" },
            },
            { op: "delta", id: "call_1", fields: { output: "20:30" } },
            { op: "patch", id: "call_1", fields: { status: "done" } },
            { op: "stop", id: "call_1" },
            { op: "stop", id: "s1" },
            { op: "stop", id: "t1" },
        ];
        const s = replay(seq);
        expect(s.issues).toEqual([]);
        expect(toTree(s, "t1").attrs.model).toBe("mimo-v2.5");
    });

    it("块树重建 ModelMessage[]：工具链路含 callId 与结果", () => {
        const seq: Op[] = [
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user" } },
            { op: "delta", id: "u1", fields: { content: "hi" } },
            { op: "stop", id: "u1" },
            { op: "start", id: "r1", kind: "think", parent: "t1" },
            { op: "delta", id: "r1", fields: { content: "想想" } },
            { op: "stop", id: "r1" },
            { op: "start", id: "call_1", kind: "tool", parent: "t1", meta: { tool: "bash" } },
            { op: "patch", id: "call_1", fields: { args: { command: "date" }, status: "running" } },
            { op: "delta", id: "call_1", fields: { output: "20:30" } },
            { op: "patch", id: "call_1", fields: { status: "done" } },
            { op: "stop", id: "call_1" },
            { op: "start", id: "a1", kind: "text", parent: "t1", meta: { role: "assistant" } },
            { op: "delta", id: "a1", fields: { content: "现在 20:30" } },
            { op: "stop", id: "a1" },
            { op: "stop", id: "t1" },
        ];
        const msgs = blocksToMessages(replay(seq));
        expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        const tool = msgs[2]!;
        expect(Array.isArray(tool.content)).toBe(true);
        expect((tool.content as Array<{ type: string; toolCallId?: string }>)[0]!.toolCallId).toBe(
            "call_1",
        );
    });
});

describe("收尾幂等（服务端 finally 补 close 的安全网）", () => {
  it("重复 stop 不记 issue、不抛异常", () => {
    const s = new BlockStore();
    s.apply({ op: "start", id: "t1", kind: "turn" });
    s.apply({ op: "stop", id: "t1" });
    s.apply({ op: "stop", id: "t1" });
    expect(s.issues).toEqual([]);
    expect(s.blocks.get("t1")!.stopped).toBe(true);
  });
});

describe("touched 序号（turn 内当前进度）", () => {
    it("按 op 到达序单调递增；未 stop 块中 touched 最大者即当前进度", () => {
        const s = new BlockStore();
        const t = "t1";
        s.apply({ op: "start", id: t, kind: "turn" });
        s.apply({ op: "start", id: "r1", kind: "think", parent: t });
        s.apply({ op: "delta", id: "r1", fields: { content: "想想" } });
        s.apply({ op: "start", id: "x1", kind: "tool", parent: t });
        const live = [...s.blocks.values()].filter((b) => !b.stopped && (b.kind === "think" || b.kind === "tool"));
        expect(live.length).toBe(2);
        const top = live.reduce((a, b) => (b.touched > a.touched ? b : a));
        expect(top.id).toBe("x1");
        // 定稿后 touched 仍保留最后顺序（预览回退首行不依赖它）
        s.apply({ op: "stop", id: "x1" });
        expect(s.blocks.get("x1")!.touched).toBeGreaterThan(s.blocks.get("r1")!.touched);
    });
});

describe("历史重建的配对铁律", () => {
    it("中断未完成的 tool 也合成占位 tool-result（防下一轮 provider 拒孤立 tool_call）", () => {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user" } });
        s.apply({ op: "delta", id: "u1", fields: { content: "hi" } });
        s.apply({ op: "stop", id: "u1" });
        s.apply({ op: "start", id: "call_x", kind: "tool", parent: "t1", meta: { tool: "bash", status: "running" } });
        const msgs = blocksToMessages(s);
        const roles = msgs.map((m) => m.role);
        expect(roles).toEqual(["user", "assistant", "tool"]);
        const toolMsg = msgs[2]!;
        const part = (toolMsg.content as Array<{ output: { value: string } }>)[0]!;
        expect(part.output.value).toContain("已中断");
        // 不得出现诱导重试的口号：旧文案"如有需要请重新发起"会让 agent 重启后自动重发被杀断的命令
        expect(part.output.value).toContain("不要重试");
        expect(part.output.value).not.toContain("重新发起");
        // 单一来源：UI 与 request 必须同源（UI 直接 import 这个常量）
        expect(part.output.value).toBe(INTERRUPTED_TOOL_NOTICE);
    });
});

describe("turn 顶层不变式（被打断后不能嵌套）", () => {
    it("上一轮 tool 未闭合时，下一轮 turn 仍是根（否则 UI 只渲染 root turn，整轮消失）", () => {
        const s = ops(
            { op: "start", id: "t1", kind: "turn" },
            { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
            { op: "start", id: "call_1", kind: "tool", parent: "t1_s1", meta: { tool: "bash", status: "running" } },
            // 这里被打断：call_1 / t1_s1 / t1 都没有 stop
            { op: "start", id: "t2", kind: "turn" },
            { op: "start", id: "t2_u", kind: "text", parent: "t2", meta: { role: "user" } },
            { op: "delta", id: "t2_u", fields: { content: "新的一轮" } },
            { op: "stop", id: "t2_u" },
        );
        const roots = s.roots().filter((b) => b.kind === "turn").map((b) => b.id);
        expect(roots).toEqual(["t1", "t2"]);
        // 旧日志兼容：重放时按新规则折叠，嵌套 turn 自动回到根
        expect(s.blocks.get("t2")!.parent).toBeUndefined();
        // 新 turn 的正文必须能作为叶子被取到（UI 渲染路径）
        expect(leavesOfIds(s, "t2")).toEqual(["t2_u"]);
    });
});

describe("中断 tool 的显式终态收敛（防止重载后重复发起）", () => {
    const seq = (): Op[] => [
        { op: "start", id: "t1", kind: "turn" },
        { op: "start", id: "t1_s1", kind: "step", parent: "t1" },
        { op: "start", id: "call_kill", kind: "tool", parent: "t1_s1",
          meta: { tool: "bash", args: { command: "pkill -9 -f electron" }, status: "running" } },
        // 到这里进程被 SIGKILL：call_kill / t1_s1 / t1 全部没收到 stop
    ];

    it("收敛出 patch+stop，且文案不含任何『重试』诱导", () => {
        const s = ops(...seq());
        const patches = interruptedToolPatches(s);
        expect(patches).toHaveLength(2);
        expect(patches[0]).toMatchObject({ op: "patch", id: "call_kill",
            fields: { status: INTERRUPTED_STATUS, output: INTERRUPTED_TOOL_NOTICE } });
        expect(patches[1]).toMatchObject({ op: "stop", id: "call_kill" });
        expect(INTERRUPTED_TOOL_NOTICE).not.toContain("重新发起");
        expect(INTERRUPTED_TOOL_NOTICE).toContain("不要重试");
    });

    it("幂等：收敛后再次调用不重复产出（重载会话不会反复写入）", () => {
        const s = ops(...seq());
        for (const op of interruptedToolPatches(s)) s.apply(op);
        expect(interruptedToolPatches(s)).toEqual([]);
    });

    it("收敛后投影是纯翻译：直接用块自己的 output，不再现场造文案", () => {
        const s = ops(...seq());
        for (const op of interruptedToolPatches(s)) s.apply(op);
        const msgs = blocksToMessages(s);
        const toolMsg = msgs.find((m) => m.role === "tool")!;
        const value = (toolMsg.content as Array<{ output: { value: string } }>)[0]!.output.value;
        expect(value).toBe(INTERRUPTED_TOOL_NOTICE);
        expect(value).not.toContain("重新发起");
    });
});
