// tests/core/chat-text.test.ts — 大文本窗口化取行（##93）
//
// 判据只有一条主线：**窗口化后的输出必须与「对全文 split 一遍」的朴素实现逐字一致**
// （`firstLine` / `lastLine` / `previewLines` / `clampLines` 四个）。这条不能用"看着差不多"
// 顶 —— 摘要/预览/折叠全是用户直接读的文本，少一个字或多一个字都是回归。
//
// 第二条：**下界不许冒充精确值**。窗口数不出总行数时 `exact=false`，且
// `total` / `omitted` 只能是真值的下界（宁可写「至少省略 N 行」），不许静默给错数。
//
// 性能本身不钉在这里（数字随机器漂），钉在任务 body 的实测表 + bench 脚本上。
import { describe, expect, it } from "vitest";
import {
    HEAD_WINDOW,
    TAIL_WINDOW,
    clampLines,
    countLines,
    firstLine,
    lastLine,
    previewLines,
} from "../../src/renderer_solid/lib/chat-text";

// ─── 朴素参照实现（= 改造前的写法，语义真源）─────────────────

const naiveFirst = (s: string, max = 90): string => {
    for (const line of s.split("\n")) {
        const t = line.trim();
        if (t) return t.slice(0, max);
    }
    return "";
};

const naiveLast = (s: string, max = 90): string => {
    const lines = s.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i]!.trim();
        if (t) return t.length > max ? `${t.slice(0, max)}…` : t;
    }
    return "";
};

const naivePreview = (text: string, head = 20, tail = 30) => {
    const lines = text.split("\n");
    if (lines.length <= head + tail) return { text, omitted: 0, total: lines.length };
    const omitted = lines.length - head - tail;
    return {
        text: [...lines.slice(0, head), `… 省略 ${omitted} 行 …`, ...lines.slice(-tail)].join("\n"),
        omitted,
        total: lines.length,
    };
};

const naiveClamp = (text: string, n: number) => {
    const lines = text.split("\n");
    let start = 0;
    while (start < lines.length && lines[start]!.trim() === "") start++;
    const kept = lines.slice(start);
    if (kept.length <= n) return { text: kept.join("\n"), omitted: 0 };
    return { text: kept.slice(0, n).join("\n"), omitted: kept.length - n };
};

// ─── 样本 ─────────────────────────────────────────────────

/** 确定性伪随机（不引依赖；同 seed 同序列，失败可复现） */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

const PIECES = [
    "a",
    "bb",
    "  前导空格",
    "\n",
    "\n\n",
    " \n\t\n",
    "\r\n",
    "x".repeat(120),
    "y".repeat(HEAD_WINDOW + 10), // 单行比头窗口还长
    "z".repeat(TAIL_WINDOW + 10), // 单行比尾窗口还长
    "行" + " ".repeat(200) + "尾",
];

function randomText(seed: number, pieces: number): string {
    const r = rng(seed);
    let out = "";
    for (let i = 0; i < pieces; i++) out += PIECES[Math.floor(r() * PIECES.length)]!;
    return out;
}

// ─── countLines ──────────────────────────────────────────

describe('countLines：与 split("\\n").length 同口径', () => {
    it("空串 / 无换行 / 尾随换行", () => {
        expect(countLines("")).toBe(1);
        expect(countLines("abc")).toBe(1);
        expect(countLines("a\nb")).toBe(2);
        expect(countLines("a\n")).toBe(2);
        expect(countLines("\n\n\n")).toBe(4);
    });

    it("随机样本与 split 一致", () => {
        for (let seed = 1; seed <= 20; seed++) {
            const t = randomText(seed, 30);
            expect(countLines(t)).toBe(t.split("\n").length);
        }
    });

    it("大文本（≈3.28 M）", () => {
        const t = "x".repeat(3_280_000) + "\n" + "y".repeat(40) + "\n";
        expect(countLines(t)).toBe(3);
    });
});

// ─── firstLine / lastLine ─────────────────────────────────

