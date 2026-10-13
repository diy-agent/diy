// event.ts — 事件原语：容器里的一条记录（##166 §10.2 的统一原语）
//
//   Event { id, author, anchor, content, causes, at }
//
// 为什么统一成一个 Event 而不是「消息 / 转移」两套（##166 §10.2 的结论）：
// 泳道容器与消息容器的差别只在**容器不变量**（单指针有序 vs 多锚点累积），
// 记录本身的形状是同一个 —— 「不是像，是同一个东西的两组规则」。
//
// 本包只做数据 + 纯函数：**不取时间**（`at` 由调用方传入）、不做存储、不做装配。

import { parseAnchor, type Anchor } from './anchor';
import { takeObject, takeString, takeStringArray } from './validate';

export interface Event {
    readonly id: string;
    /** 谁产生的：agent id / `human`（人是一等参与者，##166 §7.5） */
    readonly author: string;
    /** 这条事件指向谁 / 指向哪 */
    readonly anchor: Anchor;
    /** 正文；渲染成什么形状由装配侧决定（结论 13：存结构、装配时渲染） */
    readonly content: string;
    /** 触发谁：本事件导致的后续事件 id 列表（无则空数组） */
    readonly causes: readonly string[];
    /** 发生时刻，由调用方传入的 ISO 字符串（本包不取时间） */
    readonly at: string;
}

export interface EventInit {
    id: string;
    author: string;
    anchor: Anchor;
    content: string;
    /** 缺省空数组 */
    causes?: readonly string[];
    at: string;
}

/** 构造事件：形状不对立即报错（缺省 `causes` 补空数组，避免 undefined 混进存储） */
export function createEvent(init: EventInit): Event {
    return parseEvent({ ...init, causes: init.causes ?? [] }, 'event');
}

const CODE = 'invalid-event' as const;

/**
 * 校验并规范化事件；非法一律抛 `invalid-event`（带点路径）。
 * `causes` 缺省视为 `[]` —— 「没有触发谁」只有这一种表示，缺省不丢信息；
 * 其余字段缺失一律报错（`at` 没有自然缺省：时间是事实，不能凭空补）。
 */
export function parseEvent(value: unknown, path = 'event'): Event {
    const obj = takeObject(value, path, CODE);
    return {
        id: takeString(obj.id, `${path}.id`, CODE),
        author: takeString(obj.author, `${path}.author`, CODE),
        anchor: parseAnchor(obj.anchor, `${path}.anchor`),
        content: takeString(obj.content, `${path}.content`, CODE, true),
        causes: obj.causes === undefined ? [] : takeStringArray(obj.causes, `${path}.causes`, CODE),
        at: takeString(obj.at, `${path}.at`, CODE),
    };
}

export function isEvent(value: unknown): value is Event {
    try {
        parseEvent(value);
        return true;
    } catch {
        return false;
    }
}
