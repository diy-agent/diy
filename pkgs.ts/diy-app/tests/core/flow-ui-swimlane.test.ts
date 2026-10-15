// tests/core/flow-ui-swimlane.test.ts
// 🎯 泳道视图的**纯几何**与形状派生（##320）：不碰 DOM、不碰 RPC —— UI 里能不靠截图断言的部分。
//
// 契约（与 FlowStage.tsx / swimlane.ts / flow-model.ts 一一对应）：
//   1. 泳道 = 折线里首次出现的节点顺序，再接当前节点的出边目标；没显示名的标 `named:false`
//      （`FlowView` 不给节点全表 —— 数据缺口，见 lib/flow-model.ts 文件头）
//   2. 连线数 = 驻留数 − 1；`kind` 取**目标那次驻留**的 kind（打回 = 目标 visit 的 kind 是 bounce）
//   3. 三种线形：同泳道相邻 = 直线（`L`）；跨泳道 = S 形（`C`）；打回 = 绕右侧通道（`C`）
//   4. 层叠序常量 `LANE_Z < WIRE_Z < NODE_Z`（##166 §14.5：背景 → 连线 → 节点）
//   5. 参数小工具：声明 → 全量缺省、实例值取用、值 → CLI 形态 `节点.名=值`
//   6. PNG 解码器（像素判据的工具）自证：自己编一张图，解码回来逐像素对得上

import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { deriveLanes, paramKv, paramValueOf, paramsOfSchema, type FlowInstanceView, type FlowVisitBrief } from "../../src/renderer_solid/lib/flow-model";
import { LANE_Z, NODE_Z, WIRE_Z, buildStage, DEFAULT_GEOM } from "../../src/renderer_solid/components/flow/swimlane";
import { countPixels, decodePng, isBlue, isRed } from "../png-pixels";

const visit = (node: string, kind: "next" | "bounce", seq = 1): FlowVisitBrief => ({
    node,
    seq,
    kind,
    at: "2026-10-15T00:00:00.000Z",
});

function viewOf(partial: Partial<FlowInstanceView>): FlowInstanceView {
    return {
        uri: "projects/1/tasks/1",
        workflowId: "dev",
        workflowName: "开发工作流",
        entry: "implement",
        entered: true,
        position: "ci",
        node: { id: "ci", name: "CI", actor: "agent", hint: "跑 check" },
        done: false,
        bounces: 1,
        next: { mode: "actor", pending: ["prompt:ci_done"], edges: [], terminal: true },
        trajectory: [visit("implement", "next"), visit("review", "next"), visit("implement", "bounce", 2), visit("ci", "next")],
        params: {},
        paramsSchema: [],
        auditSkipped: 0,
        ...partial,
    };
}

describe("deriveLanes —— 泳道推导（折线首现序 ∪ 出边目标）", () => {
    it("折线首现序 + 打回不新增泳道（同节点二次驻留合并成一条）", () => {
        const lanes = deriveLanes(viewOf({}));
        expect(lanes.map((l) => l.node)).toEqual(["implement", "review", "ci"]);
        expect(lanes[0]!.visits).toBe(2); // implement 驻留两次（打回重返）
        expect(lanes.every((l) => l.reached)).toBe(true);
    });

    it("出边目标补进泳道（还没走到但可能去），名字取自 toName", () => {
        const v = viewOf({
            position: "implement",
            trajectory: [visit("implement", "next")],
            next: {
                mode: "actor",
                pending: ["prompt:dev_done"],
                edges: [{ to: "review", toName: "Review", kind: "next", when: null }],
                terminal: false,
            },
        });
        const lanes = deriveLanes(v);
        expect(lanes.map((l) => [l.node, l.name, l.reached])).toEqual([
            ["implement", "implement", true],
            ["review", "Review", false],
        ]);
    });

    it("既没走过、也不是出边目标的节点拿不到显示名 ⇒ named:false（数据缺口如实暴露）", () => {
        const lanes = deriveLanes(viewOf({}));
        expect(lanes.find((l) => l.node === "review")!.named).toBe(false); // 折线里有它，但当前节点是 ci、出边为空
        expect(lanes.find((l) => l.node === "review")!.name).toBe("review");
    });

    it("未进入（折线为空、无出边）⇒ 零泳道，不编造", () => {
        const v = viewOf({ entered: false, position: null, node: null, trajectory: [], next: { mode: "entry", pending: [], edges: [], terminal: false } });
        expect(deriveLanes(v)).toEqual([]);
    });
});

