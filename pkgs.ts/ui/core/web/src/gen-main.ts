import { chatGenDemo } from "./demos/chat_gen_demo.js";

/** 独立入口：聊天界面复刻（真实大会话 + 模拟发送）。B 风格（dom-gen，generator/pull）。 */
const el = document.querySelector<HTMLElement>("#chat");
if (!el) throw new Error("mount point not found: #chat");
chatGenDemo(el);
