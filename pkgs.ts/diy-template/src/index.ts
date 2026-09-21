// @diy/template — 提示词模版引擎（阶段 1）
//
// 纯 TS、零依赖、无 fs / 无 Electron：include 的解析由宿主注入 resolver。
//
//   import { parse, render, renderWithTrace, analyze } from '@diy/template';
//
//   render('<diy>{{diy.cli}}</diy>', { globals: { diy: { cli: '/repo/diy.sh' } } });
//   // => '<diy>/repo/diy.sh</diy>'
//
// 语法速览（详见 SPEC.md，意图测试为单一真源）：
//   {{path}}                             插值（.x 读动态作用域/循环信封/参数，a.b 读 globals；{{.}} 已取消）
//   \{{  /  \<  /  <raw>…</raw> / ```围栏  逃生舱：输出字面量（围栏内一律不解析）
//   <template :if={{p}}>…</template>           条件（:if-not 取反）
//   <template :for={{p}} :as="x">…</template> 循环：集合写 :for，名字写 :as（信封 .x.value/.index/.isFirst）
//   属性值：整值单个插值 {{x}} = 表达式（保留类型）；引号内文本 = 字面量
//   <template :include="./a.md" task={{.task}} />  片段调用（非控制属性即参数，动态作用域硬隔离）
//   <anything :if={{p}}>…</anything>       带控制属性的标签即容器（判据 C），标签原样输出
//
// 硬规则：不转义、不 trim、不删行（逐字节可预测）；未知路径/参数一律报错，不静默。

export { TemplateError } from './errors';
export type { Loc, TemplateErrorCode, TemplateErrorInit } from './errors';

export { parse } from './parser';
export type { ParseOptions } from './parser';

export { render, renderWithTrace, byteLength, previewValue } from './render';
export type { IncludeResolver, IncludeTarget, RenderOptions, RenderResult, TraceKind, TraceNode } from './render';

export { isTruthy, falsyReason, resolvePath, resolveForOutput } from './scope';
export type { DynamicFrame, RenderContext } from './scope';

export { analyze, analyzeNodes, collectDynamicRefs } from './analyze';
export type { Analysis, AnalyzeOptions, ConditionRef, IncludeRef, LintIssue, LoopRef, PathRef, VarSpec } from './analyze';

export type { ForNode, IfNode, IncludeArg, IncludeNode, InterpNode, Node, TagNode, TextNode } from './ast';
