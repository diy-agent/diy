// units-remind.ts —— 「提醒模型把人的话变成需求」的三种做法 + 需求 / 步骤的判据
//
// ── 要解决的事（2026-11-26 用户实测）──
// 模型不会自己把「人的一句话」变成账本条目：非要人说「把这件事拆成几步」它才动手。
// 而且拆出来的东西容易滑成**实现步骤 / 执行日志**（「改 db.ts」「跑测试」「先做 A 再做 B」）——
// 这个账本是**给人看的需求分解**：人要看到「这件事要做成什么」，每条都得能被验收；
// 「怎么做」是执行过程，写 journal 或不写。
//
// ── 三种提醒（用户裁：每条人话都该先判一遍有没有需求）──
//   A 常驻提示词：每轮 system 里都写「先判这句话里有没有新需求」+ 需求 / 步骤判据
//   B 信封注记：只在**有触发条件**时才在 `units` 节挂一行 `hint`（账本空 / 上一轮有人发言）
//   C 工具话术：把触发条件写进 `unit_add` 的描述（模型选工具时读的就是它）
//
// 为什么三种并存而不是挑一个：它们的**失效方式**不同 —— A 会被长提示词稀释、
// B 依赖状态判据准确、C 只在模型已经想「记点什么」时才生效。实验要看的正是这个差别，
// 所以这里做成可组合的开关（`DIY2_UNITS_REMIND=a` / `bc` / `off` …），
// 也允许用 `<home>/units-remind.txt` 覆盖 —— 这样在跑着的 lab 上换档位**不用重启**。

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 三档开关（各自独立） */
export interface RemindMode {
    /** A：常驻提示词 */
    prompt: boolean;
    /** B：信封注记（`units.hint`） */
    envelope: boolean;
    /** C：工具描述 */
    tool: boolean;
}

const OFF: RemindMode = { prompt: false, envelope: false, tool: false };
/** 缺省全开：三处口径一致，模型既在 system 里看到判据、也在工具描述里看到触发条件 */
const ALL: RemindMode = { prompt: true, envelope: true, tool: true };

/**
 * 解析档位字符串：`off` / `a` / `ab` / `abc` / 空 → 全开。
 *
 * 为什么不用枚举而用一个字母串：实验要跑「只开 A」「只开 B」这种组合，
 * 字符串能一眼看出开了哪几档，也方便命令行临时覆盖。
 */
export function parseRemindMode(raw: string | undefined): RemindMode {
    const value = (raw ?? '').trim().toLowerCase();
    if (value === '') return ALL;
    if (value === 'off' || value === 'none' || value === '0') return OFF;
    const mode: RemindMode = { ...OFF };
    for (const ch of value) {
        if (ch === 'a') mode.prompt = true;
        else if (ch === 'b') mode.envelope = true;
        else if (ch === 'c') mode.tool = true;
        // 其它字符忽略：写错一个字母不该让整个提醒消失（那会把「实验没效果」误判成「做法无效」）
    }
    return mode;
}

/** 实验期覆盖文件（放在数据根里，`<home>/units-remind.txt`）；不存在就是没覆盖 */
export function remindModeFile(home: string | undefined): string | undefined {
    return home === undefined ? undefined : path.join(home, 'units-remind.txt');
}

/**
 * 取当前档位：`DIY2_UNITS_REMIND` 环境变量 → `<home>/units-remind.txt` → 全开。
 *
 * 文件这一档是**给实验用的**：环境变量在进程启动时定死，而实验要在同一个 lab 实例上
 * 连跑几档（每档起一个新任务）。读文件即可换档，代价是一次 4KB 内的同步读
 * （只在开会话时读一次，不在每轮）。
 */
export function resolveRemindMode(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): RemindMode {
    const env = opts.env ?? process.env;
    const fromEnv = env['DIY2_UNITS_REMIND'];
    if (fromEnv !== undefined && fromEnv !== '') return parseRemindMode(fromEnv);
    const file = remindModeFile(opts.home);
    if (file !== undefined) {
        try {
            return parseRemindMode(readFileSync(file, 'utf8'));
        } catch {
            // 文件不存在 = 没覆盖（不是错误）：实验脚本按档位写/删它
        }
    }
    return ALL;
}

