/**
 * onEnterKey — Enter 键触发回调（自动跳过 IME 组合态）
 *
 * 用法：
 *   <textarea onKeyDown={onEnterKey(submit, { shiftNewline: true })} />
 *   <input     onKeyDown={onEnterKey(submit)} />
 *
 * - 所有拼音/日文等 IME 输入时，回车选词不会误触发
 * - shiftNewline=true：Shift+Enter 放行（用于 textarea 换行）
 */
export function onEnterKey(
  callback: () => void,
  opts?: { shiftNewline?: boolean },
): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" && !e.isComposing && !(opts?.shiftNewline && e.shiftKey)) {
      e.preventDefault();
      callback();
    }
  };
}
