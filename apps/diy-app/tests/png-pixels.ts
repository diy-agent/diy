// tests/png-pixels.ts
// 🎯 像素判据的最小工具：**解码 PNG + 在指定区域数像素**（##166 §14.5 / §14.8 的 A/B 判据要用）。
//
// 为什么自己解码（不引依赖）：截图走 CDP `Page.captureScreenshot`（PNG），而「线有没有被底纹盖住」
// 只能靠**真像素**回答 —— DOM 断言看不见「画了但被盖住」。一个 8-bit PNG 解码器（node:zlib +
// 反滤波）足够，且不新增依赖（测试跑在 Node 里，`inflateSync` 现成）。
//
// 支持的形状：位深 8，颜色类型 0（灰）/ 2（RGB）/ 4（灰+A）/ 6（RGBA）—— Chromium 截图只出 2 / 6，
// 另两种顺手支持。**交错（Adam7）不支持**：Chromium 不产交错 PNG，遇上报错而不是画错。
import { inflateSync } from "node:zlib";

export interface RgbaImage {
    readonly width: number;
    readonly height: number;
    /** 每像素 4 字节（RGBA），行优先、无 padding */
    readonly data: Buffer;
}

/** Paeth 预测子（PNG 规范 §9.4） */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

export function decodePng(buf: Buffer): RgbaImage {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < sig.length; i++) {
        if (buf[i] !== sig[i]) throw new Error("不是 PNG（签名不符）");
    }
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat: Buffer[] = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString("ascii", off + 4, off + 8);
        const body = buf.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            bitDepth = body[8]!;
            colorType = body[9]!;
            interlace = body[12]!;
        } else if (type === "IDAT") {
            idat.push(body);
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len; // length + type + data + crc
    }
    if (width === 0 || height === 0) throw new Error("PNG 缺 IHDR / 尺寸为 0");
    if (bitDepth !== 8) throw new Error(`只支持位深 8（实得 ${bitDepth}）`);
    if (interlace !== 0) throw new Error("不支持 Adam7 交错 PNG");

    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
    if (channels === 0) throw new Error(`不支持的颜色类型 ${colorType}`);

    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[p++]!;
        const line = Buffer.from(raw.subarray(p, p + stride));
        p += stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? line[i - channels]! : 0;
            const b = prev[i]!;
            const c = i >= channels ? prev[i - channels]! : 0;
            const x = line[i]!;
            const val = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : NaN;
            if (Number.isNaN(val)) throw new Error(`未知 PNG 行滤波类型 ${filter}`);
            line[i] = val & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const s = x * channels;
            const d = (y * width + x) * 4;
            if (channels === 1) {
                out[d] = out[d + 1] = out[d + 2] = line[s]!;
                out[d + 3] = 255;
            } else if (channels === 2) {
                out[d] = out[d + 1] = out[d + 2] = line[s]!;
                out[d + 3] = line[s + 1]!;
            } else if (channels === 3) {
                out[d] = line[s]!;
                out[d + 1] = line[s + 1]!;
                out[d + 2] = line[s + 2]!;
                out[d + 3] = 255;
            } else {
                out[d] = line[s]!;
                out[d + 1] = line[s + 1]!;
                out[d + 2] = line[s + 2]!;
                out[d + 3] = line[s + 3]!;
            }
        }
        prev = line;
    }
    return { width, height, data: out };
}

export interface PixelRegion {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** 区域内的像素计数（区域按**图像坐标**：调用方负责把视口 rect × devicePixelRatio） */
export function countPixels(img: RgbaImage, region: PixelRegion, pred: (r: number, g: number, b: number) => boolean): number {
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(img.width, Math.ceil(region.x + region.w));
    const y1 = Math.min(img.height, Math.ceil(region.y + region.h));
    let n = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * img.width + x) * 4;
            if (pred(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!)) n++;
        }
    }
    return n;
}

/** 饱和红（`#ef4444` 一族：打回线）—— 判据用「够红」而非精确色值：抗锯齿边不算，但线身必须算 */
export const isRed = (r: number, g: number, b: number): boolean => r >= 180 && g <= 110 && b <= 110;
/** 饱和蓝（`#3b82f6` 一族：推进线） */
export const isBlue = (r: number, g: number, b: number): boolean => b >= 180 && r <= 120 && g <= 170;
