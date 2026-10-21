// @diy/facts — diy 事实库内核：事实身份 / 作用域解析 / claim 图 / 结构校验
//
// 零依赖、纯 TypeScript：不 import `node:fs` / `electron` / `@diy/app`，**不取时间**
// （`verifiedAt` 由调用方传入）。存储、生成器、CLI 都在消费侧（##404）。
//
//   import { validateFacts, buildIndex, resolveClaim, affected } from '@diy/facts';
//
//   const { facts, issues } = validateFacts(parsedYaml);   // 一次报全部问题
//   const index = buildIndex(facts);                       // claim 表 / 反查 / 冲突
//   resolveClaim(facts, 'app.port#default', { variant: 'test' });  // => 0
//   affected(index, ['pkgs.ts/diy-app/tests/x.test.ts']);  // => 需复核的 fact id
//
// 三条粒度（别混）：subject（对象）· claim = subject#aspect（**派生**查询键）·
// fact.id（**不可派生**的审计锚点，supersedes.to 指向它）。

export * from './types';
export { CLAIM_SEP, claimOf, parseClaim } from './claim';
export { pathCovers, scopeEqual, scopeKey, scopeMatches, scopeSpecificity, envsOf } from './scope';
export { resolveClaim, resolveClaims, type ReadCtx, type Resolved } from './resolve';
export { affected, buildIndex, refsOf, type Conflict, type FactsIndex, type Issue } from './index-build';
export { validateFacts, type Validation } from './validate';
