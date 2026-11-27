// name.ts — 磁盘名归一（sanitize）与原名保留
//
// 两条分开的事，别混：
//   · **displayName** = 原名，原样进 ref —— 下载来的文件叫 `2026 Q4 财报 (final).pdf`，
//     这个名字对人有意义，一个字都不该改。
//   · **磁盘名** = 原名 sanitize 后的安全副本 —— 它要过一个文件系统，还得防路径逃逸。
//
// 为什么不能直接把原名当磁盘名（2026-11-26 实测清单）：
//   `../x`（逃出批次目录）、`/etc/passwd`（绝对路径）、`a/b.png`（多一层目录）、
//   `...`（在 macOS 上仍是普通名，但 `..` 不是）、空名（剪贴板图没有名字）、
//   80 字节以上的中文名（APFS 单段上限 255 字节，但我们要留出日期/NN 前缀的余量）、
//   `: ` 与 `/`（Finder 会显示成 `/`）、控制字符（`\n` 进 shell 就出事）。
//
// 边界：**不做事后审计**（谁把 `..` 塞进来的不归这里管），只保证「折出来一定落在批次目录里」。

/** 文件名中段（不含扩展名）的最大字节数 —— 给日期 / HHMMSS / batch / NN 前缀留余量 */
const MAX_STEM_BYTES = 80;

/** 剪贴板来的无名图用的名字前缀（`paste-1` / `paste-2`） */
export const PASTE_NAME = 'paste';

/** 文件名里的非法字符（macOS + Windows 的并集）：这些折成 `_` */
const UNSAFE = /[/\\:*?"<>|]/g;

/** 控制字符（`\n` / `\t` / `\u0000` …）—— 进 shell / 日志就会出事，同样折成 `_`。
 *  用 Unicode 属性类而不是字符区间：手写区间会让 lint 报“正则里有控制字符”。 */
const CONTROL = /\p{Cc}/gu;

/** 按 UTF-8 字节截断到 `limit`，不切坏多字节字符 */
function truncateBytes(value: string, limit: number): string {
    if (Buffer.byteLength(value, 'utf8') <= limit) return value;
    let out = '';
    let used = 0;
    for (const char of value) {
        const size = Buffer.byteLength(char, 'utf8');
        if (used + size > limit) break;
        out += char;
        used += size;
    }
    return out;
}

/**
 * 把任意名字（可能带路径、可能为空）折成一个**安全的中段**（不含扩展名）。
 *
 * @param raw       原名（可能已带扩展名 —— 这里不管扩展名，调用方自己拆）
 * @param fallback  折完为空时用的名字（如 `paste` / `attachment`）
 */
export function sanitizeStem(raw: string | undefined, fallback: string): string {
    if (raw === undefined || raw === '') return fallback;
    // 只取最后一段：`../../etc/passwd` → `passwd`，`a/b.png` → `b.png`
    const lastSegment =
        raw
            .split(/[/\\]/)
            .filter((part) => part !== '')
            .at(-1) ?? '';
    let stem = lastSegment.replace(UNSAFE, '_').replace(CONTROL, '_');
    // 前导点：`..` / `.env` 都折掉前导点（隐藏文件在批次目录里没有意义，还会藏住漏删）
    stem = stem.replace(/^\.+/, '');
    // 首尾空白（Finder 会给下载文件名加后缀空格，合法但难用）
    stem = stem.trim();
    if (stem === '') return fallback;
    const truncated = truncateBytes(stem, MAX_STEM_BYTES).trim();
    return truncated === '' ? fallback : truncated;
}

/** 拆出「中段 + 原名后缀」（原名后缀只用于 displayName，不用于落盘扩展名） */
export function splitName(raw: string): { stem: string; ext: string } {
    const lastSegment =
        raw
            .split(/[/\\]/)
            .filter((part) => part !== '')
            .at(-1) ?? '';
    const dot = lastSegment.lastIndexOf('.');
    // `.env` 这种：dot === 0 不算有扩展名
    if (dot <= 0) return { stem: lastSegment, ext: '' };
    return { stem: lastSegment.slice(0, dot), ext: lastSegment.slice(dot + 1) };
}

/**
 * 生成 `NN-<中段>.<mime 扩展名>` —— 落盘用的文件名。
 *
 * @param index  批次内序号（从 1 起，两位数；`NN-` 保序，多图顺序有意义）
 * @param raw    原名（可为空 —— 剪贴板图没有名字）
 * @param ext    由 mime 定（不信原名后缀）
 */
export function fileNameOf(index: number, raw: string | undefined, ext: string): string {
    const stem = sanitizeStem(raw === undefined ? undefined : splitName(raw).stem, PASTE_NAME);
    const nn = String(index).padStart(2, '0');
    return `${nn}-${stem}.${ext}`;
}
