// segment-snapshot —— **已搬到 `@diy-agent/context/snapshot`**（2026-11-19）。
//
// 为什么搬：段首快照判据（system 段内逐字复用 / 只有压缩才重建）是**缓存契约**，
// 不属于某个宿主。留在 app 里，每接一个新宿主（bot / diy2）就要复刻一遍，
// 那正是「测试都过、缓存还是失效」的来源。
//
// 本文件只做兼容转发；新代码直接 import 包。
export * from "@diy-agent/context/snapshot";
