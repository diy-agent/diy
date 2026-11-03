import { counterDemo } from "./demos/counter.js";
import { reactiveDemo } from "./demos/reactive_demo.js";
import { chatDemo } from "./demos/chat_demo.js";
import { asyncCellDemo } from "./demos/async_cell_demo.js";
import { generatorCellDemo } from "./demos/generator_cell_demo.js";

function mount(selector: string, setup: (el: HTMLElement) => void): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`mount point not found: ${selector}`);
  setup(el);
}

mount("#demo-counter", counterDemo);
mount("#demo-reactive", reactiveDemo);
mount("#demo-chat", chatDemo);
mount("#demo-async", asyncCellDemo);
mount("#demo-generator", generatorCellDemo);
