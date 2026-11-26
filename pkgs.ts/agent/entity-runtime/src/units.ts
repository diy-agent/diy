/**
 * units.ts —— 任务内「需求账本树」的**派生量**（纯函数，无 IO）。
 *
 * # 它是什么（2026-11-25 用户裁，收窄过一次）
 *
 * unit 只做一件事：**和人对齐「这件事要做成哪些东西」的账本**。
 *
 *   · 只有**树**：`parent` = 「这块功能由哪些子块组成」。人在分解需求时说的话天然是递归切分，
 *     树就是这句话的形状。
 *   · 只有**状态**：open / doing / done（容器由子派生）。
 *   · **没有执行规划**：谁先谁后、一次做几个、怎么并行 —— 那是 bot 自己每轮决定的，
 *     不进这个账本。曾经的 `deps` 边 / 分层 / 「同父兄弟串行」/ 交付批次全部删掉：
 *     它们让这一页从「要做什么」变成「怎么排期」，图上画出来人眼先花，模型也不看（它读文本）。
 *
 * # 三条派生
 *
 *   · `ready`  = **叶子**且 open。没有前置判定 —— 账本里「还没做的」就是可以挑的。
 *   · `doing`  = 叶子且 doing。
 *   · 容器（有子）不进 ready / doing：它是分组，不是可执行条目；状态由子派生（全 done → done）。
 *
 * # 为什么 ready 不再排除「被兄弟挡着」
 *
 * 串行是**执行策略**，不是需求事实。把策略写进账本会带来一串副作用（挡路者、异常例外、
 * 沿祖先链传递），而收益只是「模型不会同时挑两条」—— 那件事模型自己会看树判断。
 */
import { toYaml } from '@diy-agent/context';

import type { UnitRecord, UnitStatus } from './db';
import type { Item } from './types';

/**
 * 一条 unit 的**来源原话**（`source` 那个消息 id 解开之后的样子）。
 *
 * 为什么要拆成「谁 + 原话」（2026-11-26 用户）：「这是我要的吗」这个问题，光有消息 id
 * 答不了 —— id 要人再点一下、还得自己找是谁说的。发言人 + 原话摆在同一行才叫可核对。
 */
export interface SourceQuote {
    /** 发言人名字（`Item.author.name`）；空串 = 那条消息没有署名（notice / 老数据） */
    author: string;
    /** 说话人身份：`human` 才是「人提的」；`bot` / `system` 是 agent 自己或系统触发 */
    role: 'human' | 'bot' | 'system' | '';
    /** 原话（**已截断**，`…` 结尾 = 还有下文；全文点那个按钮跳过去看） */
    text: string;
}

/** 一个节点 + 它在树上的位置 */
export interface UnitBoardRow {
    id: string;
    title: string;
    body: string;
    /** 「怎么算做完」（空串 = 还没写；界面与上下文都靠它标出来，别拿 body 兜底） */
    accept: string;
    /** 来自哪句人话（`entity_items.id`；空串 = 不知道 —— 不编造来源） */
    source: string;
    /**
     * `source` 解开后的原话（谁 + 说了什么）；**没有就不带这个键**（老数据 / 消息已删 / 非人类触发）。
     *
     * 为什么不塞进 `unitBoard`：它是纯函数、不碰 IO；解开消息是 store 的活，
     * 由服务端拼好后经 `withSourceQuotes` 附上。
     */
    sourceQuote?: SourceQuote;
    /**
     * **有效**状态：叶子 = 落库值；容器 = 由子派生（全 done → done，否则 open）。
     * 容器落库的 status 不参与判断 —— 只有叶子能被勾 done。
     */
    status: UnitStatus;
    /** 父（功能域）；`null` = 根。父不存在（悬空 / 脏数据）时这里也报 `null`，见 `danglingParents` */
    parent: string | null;
    /** 子节点（按 `seq` 排 = 书写顺序） */
    children: string[];
    /** 有没有子 = 是不是「功能域容器」 */
    group: boolean;
    /** 树深（根 = 0）：视图按它缩进，`rows` 本身已是树的先序 */
    depth: number;
    /** 书写顺序（同一父下按它排；也是「树里第几条」的稳定依据） */
    seq: number;
}

