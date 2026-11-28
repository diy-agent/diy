# @diy-agent/models-dev-snapshot

models.dev 规格快照的**独立包**。给 `@diy-agent/model-catalog` 当离线兜底：用户数据根没有 `data/models.dev.json` 时，从包内读全量快照。

## 快照不进 git

`data/` 在本包的 `.gitignore` 里。快照由脚本生成：

```bash
./sha.sh gen-models           # 平时用这个（sync / build 也会自动调，一天内跳过）
./sha.sh gen-models --force   # 强制重拉
```

底下的实现是 `npm run gen -w @diy-agent/models-dev-snapshot`。

- 拉 `https://models.dev/api.json`（约 6.5 MB / 326 家 / 一万模型）
- 带 `If-None-Match` 条件请求，接口回 304 就只续期本地文件
- 内部新于 24 小时直接复用；离线且有旧快照时只警告、保留旧文件
- `prepare`（npm install 时）与 `prepack`（发包时）都会跑：`prepack` 用 `MODELS_DEV_STRICT=1`，拉不到就报错，保证发出去的包一定有快照

可覆盖：`MODELS_DEV_URL`（换源）。

## 用法

```ts
import { bundledSnapshotPath, hasBundledSnapshot } from '@diy-agent/models-dev-snapshot';
```

只暴露路径，不 import JSON —— 6.5 MB 在启动时解析要几十毫秒，真要用时再读。

## 为什么照 opencode 做

opencode 把 `snapshot.txt`（8.9 MB）作为文本打进 npm 包，运行时再去拉网盖在上面，版本化缓存，发版前跑 `update-models-snapshot`。我们采用同一形态，区别是快照由 gen 脚本生成、不落在 git 里。

npm 上叫 `models.dev` 的包是空壳（v0.0.0，2025-06 后未更新），不能依赖。
