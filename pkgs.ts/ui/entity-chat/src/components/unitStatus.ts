// unitStatus.ts —— 账本状态的**唯一词表与配色**（2026-11-27 用户：「work / goal / requirement
// 的状态是否需要统一？」→ 统一在「进度态」这一层，不是把所有状态揉成一个）。
//
// 三层共用这三档，一个词、一个颜色只写在这里：
//
//   | 状态 | 词   | 点       | 谁会是这个状态 |
//   |------|------|----------|----------------|
//   | open | 未开始 | 灰       | 目标 / 需求（还没动手） |
//   | doing| 在做 | 蓝（呼吸） | 目标 / 需求（动手了） |
//   | done | 已完成 | 绿       | 目标（由需求派生）/ 需求 |
//
// **任务容器（work / room）不在这套里**：它只有「打开 / 关闭」两态，语义是**归档**（这条工作还
// 在被跟踪吗），不是进度（做到哪一步了）。硬并成一份会逼着「关闭的任务」回答「它 100% 了吗」——
// 答不上来。所以规则是：**同一件事在界面上只有一个词表，不同语义各自一套档位**。
//
// 为什么要有这个文件：原先目标列表、需求详情各写一遍「未开始 / 在做 / 已完成」和三种颜色，
// 改一处忘一处就出现「同一个 done 在两个地方是两种绿」。
export type UnitStatusKey = 'open' | 'doing' | 'done';

export interface UnitStatusMeta {
    /** 界面上给人看的词（不在别处再写一遍中文） */
    label: string;
    /** 状态点的 className（点在 title 前，宽度恒定） */
    dot: string;
    /** 文字色（详情头部等需要整段染色时用） */
    text: string;
}

export const UNIT_STATUS_META: Record<UnitStatusKey, UnitStatusMeta> = {
    open: { label: '未开始', dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
    doing: { label: '在做', dot: 'bg-sky-500 shadow-[0_0_0_3px] shadow-sky-500/20', text: 'text-sky-500' },
    done: { label: '已完成', dot: 'bg-emerald-500', text: 'text-emerald-500' },
};

/** 状态 → 词 / 点 / 文字色（未知值按未开始处理：脏数据不该让界面崩） */
export function unitStatusMeta(status: string): UnitStatusMeta {
    return status === 'doing' || status === 'done' ? UNIT_STATUS_META[status] : UNIT_STATUS_META.open;
}
