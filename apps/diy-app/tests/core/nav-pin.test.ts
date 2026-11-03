// tests/core/nav-pin.test.ts — nav 任务置顶（##356 ②）的纯规则
//
// 契约（用户能看见的行为）：
//   1. 置顶项固定排在列表最上方，**不被新开的挤下去**
//   2. 置顶区内保持全局顺序（= 任务的树序）→ 父子在区内仍相邻
//   3. 集合只由用户动作改写：子孙被置顶**不会**隐式把祖先也置顶
//   4. 关掉的 tab（键不存在了）在剪枝时被清掉，但「同键再打开」仍是置顶
import { describe, expect, it } from "vitest";
import { partitionByPin, prunePins, togglePin } from "../../src/shared/nav-pin";

const A = "task-run:projects/1/tasks/a";
const B = "task-run:projects/1/tasks/b";
const C = "task-run:projects/1/tasks/c";
const keyOf = (k: string) => k;

describe("partitionByPin", () => {
  it("置顶项全部前移，区内保持全局顺序", () => {
    const { pinned, rest } = partitionByPin([A, B, C], keyOf, new Set([A, C]));
    expect(pinned).toEqual([A, C]); // 不是 [C, A]：顺序由输入决定
    expect(rest).toEqual([B]);
  });

  it("新开的 tab 挤不掉置顶项（置顶恒在最前）", () => {
    const before = partitionByPin([A], keyOf, new Set([A]));
    const after = partitionByPin([A, B, C], keyOf, new Set([A]));
    expect(after.pinned).toEqual(before.pinned);
    expect(after.rest).toEqual([B, C]);
  });

  it("子孙被置顶不隐式置顶祖先（集合不被渲染逻辑扩大）", () => {
    const { pinned, rest } = partitionByPin([A, B], keyOf, new Set([B]));
    expect(pinned).toEqual([B]);
    expect(rest).toEqual([A]);
  });

  it("空集合 / 全置顶都是恒等分区", () => {
    expect(partitionByPin([A, B], keyOf, new Set())).toEqual({ pinned: [], rest: [A, B] });
    expect(partitionByPin([A, B], keyOf, new Set([A, B]))).toEqual({ pinned: [A, B], rest: [] });
  });
});

describe("togglePin", () => {
  it("置顶 / 取消置顶各一次回到原状，且不改原数组", () => {
    const src = [A];
    expect(togglePin(src, B)).toEqual([A, B]);
    expect(togglePin([A, B], B)).toEqual([A]);
    expect(src).toEqual([A]);
  });
});

describe("prunePins", () => {
  it("剪掉已不存在的键（关掉的 tab / 删掉的任务）", () => {
    expect(prunePins([A, B, C], [A, C])).toEqual([A, C]);
  });

  it("键还在就保留 —— 任务重开仍是置顶（集合是偏好，不是「当前列表快照」）", () => {
    expect(prunePins([A], [A])).toEqual([A]);
  });
});
