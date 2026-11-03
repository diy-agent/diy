// tests/core/tab-store.test.ts — 打开的 tab 的持久化契约
//
// 真实故障（本次修的）：tabStore 从「URI 字符串数组」升级为「页面实例对象数组」
// （TabItem）时，`Caches.diy_tabs_opened` 的 parse 仍在按 string 过滤元素 ——
// 写进去的对象读回时被滤空，**重启 app 后打开的 tab 全部清零**。
//
// 这里锁死两件事：
//   ① 元素级清洗在 tabStore.load()，Caches 只校验「整体是数组」
//   ② 旧格式（纯 URI 字符串）仍能升级为 TabItem，不丢用户现场
import { beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
} as Storage;

const { Caches } = await import("../../src/renderer_solid/lib/ui-state");

describe("Caches.diy_tabs_opened —— 只校验整体形状", () => {
  beforeEach(() => store.clear());

  it("对象数组原样读回（**回归点**：曾被 filter(string) 滤空）", () => {
    const items = [
      { key: "task-run:projects/1/tasks/2", pageId: "task-run", ctx: "projects/1/tasks/2" },
    ];
    Caches.diy_tabs_opened.set(items);
    expect(Caches.diy_tabs_opened.get()).toEqual(items);
  });

  it("旧格式（纯 URI 字符串）也原样读回，交给 tabStore 升级", () => {
    Caches.diy_tabs_opened.set(["projects/1/tasks/2"]);
    expect(Caches.diy_tabs_opened.get()).toEqual(["projects/1/tasks/2"]);
  });

  it("不是数组 → 回默认空数组（脏数据不把界面搞崩）", () => {
    store.set("diy_tabs_opened", '{"not":"array"}');
    expect(Caches.diy_tabs_opened.get()).toEqual([]);
    store.set("diy_tabs_opened", "不是 JSON");
    expect(Caches.diy_tabs_opened.get()).toEqual([]);
  });

  it("数组元素不合法也照样读回（清洗是 tabStore 的事，不是这里）", () => {
    store.set("diy_tabs_opened", '[1,null,{"noPageId":true}]');
    expect(Caches.diy_tabs_opened.get()).toEqual([1, null, { noPageId: true }]);
  });
});
