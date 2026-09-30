// src/ref/progress.ts — git 进度行解析（纯函数，无 IO）
//
// 样本来源 190 第六节（git 2.49，stderr=pipe + --progress）：
//   - 更新以 \r 分隔（204 CR vs 6 LF）、行尾带抹除用 padding 空格
//     → 调用方按 [\r\n] 切段 + trim（本函数入参即已切好的单段）
//   - 中间进度行只有 % 与 (n/total)；bytes / 速率只在 done 行出现 → 容忍缺省
//   - `remote:` 前缀是服务端阶段（Enumerating / Counting / Compressing / Total），
//     与客户端阶段（Receiving / Resolving / Updating）用 remote 字段区分

export interface GitProgress {
    /** 阶段名（去 remote: 前缀与冒号），如 "Receiving objects"；Total 行无冒号单列 */
    phase: string;
    /** 0-100；无 % 的行（Enumerating / Total）为 null */
    percent: number | null;
    /** 进度 (n/total) 的当前数；无为 null */
    count: number | null;
    /** 总数；无 % 也无 (n/total) 时取行首裸数字（Enumerating / Total 行），否则无为 null */
    total: number | null;
    /** 体积串（仅 done 行，如 "9.08 KiB"） */
    bytes?: string;
    /** 速率串（仅 done 行，如 "3.03 MiB/s"） */
    rate?: string;
    /** 行尾 done. */
    done: boolean;
    /** remote: 前缀（服务端阶段） */
    remote: boolean;
}

// 阶段行：冒号前是首字母大写的词组，如 "Receiving objects: …"
const PHASE_RE = /^([A-Z][A-Za-z]*(?: [A-Za-z]+)*):\s*([\s\S]*)$/;
// "Total 12439 (delta 515), …"（remote: 侧汇总行，无冒号）
const TOTAL_RE = /^Total\s+([\s\S]*)$/;
const PCT_RE = /(\d{1,3})%/;
const COUNT_RE = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/;
const BYTES_RATE_RE = /([\d.]+ (?:[KMGT]iB|B))\s*\|\s*([\d.]+ (?:[KMGT]iB|B)\/s)/;
const DONE_RE = /done\.\s*$/;

/**
 * 解析单段 git 进度文本；不是进度行返回 null（如 "Cloning into '…'…"、warning 行）。
 * 入参可带行尾 padding 空格，内部 trim。
 */
export function parseGitProgress(seg: string): GitProgress | null {
    let s = seg.trim();
    let remote = false;
    if (s.startsWith("remote:")) {
        remote = true;
        s = s.slice("remote:".length).trimStart();
    }

    let phase: string;
    let rest: string;
    const pm = s.match(PHASE_RE);
    if (pm) {
        phase = pm[1]!;
        rest = pm[2]!.trim();
    } else {
        const tm = s.match(TOTAL_RE);
        if (!tm) return null;
        phase = "Total";
        rest = tm[1]!.trim();
    }

    let percent: number | null = null;
    let count: number | null = null;
    let total: number | null = null;

    const pct = rest.match(PCT_RE);
    const cnt = rest.match(COUNT_RE);
    if (pct) percent = Number(pct[1]);
    if (cnt) {
        count = Number(cnt[1]);
        total = Number(cnt[2]);
    }
    if (!pct && !cnt) {
        // Enumerating / Total 行：行首裸数字即总数（如 "202, done." / "12439 (delta 515)"）
        const bare = rest.match(/^(\d+)/);
        if (bare) total = Number(bare[1]);
    }
    // 无任何数字 → 非进度行（如 "warning: …"）
    if (percent === null && count === null && total === null) return null;

    const br = rest.match(BYTES_RATE_RE);
    return {
        phase,
        percent,
        count,
        total,
        ...(br ? { bytes: br[1]!, rate: br[2]! } : {}),
        done: DONE_RE.test(rest),
        remote,
    };
}
