# @diy-agent/attachment

附件**本体**：存哪、怎么取回、拷还是引用。

零 Electron、零 UI、零协议 —— 只碰文件系统（而且是唯一碰它的一层）。

## 为什么要有这个包

diy2 里「图进不了模型」的第一道坎不是协议也不是 UI，而是**字节没有一个确定的落点**：
剪贴板图没有路径、拖进来的文件有路径但可能被移走、工作区里的文件又不该拷一份（双份真相）。
本包把这件事定成两条入口 + 一个 `AttachmentRef`：

```ts
import { createBlobStore } from '@diy-agent/attachment';

const blobs = createBlobStore({ root: join(home, 'blobs') });

// ① 拷：字节不可从别处重建（剪贴板 / 远端 / 程序产物）
const batch = blobs.beginBatch(); // 一次发送 = 一个批次
const shot = await batch.putBytes({ bytes: pngBytes, name: 'screenshot.png', source: 'paste' });

// ② 引用：本体还在原处（工作区文件 / 目录）
const doc = await blobs.adopt({ path: '/Users/me/report.pdf' });
const dir = await blobs.adopt({ path: '/Users/me/Downloads/design' }); // kind=dir + 概览

shot.relPath; // '2026-11-26/093012-a1b2c3d4/01-screenshot.png'
await blobs.read(shot); // 取回字节（带 sha256 校验）
```

## 落盘形状

```
<home>/blobs/<YYYY-MM-DD>/<HHMMSS>-<batch8>/<NN>-<原名>.<ext>
```

批次 = 一次发送；`NN-` 保序；扩展名由 **mime** 定（不信用户后缀）；原名进 `displayName` 不丢。

## 两种 ref

| 形态     | 位置字段                   | 什么时候                          |
| -------- | -------------------------- | --------------------------------- |
| `stored` | `relPath`（相对 blobs 根） | 字节进了 blobs（不可重建）        |
| `linked` | `path`（绝对路径）         | 字节留在原处（工作区文件 / 目录） |

`kind`：`image`（唯一会进模型 content 的一类）/ `file` / `archive`（打包的目录）/ `dir`（目录引用）。

## 顺带做的事

- **mime 从魔数推**（png / jpeg / gif / webp / pdf / zip / gzip / heic / svg…）—— `.png` 里装 jpeg 是常态；
- **尺寸从文件头读**（png / jpeg / gif / webp）—— UI 排版与「该不该缩图」都要它；
- **名字归一**（防 `../` 逃逸、控制字符、超长多字节）—— 磁盘名安全，原名照留；
- **ref 校验**（`parseAttachmentRef`）—— 从消息 / db / RPC 读回来的都要过闸。

## 不做的事

不打包目录、不做缩图、不 base64、不碰消息与模型 —— 那三件分别是 `dir-and-archive`、
模型侧出图、协议层的事。
