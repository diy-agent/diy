// tests/core/hl-segments.test.ts — 预览高亮的分段（纯函数）
import { describe, expect, it } from "vitest";
import { splitByRanges } from "../../src/shared/hl-segments";

const join = (segs: Array<[string, boolean]>): string => segs.map(([t]) => t).join("");
const marks = (segs: Array<[string, boolean]>): string[] => segs.filter(([, h]) => h).map(([t]) => t);

describe("splitByRanges：按区间切段（预览高亮）", () => {
  it("基本切分：三段，只有命中那段落进 mark；拼回原文一字不差", () => {
    const segs = splitByRanges("abcdef", [{ from: 2, to: 4 }]);
    expect(segs).toEqual([
      ["ab", false],
      ["cd", true],
      ["ef", false],
    ]);
    expect(join(segs)).toBe("abcdef");
  });

  it("多处出现：各自成段（点变量行时的常态）", () => {
    const segs = splitByRanges("aXbXc", [
      { from: 1, to: 2 },
      { from: 3, to: 4 },
    ]);
    expect(marks(segs)).toEqual(["X", "X"]);
    expect(join(segs)).toBe("aXbXc");
  });

  it("重叠/嵌套区间合并成一段（:for 与其迭代项天然重叠）", () => {
    const segs = splitByRanges("abcdefg", [
      { from: 1, to: 5 },
      { from: 2, to: 3 },
      { from: 4, to: 6 },
    ]);
    expect(marks(segs)).toEqual(["bcde", "f"]);
    expect(join(segs)).toBe("abcdefg");
  });

  it("乱序、空区间、越界、整段命中都不炸", () => {
    expect(join(splitByRanges("abc", [{ from: 2, to: 3 }, { from: 0, to: 1 }]))).toBe("abc");
    expect(splitByRanges("abc", [{ from: 1, to: 1 }])).toEqual([["abc", false]]);
    expect(join(splitByRanges("abc", [{ from: -5, to: 99 }]))).toBe("abc");
    expect(marks(splitByRanges("abc", [{ from: -5, to: 99 }]))).toEqual(["abc"]);
    expect(splitByRanges("", [{ from: 0, to: 5 }])).toEqual([]);
  });
});
