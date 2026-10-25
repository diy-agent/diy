// 归属闸（##408 刀 22）—— 判据的唯一性靠这里钉住：
// kill / killPid / detach 三条路径都调同一个 `fenceTaskOwner`，
// 所以「什么算归属一致」「什么必须拒」只在这一个文件里被定义一次。
import { describe, expect, it } from "vitest";
import { fenceTaskOwner } from "../../src/shared/job-fence";

const A = "projects/4/tasks/408";
const B = "projects/1/tasks/6";

describe("fenceTaskOwner：动手前必须声明归属，声明必须与记录一致", () => {
    it("声明了且与记录一致 ⇒ 放行", () => {
        expect(fenceTaskOwner(A, A, "run r-1")).toEqual({ ok: true });
    });

    it("前后空白不算不同任务（CLI 手输常见）", () => {
        expect(fenceTaskOwner(` ${A} `, A, "run r-1")).toEqual({ ok: true });
    });

    it("没声明 ⇒ 拒 `agent/job-task-required`（可选参数等于没有闸）", () => {
        for (const declared of [undefined, null, "", "   "]) {
            const r = fenceTaskOwner(declared, A, "run r-1");
            expect(r.ok).toBe(false);
            expect(r).toMatchObject({ code: "agent/job-task-required" });
        }
    });

    it("归属证明不出来 ⇒ 拒 `agent/job-owner-unknown`（宁可不杀，也不凭 pid 发信号）", () => {
        for (const owner of [undefined, null, "", "  "]) {
            const r = fenceTaskOwner(A, owner, "进程 1234");
            expect(r.ok).toBe(false);
            expect(r).toMatchObject({ code: "agent/job-owner-unknown" });
        }
    });

    it("跨任务 ⇒ 拒 `agent/job-foreign`，且消息里两个任务都点名（能照着改）", () => {
        const r = fenceTaskOwner(B, A, "run r-1");
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error("unreachable");
        expect(r.code).toBe("agent/job-foreign");
        expect(r.msg).toContain(A);
        expect(r.msg).toContain(B);
    });

    it("缺声明优先于归属不明（先把调用方的问题说清楚）", () => {
        const r = fenceTaskOwner("", null, "进程 1");
        expect(r).toMatchObject({ ok: false, code: "agent/job-task-required" });
    });
});
