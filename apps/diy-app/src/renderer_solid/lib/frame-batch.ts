/**
 * frame-batch — 把「ResizeObserver 回调里的写操作」推迟到下一帧，同帧只跑一次。
 *
 * 为什么必须有它（##522）：RO 回调里**同步**改布局（setSignal → 重排 → 尺寸又变）会让
 * Chromium 在同一帧内反复投递同一个观察者；超限就丢弃剩余通知，并向 window 抛一条
 * `ResizeObserver loop completed with undelivered notifications`（error 级）。它不影响功能
 * （下一帧照常回调），但一次抖动可以连发几十条，把 main.log 与终端刷满。
 *
 * 断链的办法：**测量留在回调里**（读 offsetHeight / clientHeight 不引起布局），
 * **写（setState、写 scrollTop、改 grid 轨道）挪到下一帧**。帧边界就是 Chromium 的
 * "一次投递循环"边界 —— 写落在新帧，就不会被算进上一帧的循环。
 *
 * ⚠️ 只靠 rAF 不够（回归过，用户体感「发送消息后卡住、圈一直转、过很久才好」）：
 * 窗口被遮挡 / 最小化 / GPU 进程崩溃重建期间 rAF 会被节流甚至暂停（同 TaskTree 那条注释），
 * 于是「该刷的视口高度」迟迟不刷，虚拟窗口不重算 ⇒ 新消息不渲染，只能等下一次事件来救。
 * 所以**定时器兜底**：fallbackMs 到点也执行一次（正常情况 rAF 先跑、定时器被清掉）。
 */
export function createFrameBatcher(
  run: () => void,
  opts: { fallbackMs?: number } = {},
): {
  /** 请求在下一帧执行 run（本帧已排过就合并） */
  schedule: () => void;
  /** 取消未执行的调度（组件卸载时用，避免 run 打到已卸载的 ref 上） */
  cancel: () => void;
} {
  // 兜底：rAF 在窗口被遮挡 / 最小化 / GPU 进程崩溃重建期间会被节流甚至暂停，
  // 只靠它就会「该刷的尺寸迟迟不刷」——用户看到的是界面卡住、过很久才恢复（##522 回归）。
  // 定时器到点也执行一次，正常情况 rAF 先跑、定时器被清掉。
  const fallbackMs = opts.fallbackMs ?? 120;
  let rafId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (timer !== null) clearTimeout(timer);
    rafId = null;
    timer = null;
    run();
  };
  return {
    schedule() {
      if (rafId !== null || timer !== null) return;
      rafId = requestAnimationFrame(fire);
      timer = setTimeout(fire, fallbackMs);
    },
    cancel() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timer !== null) clearTimeout(timer);
      rafId = null;
      timer = null;
    },
  };
}
