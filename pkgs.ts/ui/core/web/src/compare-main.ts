import { counterDemo } from "./demos/counter.js";
import { reactiveDemo } from "./demos/reactive_demo.js";
import { generatorCellDemo } from "./demos/generator_cell_demo.js";
import { asyncCellDemo } from "./demos/async_cell_demo.js";
import { streamDslDemo } from "./demos/stream_dsl_demo.js";

import { counterGenDemo } from "./demos/counter_gen_demo.js";
import { reactiveGenDemo } from "./demos/reactive_gen_demo.js";
import { generatorCellGenDemo } from "./demos/generator_cell_gen_demo.js";
import { asyncCellGenDemo } from "./demos/async_cell_gen_demo.js";
import { streamDemo } from "./demos/stream_demo.js";

/**
 * A/B 对照页：同一功能，
 *   左 = `app.div()`（providers/dom.ts，eager）
 *   右 = `yield html.div()`（providers/dom-gen.ts，pull）
 */

function mount(selector: string, setup: (el: HTMLElement) => void): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`mount point not found: ${selector}`);
  setup(el);
}

// A 风格（dom.ts / eager）
mount("#a-counter", counterDemo);
mount("#a-reactive", reactiveDemo);
mount("#a-generator", generatorCellDemo);
mount("#a-async", asyncCellDemo);
mount("#a-stream", streamDslDemo);

// B 风格（dom-gen / pull）
mount("#b-counter", counterGenDemo);
mount("#b-reactive", reactiveGenDemo);
mount("#b-generator", generatorCellGenDemo);
mount("#b-async", asyncCellGenDemo);
mount("#b-stream", streamDemo);
