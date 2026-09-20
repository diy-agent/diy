// tests/core/hl-lines.test.ts — 区间 → 行号（整行高亮的唯一口径）
import { describe, expect, it } from "vitest";
import { lineNumbersOf } from "../../src/shared/hl-lines";

const TEXT = "L1\nL2\nL3\nL4"; // 行起点：0, 3, 6, 9

describe("lineNumbersOf：区间覆盖到哪些行", () => {
  it("行内区间 → 整行的行号（首行 / 中间行）", () => {
    expect(lineNumbersOf(TEXT, [{ from: 0, to: 2 }])).toEqual([1]);
    expect(lineNumbersOf(TEXT, [{ from: 4, to: 5 }])).toEqual([2]);
  });

  it("跨行区间 → 覆盖到的每一行，且去重升序", () => {
    expect(lineNumbersOf(TEXT, [{ from: 1, to: 7 }])).toEqual([1, 2, 3]);
    expect(lineNumbersOf(TEXT, [{ from: 7, to: 8 }, { from: 1, to: 2 }])).toEqual([1, 3]);
  });

  it("空区间不产出行（这次没产出就没有行可看）", () => {
    expect(lineNumbersOf(TEXT, [{ from: 4, to: 4 }])).toEqual([]);
    expect(lineNumbersOf(TEXT, [])).toEqual([]);
  });

  it("越界夹回文档；末行不需要以换行结尾", () => {
    expect(lineNumbersOf(TEXT, [{ from: -5, to: 999 }])).toEqual([1, 2, 3, 4]);
    expect(lineNumbersOf(TEXT, [{ from: 10, to: 11 }])).toEqual([4]);
  });
});
