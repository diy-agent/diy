/**
 * render.test.ts — ProgressRenderer 单测（fake sink，isTTY 两态）
 *
 * 关键断言（190 修正 3 + 任务验收）：
 *   - 非 TTY 输出绝无 \r（管道 / 日志不被刷屏垃圾污染）
 *   - TTY 原地重绘次数 = 画过的进度段数，阶段切换换行落盘
 *   - 非 TTY 里程碑只打信息行 / 阶段切换 / done，同阶段中间刷新被抑制
 *   - waiting 心跳行两态都打；done 行带 ✓/✗ + 耗时 + 大小
 * 全离线。
 */
import { describe, it, expect } from "vitest";
import { ProgressRenderer } from "../src/ref/render";

interface FakeSink {
    writes: string[];
    write(s: string): void;
    readonly out: string;
}

function makeSink(): FakeSink {
    const writes: string[] = [];
    return {
        writes,
        write(s: string): void {
            writes.push(s);
        },
        get out(): string {
            return writes.join("");
        },
    };
}

function count(s: string, sub: string): number {
    return s.split(sub).length - 1;
}

// 一段仿 git 2.49 实测的 clone 进度（\r 分隔 + 行尾 padding）
const CLONE_STREAM =
    "Cloning into 'progtest'...\r" +
    "remote: Enumerating objects: 202, done.        \r" +
    "remote: Counting objects:  10% (21/202)        \r" +
    "remote: Counting objects: 100% (202/202), done.\r" +
    "Receiving objects:   0% (1/202)\r" +
    "Receiving objects:  50% (101/202)\r" +
    "Receiving objects: 100% (202/202), 9.08 KiB | 3.03 MiB/s, done.\n";

describe("非 TTY（管道 / 日志）", () => {
    it("输出绝无 \\r，只打里程碑行（信息 / 阶段切换 / done）", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.begin("[1/1] github.com/nodeca/js-yaml");
        r.feed(CLONE_STREAM);
        r.drain();
        r.done({ ok: true });

        const out = sink.out;
        expect(out).not.toContain("\r");
        // 信息行
        expect(out).toContain("Cloning into 'progtest'...");
        // 阶段首行（里程碑）都在
        expect(out).toContain("remote: Enumerating objects: 202, done.");
        expect(out).toContain("Receiving objects: 100% (202/202), 9.08 KiB | 3.03 MiB/s, done.");
        // 同阶段中间刷新被抑制：Counting 只剩首行 + done 行，Receiving 的 50% 不出现
        expect(count(out, "Counting objects")).toBe(2);
        expect(count(out, "Receiving objects")).toBe(2);
        expect(out).not.toContain("50% (101/202)");
        // 条目收尾行
        expect(out).toContain("✓ [1/1] github.com/nodeca/js-yaml");
        expect(out).toContain("9.08 KiB");
    });

    it("chunk 边界截断的段由缓冲拼回，不丢不裂", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.feed("Recei");
        r.feed("ving objects: 100% (1/1), done.\r");
        expect(sink.out).toBe("Receiving objects: 100% (1/1), done.\n");
    });

    it("无终止符的残留段由 drain 吐出", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.feed("Updating refs: 100% (5/5), done.");
        expect(sink.out).toBe("");
        r.drain();
        expect(sink.out).toBe("Updating refs: 100% (5/5), done.\n");
    });
});

