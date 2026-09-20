// ast.ts — 语法树类型
//
// 只有 5 类节点（保持最小）：
//   text    原样文本（**输出标签也是 text**：<diy>、<project_instructions path="{{p}}">）
//   interp  {{path}} 插值
//   tag     带控制属性的标签容器（<description :if>…</description>）：标签原样，内部受控
//   if      <template :if> / :if-not
//   for     <template :for={{集合}} :as="item">
//   include <template :include="./a.md" 参数… />
//
// **源码区间**：每个节点都带 `end`（源码偏移，闭区间端点）；除 `:if`/`:for` 外 `loc.offset` 就是起点。
// `:if`/`:for` 的 `loc` 指向**控制属性**（报错要指到属性上），整段起点单列 `from`（开标签位置）。
// 试验场据此把「结构树节点 ↔ 模版里那段源码 ↔ 预览里那段产出」连起来高亮。

import type { Loc } from './errors';

export interface TextNode {
    type: 'text';
    value: string;
    loc: Loc;
    /** 源码终点（偏移，不含）：起点是 loc.offset */
    end: number;
}

export interface InterpNode {
    type: 'interp';
    /** 路径：'.x' / '.x.y' 读动态作用域（循环信封 / include 参数），'a.b' 读 globals */
    path: string;
    loc: Loc;
    end: number;
}

/** 带控制属性的标签容器：head/headClose 原样输出，children 受 :if / :for 控制 */
export interface TagNode {
    type: 'tag';
    /** 开标签原文（已剥掉控制属性，其余字符逐字节保留） */
    head: string;
    /** 闭合标签原文；自闭合为空串 */
    headClose: string;
    children: Node[];
    loc: Loc;
    end: number;
}

export interface IfNode {
    type: 'if';
    /** 条件路径（只允许 path，阶段 1 无表达式） */
    path: string;
    /** true = :if-not（取反） */
    negate: boolean;
    children: Node[];
    /** 报错用：指向控制属性 */
    loc: Loc;
    /** 整段起点（开标签位置）——高亮用 */
    from: number;
    /** 整段终点（闭合标记之后，含 standalone 吞掉的那个换行） */
    end: number;
}

export interface ForNode {
    type: 'for';
    /** 循环变量名（:as="f"）：进动态作用域，其值为迭代信封 { value, index, isFirst, isLast } */
    as: string;
    /** 集合表达式（:for={{…}}） */
    source: string;
    children: Node[];
    /** 报错用：指向控制属性 */
    loc: Loc;
    /** 整段起点（开标签位置）——高亮用 */
    from: number;
    end: number;
}

/**
 * 属性值（引号只是边界，不改变语义）：
 *   · 整值恰好是一个插值 → 表达式，取值**保留原类型**（数组仍是数组、布尔仍是布尔）
 *   · 其余 → 文本 + 插值点，渲染后字符串化
 */
export type ArgValue =
    | { kind: 'expr'; path: string }
    | { kind: 'text'; nodes: Node[] };

/** include 参数：name 是被调模版里的动态名（模版里写 {{.name}}），value 在调用方求值 */
export interface IncludeArg {
    name: string;
    value: ArgValue;
    loc: Loc;
}

export interface IncludeNode {
    type: 'include';
    /** 相对当前模版的路径，必须以 ./ 开头 */
    relpath: string;
    args: IncludeArg[];
    loc: Loc;
    end: number;
}

export type Node = TextNode | InterpNode | TagNode | IfNode | ForNode | IncludeNode;
