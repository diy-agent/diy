/**
 * LabPage — 提示词页（**子页面**，见 133「一页一中心」）。
 *
 * 定位：中心是「系统提示词编辑器」，左树 / 右预览 / 底部 chat 都是卫星。
 * 它不是一个「全局页面」，而是**挂在某个任务的任务执行 tab 之下的子页面**：
 *   - 上下文（ctx）= 任务 URI，与父共享
 *   - 生命周期挂在父上：关掉任务对话 → 本页一并关闭（由 tabStore 保证）
 *   - 不进顶级导航
 *
 * 实现上是一层薄壳：真正的调参 UI 与状态都在 PromptLabV4Page 的闭包里
 * （不拆 context 是为了把改动限制在渲染层，状态保持单点）。
 */
import { onMount } from "solid-js";
import { PromptLabV4Page } from "./PromptLabV4Page";
import { taskStore } from "../store/taskStore";

export function LabPage(props: { uri: string }) {
    // 子组件（模板引擎 / 预览）沿用 taskStore.selectedUri 作为场景，
    // 故本页负责把「当前 tab 的 ctx」与「选中任务」对齐。
    onMount(() => {
        if (taskStore.selectedUri !== props.uri) void taskStore.selectTask(props.uri);
    });
    return <PromptLabV4Page />;
}
