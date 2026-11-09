// src/main/services/log-noise.ts
// 🎯 噪音登记与聚合：**已知的良性外部告警**进日志框架，但折叠成一行一条计数。
//
// 为什么需要（##522 用户口径「错误要包装统一到日志框架，不然算啥呢」）：
// 之前处理 ResizeObserver 循环告警的做法是「在 console-message 里按消息前缀直接 return」——
// 等同于**丢弃**：日志里既没有它的存在，也没有「出现过多少次」，事后查不到任何痕迹。
// 现在改成三段式：
//   ① 登记：pattern → kind（机器码）+ why（为什么良性），判据集中在本文件，不散在调用点；
//   ② 首次命中：打一行**带原文与解释**的日志（人看得懂、grep 得着）；
//   ③ 其后命中：只计数，按 flushMs 汇总成一行（避免刷屏，但不丢信息），进程退出前 flush 补全。
//
// 边界（务必别误以为本模块能包住一切）：
//   ✅ 渲染进程 console-message 里的已知文本噪音（走 classifyRendererNoise）；
//   ❌ 原生 / 系统库直接写 fd 1·2 的行（如 macOS HIToolbox 的
//      `TSM AdjustCapsLockLEDForKeyTransitionHandling`）—— 它们不经过任何 JS API，
//      主进程拦不到；要静音只能在启动器/终端侧重定向 stderr，不在本模块职责内。

/** 一条已知噪音的登记项 */
export interface NoiseRule {
  /** 匹配依据：消息**子串**（用 Chromium 原文，别写成正则/改词） */
  pattern: string;
  /** 机器码：日志里出现的分类名（grep 用，kebab-case） */
  kind: string;
  /** 为什么它是良性的：首次命中时随行落盘，省得人再去查 */
  why: string;
}

/**
 * 渲染进程的已知文本噪音。
 *
 * ResizeObserver 两条是 Chromium 自产的布局循环告警：某次布局里没能消化完通知就再触发，
 * 超限则丢弃剩余通知并抛 error 级事件。功能无影响（下一次布局照常回调），
 * 真正的修法是回调里别同步写布局（见 renderer_solid/lib/frame-batch.ts）。
 */
export const RENDERER_NOISE: readonly NoiseRule[] = [
  {
    pattern: "ResizeObserver loop completed with undelivered notifications",
    kind: "resize-observer-loop",
    why: "Chromium 布局循环告警：RO 回调里同步写布局导致同帧反复投递；不影响功能，源头修法见 frame-batch.ts",
  },
  {
    pattern: "ResizeObserver loop limit exceeded",
    kind: "resize-observer-loop",
    why: "同上（旧版 Chromium 的措辞，两条归一为同一 kind）",
  },
];

/** 按消息文本查登记表（未登记 = 真错误，交给调用方正常上报） */
export function classifyRendererNoise(message: string): NoiseRule | null {
  for (const r of RENDERER_NOISE) if (message.includes(r.pattern)) return r;
  return null;
}

export interface NoiseMeterOptions {
  /** 时钟（测试注入） */
  now?: () => number;
  /** 同类噪音的汇总间隔：首次立刻出，其后至少隔这么久才再出一行（缺省 60s） */
  flushMs?: number;
  /** 输出通道（缺省 console.warn —— 经 diagnostics 的 tee 会带进 main.log） */
  emit?: (line: string) => void;
}

interface MeterState {
  hits: number;
  /** 自上次输出以来还没打出来的条数 */
  pending: number;
  lastEmitAt: number;
  /** 首次命中的原文（汇总行里带上，便于人认出是哪条） */
  sample: string;
}

/**
 * 噪音计量器：首次带解释输出，之后按间隔汇总计数，退出前 flush。
 * 幂等且无定时器（只在命中时看表），不需要清理。
 */
export function createNoiseMeter(opts: NoiseMeterOptions = {}): {
  note: (rule: NoiseRule, sample: string) => void;
  flush: () => void;
} {
  const now = opts.now ?? (() => Date.now());
  const flushMs = opts.flushMs ?? 60_000;
  const emit = opts.emit ?? ((line: string) => console.warn(line));
  const states = new Map<string, MeterState>();

  const summary = (rule: NoiseRule, s: MeterState, sinceMs: number): string => {
    const window = sinceMs >= 1000 ? `${Math.round(sinceMs / 1000)}s` : "本帧";
    return `[noise:${rule.kind}] 近 ${window} 内 ${s.pending} 条（累计 ${s.hits}）—— ${s.sample}`;
  };

  return {
    note(rule, sample) {
      const t = now();
      const s = states.get(rule.kind);
      if (!s) {
        // 首次：原文 + 解释一起落盘（这一行就是「它算啥」的答案）
        states.set(rule.kind, { hits: 1, pending: 0, lastEmitAt: t, sample });
        emit(`[noise:${rule.kind}] 首次出现（后续只计数汇总）—— ${sample}｜已知良性：${rule.why}`);
        return;
      }
      s.hits += 1;
      s.pending += 1;
      if (t - s.lastEmitAt >= flushMs) {
        emit(summary(rule, s, t - s.lastEmitAt));
        s.pending = 0;
        s.lastEmitAt = t;
      }
    },
    /** 进程退出前调用：把窗口内没打出来的计数补一行（不丢信息） */
    flush() {
      const t = now();
      for (const [kind, s] of states) {
        if (s.pending === 0) continue;
        const rule = RENDERER_NOISE.find((r) => r.kind === kind);
        emit(summary(rule ?? { kind, pattern: "", why: "" }, s, t - s.lastEmitAt));
        s.pending = 0;
        s.lastEmitAt = t;
      }
    },
  };
}
