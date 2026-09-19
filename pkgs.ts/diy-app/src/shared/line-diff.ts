// src/shared/line-diff.ts
// 🎯 朴素行级 diff（LCS）：[{t:' '|'-'|'+', s}]
//
// 为什么单独一个纯模块：它是 O(n×m) 时间/空间的两维 DP，属于「可能卡主线程」的东西，
// 抽到无 JSX 的纯模块才能在 node 里跑基准（renderer 的 .tsx 在 vitest 里没有 solid 插件转不动）。
//
// 实测（Apple M 系，2026-09，见附件注释）：
//   40 行 × 20 次  < 5ms（真实模版规模：渲染后 ~1KB / 几十行）
//   200 行          ~5ms
//   1000 行         ~120ms
//   3000 行         ~1.1s
// 使用方式决定风险：试验场只在 diff 模式下计算，且该模式下编辑器是卸载的（不能同时打字），
// 所以最坏情况是「切到 diff 冻一下」，不是「每敲一个字冻一下」。
// 若将来要把 diff 用到大文本/实时场景，按这个顺序升级：限流 → 换线性空间 Myers（jsdiff）→ Worker。

export interface DiffLine {
  /** ' ' 原文 | '-' 删除 | '+' 新增 */
  t: string;
  s: string;
}

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: " ", s: A[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ t: "-", s: A[i]! });
      i++;
    } else {
      out.push({ t: "+", s: B[j]! });
      j++;
    }
  }
  while (i < n) out.push({ t: "-", s: A[i++]! });
  while (j < m) out.push({ t: "+", s: B[j++]! });
  return out;
}