describe("firstLine：第一行非空内容（窗口化后逐字一致）", () => {
    it("跳过前导空行（模型的 reasoning 常以 \\n 开头）", () => {
        expect(firstLine("\n\n  想一下  \n第二行")).toBe("想一下");
        expect(firstLine("")).toBe("");
        expect(firstLine("\n \n\t")).toBe("");
    });

    it("截到 90 字", () => {
        expect(firstLine("a".repeat(200))).toBe("a".repeat(90));
        expect(firstLine("\n" + "字".repeat(200))).toBe("字".repeat(90));
    });

    it("随机样本与朴素实现一致", () => {
        for (let seed = 1; seed <= 40; seed++) {
            const t = randomText(seed, 12);
            expect(firstLine(t), `seed=${seed}`).toBe(naiveFirst(t));
        }
    });

    it("窗口外才有内容 / 超长单行：语义不变", () => {
        // 前 4 KB 全是空行，正文在窗口之后（极端但必须一致）
        const t = " ".repeat(HEAD_WINDOW + 100) + "\n" + "正文在这里";
        expect(firstLine(t)).toBe(naiveFirst(t));
        // 一行 3.28 M 字符：只取前 90 字，不 flatten 全文
        const big = "长".repeat(3_280_000);
        expect(firstLine(big)).toBe("长".repeat(90));
    });
});

describe("lastLine：最后一行非空（意图末行）", () => {
    it("尾随空行跳过；超长行加省略号", () => {
        expect(lastLine("a\nb\n\n")).toBe("b");
        expect(lastLine("a\n" + "z".repeat(200))).toBe("z".repeat(90) + "…");
        expect(lastLine("")).toBe("");
    });

    it("随机样本与朴素实现一致", () => {
        for (let seed = 1; seed <= 40; seed++) {
            const t = randomText(seed, 12);
            expect(lastLine(t), `seed=${seed}`).toBe(naiveLast(t));
        }
    });

    it("超长单行（比尾窗口还长）：截断取行首那段而不是行尾", () => {
        const big = "长".repeat(3_280_000);
        expect(lastLine(big)).toBe("长".repeat(90) + "…");
    });
});

// ─── previewLines ────────────────────────────────────────

describe("previewLines：前 20 + 后 30 行", () => {
    it("短文本原样返回", () => {
        expect(previewLines("a\nb")).toEqual({ text: "a\nb", omitted: 0, total: 2, exact: true });
    });

    it("超预算：首尾行 + 省略标记", () => {
        const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
        const p = previewLines(text);
        expect(p.total).toBe(100);
        expect(p.omitted).toBe(50);
        expect(p.exact).toBe(true);
        expect(p.text.split("\n")[0]).toBe("L0");
        expect(p.text.split("\n")[20]).toBe("… 省略 50 行 …");
        expect(p.text.split("\n").at(-1)).toBe("L99");
    });

    it("随机样本与朴素实现一致（含超长行）", () => {
        for (let seed = 1; seed <= 40; seed++) {
            const t = randomText(seed, 20);
            // 精确等价用「显式给 total」验（不给 total 时下界口径单列，见下一条用例）
            const got = previewLines(t, 20, 30, countLines(t));
            const want = naivePreview(t);
            expect({ text: got.text, omitted: got.omitted, total: got.total }, `seed=${seed}`).toEqual(want);
            expect(got.exact).toBe(true);
        }
    });

    it("大文本：给 total（精确）时与朴素实现一致", () => {
        const text = Array.from({ length: 5000 }, (_, i) => `行${i} ${"x".repeat(700)}`).join("\n");
        const got = previewLines(text, 20, 30, countLines(text));
        expect({ text: got.text, omitted: got.omitted, total: got.total }).toEqual(naivePreview(text));
        expect(got.exact).toBe(true);
    });

    it("大文本（短行）：不给 total 时是**下界**（不冒充精确），且仍然裁断", () => {
        // 短行 ⇒ 头窗口里几千行，下界足够判「截断」，不必数全文
        const text = Array.from({ length: 5000 }, (_, i) => `行${i}`).join("\n");
        const got = previewLines(text);
        const real = naivePreview(text);
        expect(got.exact).toBe(false);
        // 下界：只能说"至少省略这么多"，不许超出真值
        expect(got.total).toBeLessThanOrEqual(real.total);
        expect(got.omitted).toBeLessThanOrEqual(real.omitted);
        expect(got.omitted).toBeGreaterThan(0);
        expect(got.text).toContain(`至少省略 ${got.omitted} 行`);
        // 首尾行仍然对（这才是用户读到的）
        const gotLines = got.text.split("\n");
        expect(gotLines.slice(0, 20)).toEqual(real.text.split("\n").slice(0, 20));
        expect(gotLines.slice(-30)).toEqual(real.text.split("\n").slice(-30));
    });

    it("行少但行长（一行 3 MB）：窗口判不出来 → 数一次拿精确值，不裁", () => {
        const text = "x".repeat(3_280_000);
        const got = previewLines(text);
        expect(got.text).toBe(text);
        expect(got.omitted).toBe(0);
        expect(got.total).toBe(1);
        expect(got.exact).toBe(true);
    });

    it("长行且行多（下界判不出来）：退化成数一次，数字精确", () => {
        const text = Array.from({ length: 5000 }, (_, i) => `行${i} ${"x".repeat(700)}`).join("\n");
        const got = previewLines(text);
        expect({ text: got.text, omitted: got.omitted, total: got.total }).toEqual(naivePreview(text));
        expect(got.exact).toBe(true);
    });
});

