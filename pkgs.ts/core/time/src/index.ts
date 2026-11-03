// @diy-agent/time — 时间格式约定（##483）：**日志 / 事件 / 记录一律本地时区 + 偏移**。
//
//   localISOString()  2026-10-31T11:29:25.403+0800   ← 记录类时间戳的唯一写法
//   localDateKey()    2026-10-31                     ← 本地日期（按天分桶 / 查节假日）
//   localOffset()     +0800                          ← 当期本地偏移
//   instantOf() / compareInstant()                   ← 要比时刻就比时刻，别比字典序
//
// 为什么不是 `toISOString()`（UTC）：人读要心算时区；串里没偏移就说不清是哪的时间。
// 例外只有一个：**必须 UTC** 的字段（跨机器排序等）—— 字段名带 `utc` 后缀 + 注释写明原因。
//
// 边界：本包**零依赖、零 IO、不取当前时间**（`d` 缺省才取 `new Date()`），
// 故 renderer / 主进程 / 各能力包都能用；拿不到时区的纯数值（epoch 毫秒）不归它管。

export { TimeError } from './errors.js';
export type { TimeErrorCode } from './errors.js';

export { compareInstant, instantOf, localDateKey, localISOString, localOffset } from './local.js';
