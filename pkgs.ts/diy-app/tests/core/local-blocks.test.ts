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

describe("历史重建：中断 tool 的两种情形分流", () => {
    /** 用户消息 + 一个中断的 tool 块；argsInStream=false 模拟入参没吐完就断 */
    function interrupted(argsInStream: boolean): BlockStore {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "u1", kind: "text", parent: "t1", meta: { role: "user" } });
        s.apply({ op: "delta", id: "u1", fields: { content: "hi" } });
        s.apply({ op: "stop", id: "u1" });
        s.apply({
            op: "start",
            id: "call_x",
            kind: "tool",
            parent: "t1",
            meta: { tool: "bash", status: "running" },
        });
        if (argsInStream) {
            // tool-call 事件已到达 = 指令下达完毕（可能已在执行）
            s.apply({ op: "patch", id: "call_x", fields: { args: { command: "date" } } });
        } else {
            // 只在流式吐入参的中途落了几个 delta，tool-call 事件永远没来
            s.apply({ op: "delta", id: "call_x", fields: { input: '{"command": "cd /use' } });
        }
        // main 侧「新一轮开始」的收敛（写进 ops，UI 与历史同源）
        for (const op of interruptedToolPatches(s)) s.apply(op);
        return s;
    }

    it("指令不全（args 未下达）= 废弃半截消息：不投影进 LLM 历史", () => {
        const s = interrupted(false);
        const msgs = blocksToMessages(s);
        // 只剩 user —— 既不发 input:{} 的假指令，也不留配对的孤立 tool-result
        expect(msgs.map((m) => m.role)).toEqual(["user"]);
        // 但 UI 仍看得见它被截断：块树里有，且已收敛成 interrupted 终态（渲染走 toTree，不走投影）
        expect(s.blocks.get("call_x")!.status).toBe(INTERRUPTED_STATUS);
        expect(toTree(s, "t1").children.map((c) => c.id)).toContain("call_x");
    });

    it("指令已下达但没跑完：保留 call + 占位 result（防 provider 拒孤立 tool_call + 防重试）", () => {
        const s = interrupted(true);
        const msgs = blocksToMessages(s);
        expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
        const call = (msgs[1]!.content as Array<{ type: string; input: unknown }>)[0]!;
        expect(call.input).toEqual({ command: "date" }); // 不是 {}
        const value = (msgs[2]!.content as Array<{ output: { value: string } }>)[0]!.output.value;
        // 不得出现诱导重试的口号：旧文案"如有需要请重新发起"会让 agent 重启后自动重发被杀断的命令
        expect(value).toContain("已中断");
        expect(value).toContain("不要重试");
        expect(value).not.toContain("重新发起");
        // 单一来源：UI 与 request 必须同源（UI 直接 import 这个常量）
        expect(value).toBe(INTERRUPTED_TOOL_NOTICE);
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

// ─── 投递选项（压缩能力的落点）────────────────────────
//
// blocksToMessages 的 opts 是「只发部分历史 / 裁工具输出」的唯一落点。
// 关键契约：切分只按 turn（不切半轮，否则出「有 tool-call 无 result」残段被 provider 拒）。

describe("blocksToMessages 投递选项（压缩落点）", () => {
    /** 两轮：t1(用户问候 + bash 工具) / t2(用户问候) */
    function twoTurns(): BlockStore {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "t1_u", kind: "text", parent: "t1", meta: { role: "user" } });
        s.apply({ op: "delta", id: "t1_u", fields: { content: "第一轮" } });
        s.apply({ op: "stop", id: "t1_u" });
        s.apply({ op: "start", id: "t1_r", kind: "tool", parent: "t1", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "t1_r", fields: { args: { command: "ls" } } });
        s.apply({ op: "delta", id: "t1_r", fields: { output: "a\nb\nc" } });
        s.apply({ op: "patch", id: "t1_r", fields: { status: "done" } });
        s.apply({ op: "stop", id: "t1_r" });
        s.apply({ op: "stop", id: "t1" });
        s.apply({ op: "start", id: "t2", kind: "turn" });
        s.apply({ op: "start", id: "t2_u", kind: "text", parent: "t2", meta: { role: "user" } });
        s.apply({ op: "delta", id: "t2_u", fields: { content: "第二轮" } });
        s.apply({ op: "stop", id: "t2_u" });
        s.apply({ op: "stop", id: "t2" });
        return s;
    }

    it("缺省 = 全投（与历史行为完全一致）", () => {
        const m = blocksToMessages(twoTurns());
        expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "user"]);
    });

    it("sinceTurnId = 边界轮：只投该轮及其后（旧轮整棵子树不带）", () => {
        const m = blocksToMessages(twoTurns(), { sinceTurnId: "t2" });
        expect(m.map((x) => x.role)).toEqual(["user"]);
        expect((m[0]!.content as string)).toBe("第二轮");
    });

    it("sinceTurnId = null：全部清零 —— 一条都不投", () => {
        expect(blocksToMessages(twoTurns(), { sinceTurnId: null })).toEqual([]);
    });

    it("边界轮找不到：退化为全投（不让用户面对空白会话）", () => {
        const m = blocksToMessages(twoTurns(), { sinceTurnId: "tX" });
        expect(m).toHaveLength(4);
    });

    it("transformToolOutput：只作用于工具真实输出，tool-call 结构不动（配对铁律不变）", () => {
        const m = blocksToMessages(twoTurns(), {
            transformToolOutput: ({ output }) => `[裁]${output.length}`,
        });
        const tool = m.find((x) => x.role === "tool")!;
        const value = (tool.content as Array<{ output: { value: string } }>)[0]!.output.value;
        expect(value).toBe("[裁]5");
        // tool-call 仍在，且 toolCallId 未变 → call/result 仍配对
        const call = m.find((x) => x.role === "assistant")!;
        expect((call.content as Array<{ toolCallId: string }>)[0]!.toolCallId).toBe("t1_r");
    });

    it("transformToolOutput 不碰中断占位文案（契约文本不能被裁）", () => {
        const s = twoTurns();
        // 造一个中断 tool：只有 args、无 output
        s.apply({ op: "start", id: "t3", kind: "turn" });
        s.apply({ op: "start", id: "t3_r", kind: "tool", parent: "t3", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "t3_r", fields: { args: { command: "date" } } });
        s.apply({ op: "stop", id: "t3_r" });
        s.apply({ op: "stop", id: "t3" });
        const m = blocksToMessages(s, { transformToolOutput: () => "改掉了" });
        // 按 toolCallId 精确定位中断块（不能拿第一个 tool —— t1_r 是正常输出，会被裁）
        const tool = m.find(
            (x) =>
                x.role === "tool" &&
                (x.content as Array<{ toolCallId: string }>)[0]!.toolCallId === "t3_r",
        )!;
        const value = (tool.content as Array<{ output: { value: string } }>)[0]!.output.value;
        expect(value).toBe(INTERRUPTED_TOOL_NOTICE);
    });
});