// ─── clampLines ──────────────────────────────────────────

describe("clampLines：按行截断（前导空行不占额度）", () => {
    it("判据与旧用例同源（chat-fold.test.ts 的那几条平移过来）", () => {
        expect(clampLines("a\nb", 3)).toMatchObject({ text: "a\nb", omitted: 0 });
        expect(clampLines("a\nb\nc\nd", 2)).toMatchObject({ text: "a\nb", omitted: 2 });
        expect(clampLines("```\nx=1\n```\ntail", 3).text).toBe("```\nx=1\n```");
        expect(clampLines("\n\n正文", 2)).toMatchObject({ text: "正文", omitted: 0 });
        expect(clampLines("\n\n一行\n二行\n三行", 2)).toMatchObject({ text: "一行\n二行", omitted: 1 });
        expect(clampLines("\n\n一行\n二行\n三行", 3)).toMatchObject({ text: "一行\n二行\n三行", omitted: 0 });
        expect(clampLines("\n\n一行\n二行\n三行\n四行", 3)).toMatchObject({ text: "一行\n二行\n三行", omitted: 1 });
    });

    it("短文本的 omitted 是精确值（不是下界）", () => {
        expect(clampLines("a\nb\nc\nd", 2).exact).toBe(true);
    });

    it("随机样本与朴素实现一致（含超长行 / 前导空行）", () => {
        for (let seed = 1; seed <= 40; seed++) {
            const t = randomText(seed, 14);
            for (const n of [1, 2, 3, 5]) {
                const got = clampLines(t, n);
                const want = naiveClamp(t, n);
                // 裁出来的文本必须逐字一致（这是用户读到的）
                expect(got.text, `seed=${seed} n=${n}`).toBe(want.text);
                if (got.exact) {
                    expect(got.omitted, `seed=${seed} n=${n}`).toBe(want.omitted);
                } else {
                    // 下界：不许超出真值，也不能把「被藏了内容」说成 0
                    expect(got.omitted, `seed=${seed} n=${n}`).toBeLessThanOrEqual(want.omitted);
                    expect(got.omitted).toBeGreaterThan(0);
                }
            }
        }
    });

    it("大文本：给 total 时逐字一致；不给时 omitted 是下界", () => {
        const text = "\n\n" + Array.from({ length: 3000 }, (_, i) => `行${i} ${"y".repeat(400)}`).join("\n");
        const exact = clampLines(text, 3, countLines(text));
        expect({ text: exact.text, omitted: exact.omitted }).toEqual(naiveClamp(text, 3));
        expect(exact.exact).toBe(true);

        const loose = clampLines(text, 3);
        expect(loose.exact).toBe(false);
        expect(loose.text).toBe(exact.text);
        expect(loose.omitted).toBeLessThanOrEqual(exact.omitted);
        expect(loose.omitted).toBeGreaterThan(0);
    });

    it("单行 3 MB：不 split 全文、不裁（原样式整段给）", () => {
        const text = "x".repeat(3_280_000);
        const got = clampLines(text, 3);
        expect(got.text).toBe(text);
        expect(got.omitted).toBe(0);
    });
});
