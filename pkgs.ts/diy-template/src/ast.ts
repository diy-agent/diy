// ast.ts — 语法树类型
//
// 只有 5 类节点（保持最小）：
//   text    原样文本
//   interp  {{path}} 插值
//   element 输出元素（标签原样透传给提示词）
//   if      <template :if> / :unless，或挂在输出元素上的同名属性
//   for     <template :for>，或挂在输出元素上的 :for
//   include <template :include="…" 参数… />

import type { Loc } from './errors';

/** 属性值片段：字面量 或 {{path}} */
export type AttrPart = string | { path: string; loc: Loc };

/** 输出元素的属性（值里可以含 {{path}}，解析期就拆成片段，渲染时拼接） */
export interface AttrNode {
    name: string;
    parts: AttrPart[];
    loc: Loc;
    /** 源里是无值属性（如 <br disabled>）→ 渲染时原样输出，不补 ="". */
    bare: boolean;
}

export interface TextNode {
    type: 'text';
    value: string;
    loc: Loc;
}

export interface InterpNode {
    type: 'interp';
    /** 路径：'.x' / '.x.y' 读动态作用域，'a.b' 读 globals，'.' 读当前循环项 */
    path: string;
    loc: Loc;
}

export interface ElementNode {
    type: 'element';
    /** 标签名（原样输出） */
    name: string;
    attrs: AttrNode[];
    selfClosing: boolean;
    /** 自闭合时，属性与 `/>` 之间的原始空白（逐字节保真用） */
    closeSpace: string;
    children: Node[];
    loc: Loc;
    /** :omit-empty="true"：渲染后子文本为空/纯空白时连标签一起省略 */
    omitEmpty: boolean;
}

export interface IfNode {
    type: 'if';
    /** 条件路径（只允许 path，阶段 1 无表达式） */
    path: string;
    /** true = :unless（取反） */
    negate: boolean;
    children: Node[];
    loc: Loc;
}

export interface ForNode {
    type: 'for';
    /** 循环变量名，进动态作用域（模版里用 {{.item}} 访问） */
    item: string;
    /** 数据源路径 */
    source: string;
    children: Node[];
    loc: Loc;
}

/** include 参数：name 是被调模版里的动态名（模版里写 {{.name}}），path 在调用方求值 */
export interface IncludeArg {
    name: string;
    path: string;
    loc: Loc;
}

export interface IncludeNode {
    type: 'include';
    /** 相对当前模版的路径，必须以 ./ 开头 */
    relpath: string;
    args: IncludeArg[];
    loc: Loc;
}

export type Node = TextNode | InterpNode | ElementNode | IfNode | ForNode | IncludeNode;
