// types.ts — 分桶 jsonl 的公开契约
//
// 落盘形态（##456「存储分桶」）：
//   <dir>/index.json          桶索引（勿与桶混合）
//   <dir>/0001-20261030-115000+0800.jsonl   一桶 = 一段连续 seq（一行一条消息）
//   <dir>/0002-20261030-121530+0800.jsonl   文件名 = 序号 + 首条 entry 的 at（本地时刻 + 偏移，##464）
//
// 文件名的时间**只当提示**（给人看，别处的工具不必懂 index.json 也能看出日期）；
// 真值以桶内首尾行为准，`index.json` 丢了照样能重建。
//
// 切桶**按大小**（缺省 16 MB），不按日期：某天一次长跑照样把单文件撑爆。
// `seq` 全局单调、跨桶连续；桶只是物理切分，逻辑上是一个连续序列。

/** 一个桶的索引条目 */
export interface BucketRecord {
    /** 文件名（`<序号>-<本地日期>-<本地时间><偏移>.jsonl`，如 `0001-20261030-115000+0800.jsonl`） */
    readonly file: string;
    /** 当前字节数（内存里累计；切桶时才写进 index.json） */
    readonly bytes: number;
    /** 首条 seq（含） */
    readonly fromSeq: number;
    /** 末条 seq（含） */
    readonly toSeq: number;
    /** 首条时间（毫秒） */
    readonly fromAt: number;
    /** 末条时间（毫秒） */
    readonly toAt: number;
}

/** index.json 的内容 */
export interface BucketIndex {
    readonly buckets: readonly BucketRecord[];
    readonly totalBytes: number;
    /** 下一个待分配的 seq（= 末条 seq + 1） */
    readonly nextSeq: number;
}

/** open 参数 */
export interface JsonlSessionStoreOptions {
    /** 会话目录（一个会话一个目录） */
    readonly dir: string;
    /** 单桶上界（字节）；缺省 16 MB。写满即切，单条超大允许独占一桶 */
    readonly maxBucketBytes?: number;
}

/** 缺省单桶上界：16 MB（##456 实测 181 MB 的 ops.jsonl 让 tail/grep 都变慢；##464 定版放大到 16 MB） */
export const DEFAULT_MAX_BUCKET_BYTES = 16 * 1024 * 1024;
