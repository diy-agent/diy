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
 * ⚠️ 已知取舍：窗口被遮挡 / 最小化时 rAF 会被节流甚至暂停（同 TaskTree 那条注释），
 * 所以 run 里的写会顺延到窗口可见后那一帧。对「测量 → 改账 / 改尺寸」这类幂等写是安全的：
 * 下一次 RO 回调会重新测一遍，最终值不丢。
 */
export function createFrameBatcher(run: () => void): {
  /** 请求在下一帧执行 run（本帧已排过就合并） */
  schedule: () => void;
  /** 取消未执行的调度（组件卸载时用，避免 run 打到已卸载的 ref 上） */
  cancel: () => void;
} {
  let id: number | null = null;
  return {
    schedule() {
      if (id !== null) return;
      id = requestAnimationFrame(() => {
        id = null;
        run();
      });
    },
    cancel() {
      if (id !== null) cancelAnimationFrame(id);
      id = null;
    },
  };
}
