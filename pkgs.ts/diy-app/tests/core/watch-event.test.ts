import { describe, expect, it } from "vitest";
import { watchEventText } from "../../src/shared/watch-event";
import type { WatchEvent } from "../../src/shared/watch-event";

// ##408 v2：中性事件的文案（各出口共用一份，别在各 sink 里各写）。

const ev: WatchEvent = {
    watchId: "daily-pr",
    title: "看 PR 有没有人回",
    kind: "changed",
    at: 1_000,
    diff: "~ a: 1 → 2",
};

describe("watchEventText", () => {
    it("变化：标题带 watch id、subject 与 title，正文就是 diff", () => {
        expect(watchEventText(ev)).toEqual({
            title: "watch daily-pr 有变化 · 看 PR 有没有人回",
            body: "~ a: 1 → 2",
        });
        expect(watchEventText({ ...ev, subject: "run:r1" }).title).toBe(
            "watch daily-pr 有变化（run:r1） · 看 PR 有没有人回",
        );
    });

    it("坏了：标题明说「坏了」（比「有变化」更该引人注意）", () => {
        expect(watchEventText({ ...ev, kind: "broken", diff: "EACCES" })).toEqual({
            title: "watch daily-pr 坏了 · 看 PR 有没有人回",
            body: "EACCES",
        });
    });
});
