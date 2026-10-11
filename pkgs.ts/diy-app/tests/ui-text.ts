// tests/ui-text.ts
// 🎯 `ui-drive` 点击命中校验的**文本比较**：纯函数，零依赖。
//
// 为什么单独成模块（不写在 ui-drive.ts 里）：这段逻辑要注入**浏览器**求值
// （见 ui-drive.pointHitsText 的 `textHit.toString()`），而它可以（也必须）被单测钉死 ——
// 历史上它写在模板字面量里，`\s` 被吃掉退化成 `s`（正则变成「剥字母 s」），
// 对含空格的文本恒判「未命中」，症状是点击前的遮挡校验空转 19s 才放弃。
// 单独成文件还有个副作用好处：单测导入它不会连带加载 `ws`。

/**
 * 「坐标处命中的元素」与「期望文本」是否算同一个目标。
 *
 * 判据从宽：两侧去空白后**互含**即算命中 —— a11y 名与 DOM 文本常有细微差异（箭头字符等）。
 * 加 200 字长度上限：命中 body / 整页容器时它的文本必然包含 want，会把它误判成「命中」。
 *
 * ⚠️ 必须**自包含**（不引用本模块其它导出）：本函数会被 `toString()` 后注入浏览器求值，
 * 外部引用在浏览器作用域里不存在。
 */
export function textHit(hitText: string, want: string): boolean {
  const t = hitText.replace(/\s+/g, "");
  const w = want.replace(/\s+/g, "");
  if (!w || !t || t.length > 200) return false;
  return t.includes(w) || w.includes(t);
}
