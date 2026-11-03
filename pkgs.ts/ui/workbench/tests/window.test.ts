import { describe, expect, it } from "vitest";
import { MIN_WINDOW_HEIGHT, ZOOM_INSET, sidecarWindowOptions, type DisplayLike } from "../src/window.js";

const display = (id: number, label: string, x: number, y: number, width: number, height: number): DisplayLike => ({
    id,
    label,
    workArea: { x, y, width, height },
});

describe("sidecarWindowOptions", () => {
    it("单屏：不定位（空对象，走缺省）", () => {
        const primary = display(1, "内置屏", 0, 0, 1440, 900);
        expect(sidecarWindowOptions([primary], 1, 1040, 720)).toEqual({});
    });

    it("优先 label 含 Sidecar 的副屏，并居中", () => {
        const primary = display(1, "内置屏", 0, 0, 1440, 900);
        const external = display(2, "DELL", 1440, 0, 1920, 1080);
        const sidecar = display(3, "Sidecar iPad", 3360, 0, 1200, 800);
        const pos = sidecarWindowOptions([primary, external, sidecar], 1, 1040, 720);
        expect(pos["x"]).toBe(3360 + Math.floor((1200 - 1040) / 2));
        expect(pos["y"]).toBe(Math.floor((800 - 720) / 2));
        expect(pos["width"]).toBe(1040);
        expect(pos["height"]).toBe(720);
    });

    it("没有 Sidecar 时落第一个非主屏", () => {
        const primary = display(1, "内置屏", 0, 0, 1440, 900);
        const external = display(2, "DELL", 1440, 0, 1920, 1080);
        const pos = sidecarWindowOptions([primary, external], 1, 1040, 720);
        expect(pos["x"]).toBe(1440 + Math.floor((1920 - 1040) / 2));
    });

    it("尺寸恰好等于 workArea 时高度内缩（避免出生即 zoom）", () => {
        const primary = display(1, "内置屏", 0, 0, 1440, 900);
        const external = display(2, "DELL", 1440, 0, 1024, 768);
        const pos = sidecarWindowOptions([primary, external], 1, 1024, 768);
        // 宽度不内缩（lg 断点），高度内缩一圈
        expect(pos["width"]).toBe(1024);
        expect(pos["height"]).toBe(768 - ZOOM_INSET);
        expect(pos["height"]).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT);
    });
});
