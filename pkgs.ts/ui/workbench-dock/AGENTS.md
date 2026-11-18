# workbench-dock

页（page）/ 区域（area）/ 视图（view）的布局引擎。**实验包**，先看 `README.md` 的 API 再动代码。

## 职责

- 模板（区域树）→ dockview 布局（`src/compile.ts::compileLayout`）
- 旧布局 × 新模板 → 新布局（`src/compile.ts::resolveLayout`）
- 一个 page 实例的 React 渲染器 + `PageApi`（`src/react/PageWorkbench.tsx`）

不做：路由、侧栏、页的打开/关闭、主题、后端、业务。

## 硬约束

1. **`src/index.ts` / `src/model.ts` / `src/compile.ts` 不许有 React、DOM、Node 运行时依赖**（`import type` 可以）。
   纯模型是单测的地方（`tests/`），也是将来给别的渲染器复用的地方。
2. **布局只有一份真源**：dockview 快照。不要引入第二份「binding / hidden / hiddenViews」状态；
   要从布局里读什么，就写一个纯函数从快照读。
3. **`fromJSON` 之后必须显式 `setVisible`**：dockview 反序列化时组还没挂进 grid，叶子上的
   `visible:false` 对**组**不可靠（实测四个区域全都显示出来）。见 `applyLayout`。
4. **`components` 的引用必须永远稳定**（`useMemo(..., [])`）：变了 dockview 会重挂所有 panel。
   所以 view 外壳从 ref 读 scope / views / api，不从闭包读。
5. **区域树轴必须交替**：dockview 按嵌套深度换方向。`definePage` 已校验，别绕过。
6. 尺寸一律在编译期落成 px：`fr` 的语义是「同父兄弟分剩余空间」，运行期不再换算。

## 测试

```bash
./sha.sh check       # typecheck + lint + vitest
```

`tests/compile.test.ts` 覆盖：px 换算 / 收起 / primary / order / 轴交替 / placement 越界 / R1–R4 / dismissed / 回落模板。
UI 层不写单测（它只是把纯函数的结果喂给 dockview）：改动 UI 层请在 `apps/diy2` 的 `/dock.html` 里手验，
验收清单在 `README.md` 末节「跑范例」。
