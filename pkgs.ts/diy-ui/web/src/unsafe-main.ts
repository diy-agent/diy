import { unsafeDemoA, unsafeDemoB } from "./demos/unsafe_demo.js";

/** 独立入口：`节点方法 + .unsafe` 逃生口演示（A/B 各一份）。 */
const a = document.querySelector<HTMLElement>("#a");
const b = document.querySelector<HTMLElement>("#b");
if (!a || !b) throw new Error("mount point not found: #a / #b");
unsafeDemoA(a);
unsafeDemoB(b);
