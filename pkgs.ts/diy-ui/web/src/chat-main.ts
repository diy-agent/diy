import { chatDslDemo } from "./demos/chat_dsl_demo.js";

/** 独立入口：聊天界面复刻（真实大会话 + 模拟发送）。A 风格（dom-dsl，纯 TS）。 */
const el = document.querySelector<HTMLElement>("#chat");
if (!el) throw new Error("mount point not found: #chat");
chatDslDemo(el);