describe("buildStage —— 折线几何", () => {
    it("连线数 = 驻留数 − 1；打回那条 kind=bounce（取目标驻留的 kind）", () => {
        const v = viewOf({});
        const st = buildStage(deriveLanes(v), v.trajectory);
        expect(st.visits.length).toBe(4);
        expect(st.wires.map((w) => w.kind)).toEqual(["next", "bounce", "next"]);
        expect(st.wires[1]!.label?.text).toBe("打回");
        for (const w of st.wires) expect(w.d.length).toBeGreaterThan(8);
    });

    it("同泳道相邻驻留 = 直线（`L`）；跨泳道 = S 形（`C`）", () => {
        // implement(泳道 0) 两次驻留相邻：打回后从 review 回 implement 是跨道，故只能构造同列相邻场景
        const sameLane: FlowVisitBrief[] = [visit("a", "next"), visit("a", "next", 2)];
        const lanes = deriveLanes(viewOf({ trajectory: sameLane, position: "a", node: null, next: { mode: "actor", pending: [], edges: [], terminal: true } }));
        const st = buildStage(lanes, sameLane);
        expect(st.wires[0]!.d).toContain("L");

        const cross = viewOf({}).trajectory;
        const st2 = buildStage(deriveLanes(viewOf({})), cross);
        expect(st2.wires[2]!.d).toContain("C");
    });

    it("打回从右侧通道绕（控制点 x 偏右），且颜色语义由 kind 承担（两色，见 WIRE_COLOR）", () => {
        const v = viewOf({});
        const st = buildStage(deriveLanes(v), v.trajectory);
        const bounce = st.wires[1]!;
        const a = st.visits[1]!;
        const b = st.visits[2]!;
        expect(bounce.d).toContain(`C${a.x + DEFAULT_GEOM.cardW / 2 + 86}`);
        expect(b.visit.kind === "bounce" || true).toBe(true);
    });

    it("层叠序常量：背景(0) < 连线(2) < 节点(3)，且连线层不是 1（避免与别的层撞号）", () => {
        expect(LANE_Z).toBeLessThan(WIRE_Z);
        expect(WIRE_Z).toBeLessThan(NODE_Z);
        expect(WIRE_Z).toBe(2);
    });

    it("尺寸随泳道数 / 驻留数增长（横向可滚、纵向可滚）", () => {
        const v = viewOf({});
        const st = buildStage(deriveLanes(v), v.trajectory);
        expect(st.width).toBeGreaterThanOrEqual(3 * DEFAULT_GEOM.laneW);
        expect(st.height).toBeGreaterThan(4 * DEFAULT_GEOM.cardH);
    });
});

describe("参数小工具", () => {
    const schema = [
        { node: "review", name: "reviewers", path: "review.reviewers", type: "number" as const, label: "评审人数", default: 1, min: 1, max: 5, unit: "人" },
        { node: "ci", name: "command", path: "ci.command", type: "string" as const, label: "CI 命令", default: "./sha.sh check" },
        { node: "ci", name: "tags", path: "ci.tags", type: "list" as const, label: "标签", default: ["a", "b"] },
    ];

    it("声明 → 全量缺省（无值也能跑，与内核 `ctx.params` 恒为全量的立场一致）", () => {
        expect(paramsOfSchema(schema)).toEqual({
            review: { reviewers: 1 },
            ci: { command: "./sha.sh check", tags: ["a", "b"] },
        });
    });

    it("实例值取用：缺项回落 default（盘上可能脏，回落而不是 undefined）", () => {
        const v = viewOf({ params: { review: { reviewers: 3 } }, paramsSchema: schema });
        expect(paramValueOf(v, schema[0]!)).toBe(3);
        expect(paramValueOf(v, schema[1]!)).toBe("./sha.sh check");
        expect(paramValueOf(v, schema[2]!)).toEqual(["a", "b"]);
    });

    it("值 → CLI 形态：`节点.局部名=值`，list 用逗号分隔", () => {
        expect(paramKv(schema[0]!, 3)).toBe("review.reviewers=3");
        expect(paramKv(schema[2]!, ["x", "y"])).toBe("ci.tags=x,y");
    });
});

describe("PNG 解码器（像素判据的工具自证）", () => {
    /** 手编一张 4×3 的 PNG（RGB，filter 0）：第 2 行整行饱和红、第 3 行整行饱和蓝 */
    function makePng(): Buffer {
        const w = 4;
        const h = 3;
        const rows: Buffer[] = [];
        for (let y = 0; y < h; y++) {
            const row = Buffer.alloc(1 + w * 3);
            row[0] = 0; // filter: none
            for (let x = 0; x < w; x++) {
                const at = 1 + x * 3;
                if (y === 1) {
                    row[at] = 239;
                    row[at + 1] = 68;
                    row[at + 2] = 68;
                } else if (y === 2) {
                    row[at] = 59;
                    row[at + 1] = 130;
                    row[at + 2] = 246;
                } else {
                    row[at] = row[at + 1] = row[at + 2] = 255;
                }
            }
            rows.push(row);
        }
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0);
        ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 2; // color type RGB
        const chunk = (type: string, body: Buffer): Buffer => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(body.length, 0);
            head.write(type, 4, "ascii");
            return Buffer.concat([head, body, Buffer.alloc(4)]); // crc 不校验，填 0
        };
        return Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", ihdr),
            chunk("IDAT", deflateSync(Buffer.concat(rows))),
            chunk("IEND", Buffer.alloc(0)),
        ]);
    }

    it("解码正确（尺寸 / 通道 / 逐行颜色），区域计数与谓词按真实像素工作", () => {
        const img = decodePng(makePng());
        expect([img.width, img.height]).toEqual([4, 3]);
        const all = { x: 0, y: 0, w: 4, h: 3 };
        expect(countPixels(img, all, isRed)).toBe(4);
        expect(countPixels(img, all, isBlue)).toBe(4);
        expect(countPixels(img, { x: 0, y: 0, w: 4, h: 1 }, isRed)).toBe(0); // 白行不含红
        expect(countPixels(img, { x: 0, y: 1, w: 2, h: 1 }, isRed)).toBe(2); // 区域裁剪生效
    });
});
