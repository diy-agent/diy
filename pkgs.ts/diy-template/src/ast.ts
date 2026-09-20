// ast.ts — 语法树类型
//
// 只有 5 类节点（保持最小）：
//   text    原样文本（**输出标签也是 text**：<diy>、<project_instructions path="{{p}}">）
//   interp  {{path}} 插值
//   tag     带控制属性的标签容器（<description :if>…</description>）：标签原样，内部受控
//   if      <template :if> / :if-not
//   for     <template :for={{集合}} :as="item">
//   include <template :include="./a.md" 参数… />

import type { Loc } from './errors';

export interface TextNode {
    type: 'text';
    value: string;
    loc: Loc;
}

export interface InterpNode {
    type: 'interp';
    /** 路径：'.x' / '.x.y' 读动态作用域（循环信封 / include 参数），'a.b' 读 globals */
    path: string;
    loc: Loc;
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
}

export interface IfNode {
    type: 'if';
    /** 条件路径（只允许 path，阶段 1 无表达式） */
    path: string;
    /** true = :if-not（取反） */
    negate: boolean;
    children: Node[];
    loc: Loc;
}

export interface ForNode {
    type: 'for';
    /** 循环变量名（:as="f"）：进动态作用域，其值为迭代信封 { value, index, isFirst, isLast } */
    as: string;
    /** 集合表达式（:for={{…}}） */
    source: string;
    children: Node[];
    loc: Loc;
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
}

export type Node = TextNode | InterpNode | TagNode | IfNode | ForNode | IncludeNode;
