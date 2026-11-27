# @diy-agent/attachment — 附件本体（存哪 · 怎么取回 · 拷还是引用）

> 全仓契约见**仓库根 `AGENTS.md`**。本包只回答「字节在哪」：**不认识消息、不认识模型、不认识 UI**。
> 消息形状归 `@diy-agent/protocol`（`Item.chat.data.attachments`），进模型归
> `@diy-agent/model-provider`（`toModelMessages` 出 image part），落盘目录由宿主给（`<home>/blobs`）。

## 磁盘形状（与用户 2026-11-26 定）

```
<home>/blobs/<YYYY-MM-DD>/<HHMMSS>-<batch8>/<NN>-<原名>.<ext>
```

- **批次 = 一次发送**（同批多图共享目录）⇒ 可整批回看、整批删
- `NN-` 保序（多图顺序有意义）；`<ext>` 由 mime 定，**不信原名后缀**
- 原名 sanitize 后进磁盘名，**全名另存 `ref.displayName`**（一个字都不丢）

## 两条入口 = 用户问的那条判据

**能不拷就不拷**：本体能从别处重建的只记路径，不能的才拷。

| 入口 | 用途 | 判据 |
|---|---|---|
| `beginBatch().putBytes / putFile` | 拷进 blobs | 剪贴板图、远端下载、程序临时产物（`/tmp` 会被清） |
| `adopt({ path })` | 只记路径 | 工作区文件 / 用户自己管着的目录 |

ref 因此有两支：`stored`（有 `relPath`）/ `linked`（有 `path`）。目录**只能** `linked`——
要么引用，要么先打成 `archive` 再 `stored`（原样拷成目录树不做，理由见 `store.ts` 头注）。

## 四条最容易破的约束

1. **别把 `path` 和 `relPath` 混用**：`relPath` 永远相对 blobs 根，折出去就跑不回来（`unsafe-path`）；
2. **别信声明**：mime 从魔数推（`.png` 里装 jpeg 是常态），扩展名从 mime 推（从不从名字来）；
3. **别静默降级**：逃逸 / 超限 / 被改过的文件一律抛 `AttachmentError` 带 code —— 静默丢图的症状是模型答非所问；
4. **别在 ref 里放绝对路径给模型看**：ref 是给宿主与 UI 的，模型只需要「有张图」。

## 取法

- `diy2 facts brief rule` / `brief tool` — 全局硬约束与工具偏好
- 需求真源：本包 `tests/store.test.ts`（磁盘形状 / 拷 vs 引用 / 安全与上限）