export interface UnitBoard {
    /** 全部节点，**树的先序**（根按 seq，子按 seq）—— 视图直接照这个顺序缩进绘制 */
    rows: UnitBoardRow[];
    /** 根节点 id（树的先序） */
    roots: string[];
    /** 现在能做的：**叶子**且 open（账本语义：还没做的就是能挑的） */
    ready: string[];
    /** 正在做的叶子 */
    doing: string[];
    /** 派生状态为 done 的**全部**节点（含子已全 done 的容器） */
    done: string[];
    /** 容器（有子）的 id，树先序 */
    groups: string[];
    /** 父指向一个不存在的 id（脏数据 / 先建子后建父的中间态）：这些节点当根处理并报出来 */
    danglingParents: string[];
}

/** 只取算 board 要用的字段（测试里可以直接造这几项，不用凑齐 UnitRecord） */
export type UnitFacts = Pick<UnitRecord, 'id' | 'title' | 'status' | 'seq'> &
    Partial<Pick<UnitRecord, 'body' | 'accept' | 'source' | 'parent' | 'taskId' | 'createdAt' | 'updatedAt'>>;

/**
 * 算一张 board。输入顺序不敏感；输出顺序稳定（树的先序 → 创建序 → id）。
 *
 * 脏数据一律**降级而不是崩**：父不存在 / 父链成环 → 当根，并在 `danglingParents` 里点名。
 */
export function unitBoard(units: readonly UnitFacts[]): UnitBoard {
    const byId = new Map<string, UnitFacts>();
    for (const unit of units) byId.set(unit.id, unit);
    const seqOf = (id: string): number => byId.get(id)?.seq ?? 0;

    // ── 树：parent → children（子按 seq，兄弟先后即书写顺序）───────────────
    const danglingParents: string[] = [];
    const parentOf = new Map<string, string | null>();
    for (const unit of units) {
        const parent = unit.parent ?? null;
        // 父不存在（悬空）= 当根；自己也不是自己的父
        parentOf.set(unit.id, parent !== null && parent !== unit.id && byId.has(parent) ? parent : null);
        if (parent !== null && (parent === unit.id || !byId.has(parent))) danglingParents.push(unit.id);
    }
    // 父链成环（脏数据）：环上的节点当根，免得下面的遍历转不出来
    for (const unit of units) {
        const seen = new Set<string>([unit.id]);
        let cursor = parentOf.get(unit.id) ?? null;
        while (cursor !== null) {
            if (seen.has(cursor)) {
                parentOf.set(unit.id, null);
                if (!danglingParents.includes(unit.id)) danglingParents.push(unit.id);
                break;
            }
            seen.add(cursor);
            cursor = parentOf.get(cursor) ?? null;
        }
    }
    const childrenOf = new Map<string, string[]>();
    for (const unit of units) childrenOf.set(unit.id, []);
    for (const unit of units) {
        const parent = parentOf.get(unit.id) ?? null;
        if (parent !== null) childrenOf.get(parent)!.push(unit.id);
    }
    for (const children of childrenOf.values()) {
        children.sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    }

    // 树的先序（根按 seq）：`rows` 的排序就是它 —— 视图照这个顺序缩进即可
    const roots = units
        .filter((unit) => (parentOf.get(unit.id) ?? null) === null)
        .map((unit) => unit.id)
        .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b));
    const order: string[] = [];
    const depthOf = new Map<string, number>();
    const walk = (id: string, depth: number): void => {
        if (depthOf.has(id)) return; // 防御：环已经被拆掉了，这里只是别让脏数据无限递归
        depthOf.set(id, depth);
        order.push(id);
        for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);

    // ── 有效状态：自底向上（先序的逆序 = 子一定先算完）────────────────────
    const statusOf = new Map<string, UnitStatus>();
    for (const id of [...order].reverse()) {
        const children = childrenOf.get(id) ?? [];
        if (children.length === 0) {
            statusOf.set(id, byId.get(id)!.status);
            continue;
        }
        const childStatuses = children.map((child) => statusOf.get(child)!);
        statusOf.set(id, childStatuses.every((status) => status === 'done') ? 'done' : 'open');
    }

    // ── ready / doing / done：只有叶子能执行 ──────────────────────────────
    const ready: string[] = [];
    const doing: string[] = [];
    const done: string[] = [];
    for (const id of order) {
        const status = statusOf.get(id)!;
        const children = childrenOf.get(id) ?? [];
        if (status === 'done') {
            done.push(id);
            continue;
        }
        if (children.length > 0) continue; // 容器不进 ready / doing
        if (status === 'doing') {
            doing.push(id);
            continue;
        }
        ready.push(id);
    }

    const rows: UnitBoardRow[] = order.map((id) => {
        const unit = byId.get(id)!;
        return {
            id,
            title: unit.title,
            body: unit.body ?? '',
            accept: unit.accept ?? '',
            source: unit.source ?? '',
            status: statusOf.get(id)!,
            parent: parentOf.get(id) ?? null,
            children: childrenOf.get(id) ?? [],
            group: (childrenOf.get(id) ?? []).length > 0,
            depth: depthOf.get(id) ?? 0,
            seq: unit.seq,
        };
    });

    return {
        rows,
        roots,
        ready,
        doing,
        done,
        groups: rows.filter((row) => row.group).map((row) => row.id),
        danglingParents,
    };
}

