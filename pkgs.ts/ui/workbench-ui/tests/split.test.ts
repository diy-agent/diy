// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clampPaneWidth, createSplitPane } from "../src/split.js";

beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
});

const pane = (): HTMLElement => {
    const el = document.createElement("aside");
    // happy-dom 的布局是 0；拖条按 clientX - 左边界算，这里把左边界钉在 0
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    document.body.append(el);
    return el;
};

describe("clampPaneWidth", () => {
    it("夹在 [min, max] 之间", () => {
        expect(clampPaneWidth(100, 260, 520)).toBe(260);
        expect(clampPaneWidth(900, 260, 520)).toBe(520);
        expect(clampPaneWidth(360, 260, 520)).toBe(360);
    });

    it("NaN / Infinity 回 min（不让一次坏输入弄坏布局）", () => {
        expect(clampPaneWidth(Number.NaN, 260, 520)).toBe(260);
        expect(clampPaneWidth(Number.POSITIVE_INFINITY, 260, 520)).toBe(260);
    });
});

describe("createSplitPane", () => {
    it("拖动实时改宽度，并夹在范围内", () => {
        const el = pane();
        const split = createSplitPane(el, { min: 260, max: 520, initial: 360 });
        expect(el.style.width).toBe("360px");

        split.handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
        expect(el.style.width).toBe("260px");
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 900 }));
        expect(el.style.width).toBe("520px");
        document.dispatchEvent(new MouseEvent("mouseup"));
        expect(split.width()).toBe(520);
    });

    it("松手后记住宽度（storageKey）", () => {
        const first = createSplitPane(pane(), { min: 260, max: 520, initial: 360, storageKey: "w" });
        first.setWidth(444);
        first.handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        document.dispatchEvent(new MouseEvent("mouseup"));
        expect(localStorage.getItem("w")).toBe("444");

        document.body.replaceChildren();
        const restored = createSplitPane(pane(), { min: 260, max: 520, initial: 360, storageKey: "w" });
        expect(restored.width()).toBe(444);
    });
});