/**
 * 拆解判据：一句话 → 树还是单条（A / B / C 共用同一份措辞）。
 *
 * 2026-11-26 实测的教训：老文案写「有就先 unit_add 落成条目（一句话一条）」时，模型就**真的只落一条**
 * —— 提醒里的数量词会被当成目标（说「一条」就一条，说「2~5 条」才会成树）。所以这里必须写清
 * 「不止一步 → 母项 + 2~5 叶子」「一步的小改才单条」，两头都点名，模型才有个判据可用。
 */
export const DECOMPOSE =
    '**落条目先定形状**：数这句话里有几件「做完能被人验收的产出」—— ' +
    '≥2 件就一次 unit_add 出「母项（这件事要做成什么）＋ 2~5 条叶子（每件产出一叶）」；' +
    '只有 1 件、验收一句话说得完，才落单条。把整句话概括成一条就完事 = 人还得再说一遍「拆成几步」。' +
    '拆完在正文里用一行说清「拆成了哪几条」，人好核对。';

/** 需求 vs 步骤的判据（A / C 共用同一份措辞；别在两处各写一句） */
export const NEEDS_VS_STEPS =
    '**账本记需求，不记步骤**：一条 = 人能验收的「要做成什么」（「导出能用：点一下真落文件并说清落在哪」），' +
    '不是「怎么做」（改哪个文件 / 跑什么命令 / 先做哪步）—— 那些属于执行过程，写 journal 或不写。' +
    '每条叶子都要写 `accept`（一句话能判断完 / 未完的判据）；没写的人一眼看得见，会回来问你。';

/** A：常驻提示词（接在 toolsHint 末尾；`mode.prompt` 关着返回空串） */
export function promptReminder(mode: RemindMode): string {
    if (!mode.prompt) return '';
    return (
        // 「先看账本再回答」这句是实验里 bot 自己提的（它跑 B 档时把这条需求写进了自己改的文案）：
        // 光说「有需求就先 unit_add」时，模型倾向于先长篇回答、事后再补（那时已经忘了）。
        '\n**人说话的当轮，先看账本再回答**：用户每句话先问一遍「这要我做点什么」—— ' +
        '要做就把 unit_add 当第一个动作落成树，然后才回答；不要先写长篇回答、事后再补账本。' +
        '只有纯提问（要的只是一句话的答案、没让你改任何东西）才不落条目；别等人说「拆一下」。' +
        '\n' +
        DECOMPOSE +
        '\n' +
        NEEDS_VS_STEPS +
        '\n**每轮从账本里挑活**：上下文 units 节的 ready 就是现在能挑的（不必先 unit_list），挑 1~3 条做；' +
        '开做标 doing、做完标 done，需求变了就让树跟着变（unit_update / unit_drop）。'
    );
}

/** C：`unit_add` 描述里的触发条件（`mode.tool` 关着返回空串） */
export function toolReminder(mode: RemindMode): string {
    if (!mode.tool) return '';
    return (
        '用户这句话里**如果有新需求**，先调用它把需求记下来再动手 —— 不要等被要求「拆一下」。' +
        DECOMPOSE +
        NEEDS_VS_STEPS
    );
}

/** B 判据的输入：由房间在开每轮上下文时算 */
export interface RemindState {
    /** 账本一条都没有 */
    empty: boolean;
    /** 上一次账本变更之后，有人类发过言（= 这条人话可能带来新需求） */
    humanSince: boolean;
}

/**
 * B：`units` 节里的那一行 `hint`（`mode.envelope` 关 / 没有触发条件 → undefined）。
 *
 * 为什么只在有触发条件时出现：常驻一句「别忘了建账本」会变成噪音（模型很快学会忽略），
 * 而「账本空着」和「刚有人说了新要求」是**两个具体的事实**，读到就能动手。
 */
export function envelopeHint(mode: RemindMode, state: RemindState): string | undefined {
    if (!mode.envelope) return undefined;
    if (state.empty)
        return (
            '账本还是空的：这句话里要做的事，先拆成「母项 + 2~5 条可验收的叶子」再动手' +
            '（只有一步的小改就落一条；别记实现步骤）'
        );
    if (state.humanSince)
        return (
            '上一轮之后有人发言：先数这句话里有几件可验收的产出 —— ≥2 件就 unit_add 出「母项 + 叶子」' +
            '（已有条目要改的用 unit_update），再回答；别把需求留在正文里'
        );
    return undefined;
}