/**
 * 原话截断上限：树上它只是一行注解，80 字足够认出「是不是我要的那句」；
 * 剩下的点那一行跳回原消息看全文。
 */
export const SOURCE_QUOTE_MAX_CHARS = 80;

/**
 * 把一条消息解成「来源原话」（纯函数）。
 *
 * 只认**有正文**的消息：chat / notice 取 `data.text`，error 取 `data.message`；
 * tool 条目没有正文、author 缺失的也不编造 —— 返回 `undefined`，界面上就是「不知道是谁提的」。
 *
 * 原话先压成一行（消息里的换行到树行上只会把树撑散），再按**码点**截断：
 * 按 UTF-16 下标切会把 emoji / 生僻字切成半个字符。
 */
export function sourceQuoteOf(item: Item): SourceQuote | undefined {
    const text =
        item.type === 'chat' || item.type === 'notice'
            ? item.data.text
            : item.type === 'error'
              ? item.data.message
              : '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat === '') return undefined;
    const chars = [...flat];
    const clipped = chars.length > SOURCE_QUOTE_MAX_CHARS ? `${chars.slice(0, SOURCE_QUOTE_MAX_CHARS).join('')}…` : flat;
    const role = item.author?.role;
    return {
        author: item.author?.name ?? '',
        role: role === 'human' || role === 'bot' || role === 'system' ? role : '',
        text: clipped,
    };
}

/** `sourceQuoteOf` 的批量形态：按**消息 id** 建表，直接喂 `withSourceQuotes`。 */
export function sourceQuotesOf(items: readonly Item[]): Map<string, SourceQuote> {
    const quotes = new Map<string, SourceQuote>();
    for (const item of items) {
        const quote = sourceQuoteOf(item);
        if (quote !== undefined) quotes.set(item.id, quote);
    }
    return quotes;
}

/**
 * 给 board 的每一行附上「来源原话」（纯函数：`quotes` 由调用方从 store 取）。
 *
 * 没有 quote 的行原样返回 —— 不编造来源；`source` 为空的行走不到这里（本来就没来源）。
 * 输入 board 不改（返回新对象），方便在 handler 里 `unitBoard(...)` 之后接着拼。
 */
export function withSourceQuotes(
    board: UnitBoard,
    quotes: ReadonlyMap<string, SourceQuote>,
): UnitBoard {
    if (quotes.size === 0) return board;
    const rows = board.rows.map((row) => {
        const quote = row.source === '' ? undefined : quotes.get(row.source);
        return quote === undefined ? row : { ...row, sourceQuote: quote };
    });
    return { ...board, rows };
}

/**
 * 把 board 渲染成**缩进树文本**（一行一个节点）—— 给人看、也直接进 system 上下文。
 *
 * 为什么不是 JSON：树的形状用缩进就表达完了，JSON 要为每层付 `{"children":[...]}` 的税，
 * 20 个节点能差出三四倍 token，而模型读缩进列表和读嵌套 JSON 一样准。
 *
 * 每行：`<缩进>- [状态] title （id）`，后面按需接 `body:`（`withBody`）。
 */
export function unitTreeLines(
    board: UnitBoard,
    options?: { withBody?: boolean },
): string[] {
    const ready = new Set(board.ready);
    const doing = new Set(board.doing);
    return board.rows.map((row) => {
        const indent = '  '.repeat(row.depth);
        const mark = row.status === 'done' ? 'x' : ready.has(row.id) ? '>' : doing.has(row.id) ? '~' : ' ';
        const tail: string[] = [];
        if (options?.withBody === true && row.body !== '') tail.push(`body: ${row.body}`);
        // 叶子缺验收口径 ⇒ 行尾点一句（「缺验收」）。这是**给人看的窟窿**，也让模型每轮都
        // 看到自己欠着什么 —— 用户 2026-11-26：「需求是可以验收的，步骤很难验收」。
        if (!row.group && row.accept.trim() === '') tail.push('缺验收');
        return `${indent}- [${mark}] ${row.title} (${row.id})${tail.length === 0 ? '' : `  ${tail.join('  ')}`}`;
    });
}

