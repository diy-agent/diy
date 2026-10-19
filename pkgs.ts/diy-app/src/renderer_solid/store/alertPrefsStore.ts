import { createSignal } from "solid-js";

/**
 * 提示偏好（##358 D3）—— 目前只有一项：**「异常终止 / 有人在等」要不要自动拉回视线**。
 *
 * 与 `sessionStore` 的水位同路：落 **localStorage**（renderer 本地视图量，**不回写 main**；
 * `rule.core-log` / R3：core 不需要知道"谁看过什么、提不提示"）。同 profile 多窗口共享一份
 * ⇒ "我关掉自动拉回"在多窗口里也是一致的（同 [1] ##306 的多客户端语义）。
 * ⚠️ **临时实现**：若将来要 CLI / web 对等读这个偏好，再升级为 `$DIY_HOME` 侧车文件。
 */
const KEY = "diy_session_autopull";

function load(): boolean {
    try {
        return globalThis.localStorage?.getItem(KEY) !== "0"; // 缺省**开**（demo v4 口径）
    } catch {
        return true;
    }
}

const [autoPull, setAutoPullSig] = createSignal(load());

export const alertPrefsStore = {
    /** 自动拉回是否开启（缺省开） */
    get autoPull() { return autoPull(); },
    setAutoPull(on: boolean) {
        setAutoPullSig(on);
        try { globalThis.localStorage?.setItem(KEY, on ? "1" : "0"); } catch { /* 无 localStorage（node 测试）忽略 */ }
    },
};
