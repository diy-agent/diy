// tests/fixtures.ts — 最小的真格式字节（不引入图片库：本包要的是「真魔数 + 真头」）
//
// 造的是**能通过嗅探与尺寸解析**的最小文件，不是能解码的图片 —— 本包不解码，
// 所以 CRC / 像素数据一概不填。

/** 一张 width × height 的 PNG（8 字节签名 + IHDR，CRC 不填） */
export function pngBytes(width = 10, height = 5): Uint8Array {
    const be32 = (value: number): number[] => [
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
    ];
    return Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG 签名
        0,
        0,
        0,
        0x0d, // IHDR 长度 = 13
        0x49,
        0x48,
        0x44,
        0x52, // 'IHDR'
        ...be32(width),
        ...be32(height),
        8,
        6,
        0,
        0,
        0, // 位深 / 颜色类型 / 压缩 / 过滤 / 隔行
        0,
        0,
        0,
        0, // 占位 CRC
    ]);
}

/** 一张 width × height 的 JPEG（SOI + 最小 APP0 + SOF0；帧头才是尺寸的来源） */
export function jpegBytes(width = 100, height = 45): Uint8Array {
    const app0Payload = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]; // 'JFIF\0' + 版本/密度
    const app0Length = app0Payload.length + 2;
    const sofPayload = [
        8, // 精度
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        3, // 分量数
        1,
        0x11,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
    ];
    const sofLength = sofPayload.length + 2;
    return Uint8Array.from([
        0xff,
        0xd8, // SOI
        0xff,
        0xe0,
        (app0Length >> 8) & 0xff,
        app0Length & 0xff,
        ...app0Payload,
        0xff,
        0xc0,
        (sofLength >> 8) & 0xff,
        sofLength & 0xff,
        ...sofPayload,
        0xff,
        0xd9, // EOI
    ]);
}

/** 一张 GIF（GIF89a + 逻辑屏幕宽高，小端） */
export function gifBytes(width = 320, height = 200): Uint8Array {
    return Uint8Array.from([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61, // 'GIF89a'
        width & 0xff,
        (width >> 8) & 0xff,
        height & 0xff,
        (height >> 8) & 0xff,
        0,
        0,
        0, // 打包字段 / 背景色 / 宽高比
    ]);
}

/** 任意长度的伪随机字节（造 too-large / 未知二进制用） */
export function noiseBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
    return bytes;
}