// ── 进 system 上下文的 `units` 节（模型读的文本由它决定）───────────────

/**
 * 全量形态的硬线：过线就退化成摘要（只给名字 + 计数，全树按需 `unit_list`）。
 *
 * 树行一行一个节点（缩进即层级），所以线按**行数**给更直观：40 行树 ≈ 3KB，
 * 正好是「常见 10~20 条账本天天读得起」的量级；超了才退摘要。
 */
const UNITS_FULL_MAX_BYTES = 4096;
const UNITS_FULL_MAX_LINES = 40;

/** `units` 节里一条「可做 / 在做」条目的形状 */
export interface UnitHead {
    id: string;
    title: string;
}

/** `units` 节的**值**（= 模型在上下文树里看到的那一节） */
export interface UnitsContextValue {
    ready: UnitHead[];
    doing: UnitHead[];
    tree?: string[];
    counts?: { open: number; doing: number; done: number };
    note?: string;
    /**
     * 提醒（`units-remind.ts` 的 B 档）：只在**有触发条件**时出现 ——
     * 账本还空着 / 上一轮之后有人发言。空树时它是整节唯一的内容，所以空树也会因此
     * 从「整节缺席」变成「一节带 hint 的值」。
     */
    hint?: string;
}

/**
 * `units` 节的**唯一**算法：模型读的上下文、界面「目标」视图的源码形态都调这一个函数。
 *
 * 为什么单独抽出来：它是「同一份事实只设计一次」的落点 —— 界面若自己再拼一遍文本，
 * 两边迟早在某个开关（溢出退化、行尾注释）上分叉，而人看界面时恰恰是在核对
 * 「模型到底读到了什么」。空树返回 `undefined`（= 整节缺席）。
 *
 * 去冗余：每个节点只在 `tree` 里出现一次（带状态）；`ready` / `doing` 再点名一次
 * 是因为那是**行动指令**，值得重复。`done` 不点名 —— 树行里的 `x` 就是答案。
 */
export function unitsContextValue(board: UnitBoard, hint?: string): UnitsContextValue | undefined {
    // 空树：没有 hint 就是整节缺席（不造空壳）；有 hint 时它就是这一节的**唯一**内容
    if (board.rows.length === 0) return hint === undefined ? undefined : { ready: [], doing: [], hint };
    const rowOf = new Map(board.rows.map((row) => [row.id, row] as const));
    const head = (ids: string[]): UnitHead[] => ids.map((id) => ({ id, title: rowOf.get(id)?.title ?? '' }));
    const tree = unitTreeLines(board);
    const tooBig = tree.length > UNITS_FULL_MAX_LINES || tree.join('\n').length > UNITS_FULL_MAX_BYTES;
    const extra = hint === undefined ? {} : { hint };
    if (!tooBig) return { ready: head(board.ready), doing: head(board.doing), tree, ...extra };
    const count = (status: UnitStatus): number => board.rows.filter((row) => row.status === status).length;
    return {
        ready: head(board.ready),
        doing: head(board.doing),
        counts: { open: count('open'), doing: count('doing'), done: count('done') },
        note: `账本树较大（${board.rows.length} 条），只给现在能挑的；全树用 unit_list`,
        ...extra,
    };
}

/**
 * `units` 节**落成文本**（YAML）。界面「源码」开关与调试入口都调它。
 *
 * 为什么不留下调用方自己 `toYaml`：文本与值必须同一份 —— 值这边一变（比如给 `ready`
 * 加字段），文本自动跟上；否则「界面显示的和模型读的」会静默分叉。
 *
 * `mode` 区分 `full` / `summary`（超过硬线退化）/ `empty`（还没建账本，整节缺席）：
 * 界面要能说清「为什么我看得到全树、模型只看到 ready」，不然容易被当成上下文丢了。
 */
export interface UnitsContextText {
    text: string;
    chars: number;
    mode: 'full' | 'summary' | 'empty';
    treeLines: number;
}

export function unitsContextText(board: UnitBoard): UnitsContextText {
    const value = unitsContextValue(board);
    if (value === undefined) return { text: '', chars: 0, mode: 'empty', treeLines: 0 };
    const text = toYaml({ units: value });
    return {
        text,
        chars: text.length,
        mode: value.tree === undefined ? 'summary' : 'full',
        treeLines: value.tree?.length ?? 0,
    };
}
