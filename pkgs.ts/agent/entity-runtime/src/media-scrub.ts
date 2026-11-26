// media-scrub.ts —— 落库前把「文件字节」换成一行说明。
//
// 为什么需要它（2026-11-26）：`view_image` 这类工具会把图片**交给模型看**
// （`{ type:'content', value:[text, file] }`，ai-sdk 原生支持）。但同一份结果还会：
//   ① 变成 `tool.completed` 事件 → `item.data` → 进 db；
//   ② 进 `onStepTranscript` 的那批 messages → transcript → 进快照 db。
// 一张 1 MB 的截图 base64 后 1.33 MB —— 一轮看三张，db 就涨 4 MB，而且永久留着。
//
// 模型**已经看过了**（同一个 step 里），所以落库这一侧只留「这里曾经有一张图、叫什么、
// 多大」。要再看一次，重新调一次工具就行（它便宜、且路径还在）。
//
// 判据只认一个形状：`type === 'file'` 且带 `data`。这是 ai-sdk 的媒体 part，
// 不会与工具的入参混淆（入参里的 path / name 都是字符串）。

/** 一个媒体 part 被替换成的那行字（人看得懂，模型下一轮也读得懂） */
export function mediaNoteOf(filename: string | undefined, mediaType: string | undefined): string {
    const name = filename ?? '附件';
    return `[${name}（${mediaType ?? '二进制'}）已交给模型看过；落库不留字节，要再看一次就重新调工具]`;
}

/**
 * 递归找出媒体 part 并换成文本说明。**不改原对象**（返回新结构）。
 *
 * 为什么要递归而不是只处理 tool result 顶层：工具结果可能是
 * `{ type:'content', value:[...] }`，也可能被包进 `{ output: ... }`。
 */
export function scrubMedia<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => scrubMedia(item)) as unknown as T;
    if (value === null || typeof value !== 'object') return value;

    const record = value as Record<string, unknown>;
    if (record['type'] === 'file' && record['data'] !== undefined) {
        const filename = typeof record['filename'] === 'string' ? record['filename'] : undefined;
        const mediaType = typeof record['mediaType'] === 'string' ? record['mediaType'] : undefined;
        return {
            type: 'text',
            text: mediaNoteOf(filename, mediaType),
        } as unknown as T;
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = scrubMedia(item);
    return out as unknown as T;
}
