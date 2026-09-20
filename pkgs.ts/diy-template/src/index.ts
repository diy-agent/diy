// @diy/template — 提示词模版引擎（阶段 1）
//
// 纯 TS、零依赖、无 fs / 无 Electron：include 的解析由宿主注入 resolver。
//
//   import { parse, render, renderWithTrace, analyze } from '@diy/template';
//
//   render('<diy>{{diy.cli}}</diy>', { globals: { diy: { cli: '/repo/diy.sh' } } });
//   // => '<diy>/repo/diy.sh</diy>'
//
// 语法速览（详见 SPEC.md）：
//   {{path}}                             插值（.x 读动态作用域，a.b 读 globals，. 读当前循环项）
//   \{{  /  <raw>…</raw>                 逃生舱：输出字面量
//   <template :if="p">…</template>       条件（:unless 取反）
//   <template :for="x of p">…</template> 循环（{{.index}} 内建下标）
//   <template :include="./a.md" task=".task" />  片段调用（非控制属性即参数）
//   <anything :if="p">…</anything>       控制属性也可挂在输出元素上
//
// 硬规则：不转义、不 trim、不删行（逐字节可预测）；未知路径/参数一律报错，不静默。

export { TemplateError } from './errors';
export type { Loc, TemplateErrorCode, TemplateErrorInit } from './errors';

export { parse } from './parser';
export type { ParseOptions } from './parser';

export { render, renderWithTrace, byteLength } from './render';
export type { IncludeResolver, IncludeTarget, RenderOptions, RenderResult, TraceKind, TraceNode } from './render';

export { isTruthy, falsyReason, resolvePath, resolveForOutput } from './scope';
export type { DynamicFrame, RenderContext } from './scope';

export { analyze, analyzeNodes, collectDynamicRefs } from './analyze';
export type { Analysis, ConditionRef, IncludeRef, LintIssue, LoopRef, PathRef } from './analyze';

export type { ForNode, IfNode, IncludeArg, IncludeNode, InterpNode, Node, TextNode } from './ast';
