// tests/core/keep-last.test.ts — ##428 的回归钉
//
// 症状：任务详情切任务时偶发 `Uncaught (in promise) Attempting to access a stale value
// from <Show>`。根因是 `<Show when={x()}>{(a) => …}</Show>` 的 children accessor
// **在 x 转 falsy 之后（含组件已卸载）再读就抛**，而业务代码常把它带过 `await` / 定时器。
//
// keepLast 的做法：子块不读 Show 的 accessor，改读基于同一数据源的「最后一非空值」。
// 这两个用例钉住两件事：
//   1. 同一个源上，Show 的 accessor 转 falsy 后**会抛**（证明 hazard 是真的，不是臆想）；
//   2. keepLast 在转 falsy / 卸载之后**返回最后一个值、不抛**（证明修法成立）。
import { describe, expect, it } from "vitest";
import { createMemo, createRoot, createSignal, Show, type Accessor } from "solid-js";
import { keepLast } from "../../src/renderer_solid/lib/keep-last";

interface Item {
    id: string;
}

describe("keepLast —— Show accessor 不可读的兜底（##428）", () => {
    it("源转 null / 组件卸载后仍返回最后一个非空值，且跟随新的非空值", () => {
        const [src, setSrc] = createSignal<Item | null>({ id: "a" });
        let last!: Accessor<Item | undefined>;
        const dispose = createRoot((d) => {
            last = keepLast(src);
            last(); // 建立订阅
            return d;
        });

        expect(last()).toEqual({ id: "a" });

        // 转 null（= 切任务那一刻 own 被置空）：回退旧值，不抛
        setSrc(null);
        expect(last()).toEqual({ id: "a" });

        // 新值到了照常跟随
        setSrc({ id: "b" });
        expect(last()).toEqual({ id: "b" });

        // 卸载后再读：仍是最后一个值，不抛
        dispose();
        expect(last()).toEqual({ id: "b" });
    });

    it("对照：同一个源上，Show 的 children accessor 转 falsy 后读会抛 stale", () => {
        const [src, setSrc] = createSignal<Item | null>({ id: "a" });
        let accessor!: Accessor<Item>;
        let last!: Accessor<Item | undefined>;

        const dispose = createRoot((d) => {
            last = keepLast(src);
            // 直接调 Show（不经过 JSX）：返回的 memo 读一次即完成首次渲染，
            // children 回调这时被调用，拿走 accessor —— 与组件里 `{(t) => …t()…}` 同形。
            const shown = (
                Show as unknown as (props: { when: unknown; children: (a: Accessor<Item>) => unknown }) => () => unknown
            )({
                get when() {
                    return src();
                },
                get children() {
                    return (a: Accessor<Item>) => {
                        accessor = a;
                        return createMemo(() => a().id);
                    };
                },
            }) as () => unknown;
            shown();
            last();
            return d;
        });

        expect(accessor()).toEqual({ id: "a" });

        setSrc(null);
        // hazard 实证：condition 转 falsy 后读 Show 的 accessor 就抛
        expect(() => accessor()).toThrow(/Stale read from <Show>/);
        // 修法：同一个源上读 keepLast 没事
        expect(last()).toEqual({ id: "a" });

        dispose();
    });
});
