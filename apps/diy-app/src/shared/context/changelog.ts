// changelog.ts —— 已搬到 @diy-agent/context（2026-11-05）。
//
// 搬的理由：`changesOf` 是本包 `controlDeltaDelivery` 的**上游输入**（它算出「哪些原子单元变了」），
// 两者必须同源。留在 diy-app 里等于让 bot 抄一份（必走样）。
// 这里只做 re-export，diy-app 的调用点零改动。
export * from "@diy-agent/context/changelog";