describe("中断 tool 的投递恒定性（回归：收敛动作不得改变投递结果）", () => {
    /** t1 里一个 tool c1：args 已到、无 output（未收敛态） */
    function interruptedTurn(): BlockStore {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "c1", kind: "tool", parent: "t1", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "c1", fields: { args: { command: "sleep 9" } } });
        s.apply({ op: "stop", id: "c1" });
        s.apply({ op: "stop", id: "t1" });
        return s;
    }
    const valueOf = (m: ReturnType<typeof blocksToMessages>) =>
        (m.find((x) => x.role === "tool")!.content as Array<{ output: { value: string } }>)[0]!.output.value;

    it("已收敛的中断块（output 已写契约文案）仍不被裁剪 —— 否则本地补的错误信息被当历史投递", () => {
        const s = interruptedTurn();
        for (const op of interruptedToolPatches(s)) s.apply(op); // 模拟 main 的落盘收敛
        expect(valueOf(blocksToMessages(s, { transformToolOutput: () => "改掉了" }))).toBe(
            INTERRUPTED_TOOL_NOTICE,
        );
    });

    it("收敛前后投递**逐字一致**（D1「stop 即定稿」的结构前提）", () => {
        const before = blocksToMessages(interruptedTurn(), { transformToolOutput: () => "改掉了" });
        const s = interruptedTurn();
        for (const op of interruptedToolPatches(s)) s.apply(op);
        const after = blocksToMessages(s, { transformToolOutput: () => "改掉了" });
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });
});

describe("tool-result 的 origin 自证位（落盘用；真发不带）", () => {
    /** 三种来源各一条：真实输出 / 中断终态 / 跑完无输出 */
    function three(): BlockStore {
        const s = new BlockStore();
        s.apply({ op: "start", id: "t1", kind: "turn" });
        s.apply({ op: "start", id: "ok", kind: "tool", parent: "t1", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "ok", fields: { args: { command: "ls" } } });
        s.apply({ op: "delta", id: "ok", fields: { output: "a" } });
        s.apply({ op: "patch", id: "ok", fields: { status: "done" } });
        s.apply({ op: "stop", id: "ok" });
        s.apply({ op: "start", id: "int", kind: "tool", parent: "t1", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "int", fields: { args: { command: "sleep 9" } } });
        s.apply({
            op: "patch",
            id: "int",
            fields: { status: INTERRUPTED_STATUS, output: INTERRUPTED_TOOL_NOTICE },
        });
        s.apply({ op: "stop", id: "int" });
        s.apply({ op: "start", id: "emp", kind: "tool", parent: "t1", meta: { tool: "bash" } });
        s.apply({ op: "patch", id: "emp", fields: { args: { command: "true" } } });
        s.apply({ op: "patch", id: "emp", fields: { status: "done" } });
        s.apply({ op: "stop", id: "emp" });
        s.apply({ op: "stop", id: "t1" });
        return s;
    }
    const origins = (withOrigin: boolean) =>
        blocksToMessages(three(), withOrigin ? { withOrigin: true } : undefined)
            .filter((x) => x.role === "tool")
            .map((x) => (x.content as Array<{ origin?: string }>)[0]!.origin);

    it("缺省（真发）= 不写 origin，保持原生 part 形状", () => {
        expect(origins(false)).toEqual([undefined, undefined, undefined]);
    });
    it("withOrigin = 三值可程序化区分：tool / interrupted / empty", () => {
        expect(origins(true)).toEqual(["tool", "interrupted", "empty"]);
    });
});
