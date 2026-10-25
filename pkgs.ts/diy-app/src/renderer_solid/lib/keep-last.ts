/**
 * keep-last — 把「可能转成 null/undefined 的派生值」包成**永不回退到空**的访问器。
 *
 * 为什么需要（##428）：`<Show when={x()}>{(a) => …a()…}</Show>` 的 children accessor
 * 在 `x` 变 falsy 的那一批里**不安全**。Solid 的 flush 顺序是「condition → 下游 memo →
 * Show 自身释放子节点」：`x` 失效时，先重算 `condition`，再重算子块里订阅 `a()` 的 memo，
 * 最后才是 Show 的 memo 把子节点 dispose。也就是说**下游 memo 会比销毁早一拍读到
 * `a()`**，而 `a()` 一看 condition 已 falsy 就抛
 * `Attempting to access a stale value from <Show>`。
 *
 * 这个「早一拍」平时看不出来（同一批里马上就销毁了），但 `x` 往往是在异步续体里被置空的
 * （`await` 之后 `setX(null)`）⇒ 抛错一路冒成**未接的 Promise 拒绝**（`Uncaught (in promise)`），
 * 后半段代码也不再执行。
 *
 * 用法：子块**不要读 Show 的 accessor**，改读基于同一数据源的 `keepLast(...)`：
 *
 * ```tsx
 * const shown = keepLast(source); // Accessor<T | undefined>
 * <Show when={source()}>{( _a ) => <Child value={shown()!} />}</Show>
 * ```
 *
 * 语义：源为 null 时回退到**最近一次非空值**。这一拍显示旧值无害 —— 子节点下一拍就被释放，
 * 而且总比抛错中断强（用户可见的「切任务偶发报红」正是这么来的）。
 *
 * 所属 owner 与调用点一致：随组件一起销毁，不需要额外清理。
 */
import { createMemo, type Accessor } from "solid-js";

export function keepLast<T>(source: Accessor<T | null | undefined>): Accessor<T | undefined> {
    return createMemo<T | undefined>((prev) => source() ?? prev, undefined);
}
