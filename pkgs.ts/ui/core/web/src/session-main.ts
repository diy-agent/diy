import { sessionReplayDemo } from "./demos/session_replay_demo.js";

/** 独立入口：只挂大会话压测，避免与 index 上的其它 demo 同页互相干扰。 */
const el = document.querySelector<HTMLElement>("#demo-session");
if (!el) throw new Error("mount point not found: #demo-session");
sessionReplayDemo(el);