describe("TTY（原地重绘）", () => {
    it("每个进度段一次 \\r 重绘，阶段切换换行落盘", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: true, now: () => 1000 }); // 注入时钟：耗时恒 0ms
        r.begin("[1/1] github.com/nodeca/js-yaml");
        r.feed(CLONE_STREAM);
        r.drain();
        r.done({ ok: true });

        const out = sink.out;
        // 有进度的段：Enumerating + Counting×2 + Receiving×3 = 6 次重绘（Cloning/信息行不重绘）
        expect(count(out, "\r")).toBe(6);
        // 阶段切换落盘：Enumerating、Counting 各被 flush 换行，done 收尾再换行
        // 落盘行是 trim 后的文本（padding 空格只用于原地抹除，不进日志）
        expect(out).toContain("remote: Enumerating objects: 202, done.\n");
        expect(out).toContain("remote: Counting objects: 100% (202/202), done.\n");
        // 条目行在最后
        expect(out.endsWith("✓ [1/1] github.com/nodeca/js-yaml  0ms  9.08 KiB\n")).toBe(true);
    });

    it("waiting 停滞行：先落进行中的进度行再打提示，之后可继续重绘", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: true });
        r.begin("label");
        r.feed("Receiving objects:  45% (91/202)");
        r.waiting(5000, "Receiving objects:  45% (91/202)");
        const afterWaiting = sink.out;
        expect(afterWaiting).toContain("! 已静默 5s");
        expect(afterWaiting).toContain("最后: Receiving objects:  45% (91/202)");
        // 提示行自带换行，进行中的进度行已落盘
        expect(count(afterWaiting, "\n")).toBe(3); // label + 进度行 + 提示行
        // 静默后恢复输出 → 继续原地重绘
        r.feed("Receiving objects: 100% (1/1), done.\r");
        expect(sink.out).toContain("Receiving objects: 100% (1/1), done.");
        expect(count(sink.out, "\r")).toBe(2);
    });
});

describe("waiting（两态）与 done 条目行", () => {
    it("非 TTY 也打 waiting 行且无 \\r", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.feed("Receiving objects:  45% (91/202)");
        r.waiting(2500, "Receiving objects:  45% (91/202)");
        expect(sink.out).not.toContain("\r");
        expect(sink.out).toContain("! 已静默 3s");
    });

    it("ms 级静默显示毫秒", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.waiting(180);
        expect(sink.out).toContain("! 已静默 180ms");
        expect(sink.out).toContain("（最后: (无输出)）");
    });

    it("done：注入时钟的确定耗时 + note 附加", () => {
        const sink = makeSink();
        let t = 1000;
        const r = new ProgressRenderer(sink, { isTTY: false, now: () => t });
        r.begin("[1/2] github.com/a/b");
        t = 3400;
        r.done({ ok: true, note: "tag 固定，跳过 pull" });
        expect(sink.out).toContain("✓ [1/2] github.com/a/b  2.4s  tag 固定，跳过 pull");
    });

    it("done：失败行 ✗ + 多行 fail 原样缩进", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.begin("[2/3] github.com/x/y");
        r.done({ ok: false, fail: "clone 失败: fatal: repository not found\n  详情第二行" });
        const out = sink.out;
        expect(out).toContain("✗ [2/3] github.com/x/y");
        expect(out).toContain("  clone 失败: fatal: repository not found\n");
        expect(out).toContain("    详情第二行\n");
    });

    it("done：begin 未调用时用 label 覆盖、不打耗时", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.done({ ok: false, label: "[1/3] https://bad/spec", fail: "解析失败" });
        expect(sink.out).toContain("✗ [1/3] https://bad/spec\n"); // 无耗时/大小/note 时不补空列
        expect(sink.out).not.toContain("ms");
        expect(sink.out).toContain("  解析失败\n");
    });

    it("info 普通信息行两态原样输出", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: true });
        r.info("$ git clone --progress -- https://x/y /tmp/z");
        expect(sink.out).toBe("$ git clone --progress -- https://x/y /tmp/z\n");
    });
});

describe("F1 · done noTiming：无命令执行不显示耗时列", () => {
    it("noTiming:true 时耗时列不出现，标签头行仍打", () => {
        const sink = makeSink();
        let t = 1000;
        const r = new ProgressRenderer(sink, { isTTY: false, now: () => t });
        r.begin("[1/1] github.com/nodeca/js-yaml");
        t = 1005; // 经过了 5ms，但该条目一条 git 命令都没跑
        r.done({ ok: true, note: "tag 固定，跳过 pull", noTiming: true });
        expect(sink.out).toBe(
            "[1/1] github.com/nodeca/js-yaml\n" +
                "✓ [1/1] github.com/nodeca/js-yaml  tag 固定，跳过 pull\n",
        );
    });

    it("noTiming 缺省时耗时照常显示（对照）", () => {
        const sink = makeSink();
        let t = 1000;
        const r = new ProgressRenderer(sink, { isTTY: false, now: () => t });
        r.begin("[1/2] github.com/a/b");
        t = 3400;
        r.done({ ok: true });
        expect(sink.out).toContain("✓ [1/2] github.com/a/b  2.4s");
    });
});

