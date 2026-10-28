// components/DeleteEntryButton.tsx — 行内删除入口（任务行 / 项目行共用）。
//
// 只表达「请求删除」，**弹窗由持有列表的组件（TaskTree）渲染**：
//   - 表格行内嵌 fixed 覆盖层要防 table 布局与祖先 transform 的裁剪，得不偿失；
//   - 同一时刻本就只该有一个确认弹窗，状态放在列表层天然满足（先例：ModelConfigPage 的 pendingRemove）。
export function DeleteEntryButton(props: { title: string; onRequest: () => void }) {
    return (
        <button
            class="opacity-40 hover:opacity-100 hover:text-error text-body px-1 shrink-0"
            title={props.title}
            onClick={(e) => {
                // 行本身有 hover 预览 / 选中 / 点击开详情等委托，删除按钮必须自成一击
                e.stopPropagation();
                props.onRequest();
            }}
        >
            🗑
        </button>
    );
}
