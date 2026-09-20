// ast.ts — 语法树类型
//
// 只有 5 类节点（保持最小）：
//   text    原样文本（**输出标签也是 text**：<diy>、<project_instructions path="{{p}}">）
//   interp  {{path}} 插值
//   if      <template :if> / :unless
//   for     <template :for>
//   include <template :include="…" 参数… />

import type { Loc } from './errors';

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

export type Node = TextNode | InterpNode | IfNode | ForNode | IncludeNode;