describe("F2 · waiting 翻倍降频", () => {
    it("首报立即，之后按静默时长翻倍（5s→10s→20s→40s），中间节流", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.feed("Receiving objects:  45% (91/202)"); // 输出活动
        r.waiting(5000); // 首报（阈值 0）
        r.waiting(10000); // ≥ 10000 → 报
        r.waiting(15000); // < 20000 → 节流
        r.waiting(20000); // ≥ 20000 → 报
        r.waiting(25000); // < 40000 → 节流
        r.waiting(30000); // 节流
        r.waiting(40000); // ≥ 40000 → 报
        expect(count(sink.out, "! 已静默")).toBe(4); // 5s/10s/20s/40s 四行，非 7 行
        expect(sink.out).not.toContain("! 已静默 15s");
        expect(sink.out).not.toContain("! 已静默 25s");
        expect(sink.out).not.toContain("! 已静默 30s");
        expect(sink.out).not.toContain("\r"); // 非 TTY 不变量
    });

    it("阈值按整秒翻倍：首报 5001ms 不把 10000ms 挤到 15s", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.waiting(5001); // 定时器漂移的首报 → 阈值 10000（不是 10002）
        r.waiting(10000); // 节拍正好落在阈值上 → 必报
        expect(count(sink.out, "! 已静默")).toBe(2);
        expect(sink.out).toContain("! 已静默 10s");
    });

    it("feed 输出活动后阈值清零、恢复下次首报", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.waiting(5000); // 首报 → 阈值 10000
        r.waiting(6000); // 节流
        expect(count(sink.out, "! 已静默")).toBe(1);
        r.feed("Receiving objects: 100% (1/1), done.\r"); // 活动（产出里程碑行）
        r.waiting(5000); // 新静默期 → 首报
        expect(count(sink.out, "! 已静默")).toBe(2);
        expect(sink.out).toContain("! 已静默 5s");
    });

    it("缓冲未完段先落盘、不受节流影响（193 既有行为保持）", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.waiting(5000); // 首报 → 阈值 10000
        // 未完段（无 \r/\n 终止符）在心跳行之前落盘可见
        r.feed("Receiving objects:  46% (92/202)");
        r.waiting(6000); // feed 已清阈值 → 本轮必报；未完段先落
        const out = sink.out;
        const pendingIdx = out.indexOf("Receiving objects:  46% (92/202)\n");
        const waitIdx = out.indexOf("! 已静默 6s");
        expect(pendingIdx).toBeGreaterThanOrEqual(0);
        expect(waitIdx).toBeGreaterThan(pendingIdx); // 未完段在心跳行之前
        expect(out).toContain("最后: Receiving objects:  46% (92/202)");
    });
});

describe("F5 · done 幂等", () => {
    it("同条目连续两次 done 只出一行（impl catch 场景）", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.begin("[1/1] github.com/a/b");
        r.done({ ok: true }); // 成功路径
        r.done({ ok: false, label: "[1/1] github.com/a/b", fail: "后续语句抛错" }); // catch 补刀
        const lines = sink.out.split("\n").filter((l) => l.startsWith("✓") || l.startsWith("✗"));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("✓ [1/1] github.com/a/b");
        expect(sink.out).not.toContain("后续语句抛错");
    });

    it("无 label 的重复 done 不打空行", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.begin("[1/1] x");
        r.done({ ok: true });
        r.done({ ok: true }); // label 已清空 → 吞
        expect(count(sink.out, "✓")).toBe(1);
        expect(sink.out).not.toContain("✓ \n");
    });

    it("不同条目 / 未 begin 的失败收尾仍照常打", () => {
        const sink = makeSink();
        const r = new ProgressRenderer(sink, { isTTY: false });
        r.begin("[1/2] github.com/a/b");
        r.done({ ok: true });
        r.done({ ok: false, label: "[2/2] bad/spec", fail: "解析失败" }); // 新条目（label 不同）
        expect(count(sink.out, "✓")).toBe(1);
        expect(count(sink.out, "✗")).toBe(1);
        expect(sink.out).toContain("解析失败");
    });
});
