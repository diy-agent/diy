import { App, Header, Label, Horizontal, Vertical } from "@whonb/dao-tui";
import { Text as PiText, type Component as PiComponent } from "@mariozechner/pi-tui";
import chalk from "chalk";

class DemoApp extends App {
  *compose(): Iterable<PiComponent> {
    yield new Header("DAO-TUI DECLARATIVE DEMO");
    yield new PiText("");
    
    yield new Horizontal(function* () {
      yield new Label(chalk.cyan(" [Status] ") + "Active");
      yield new Label(chalk.yellow(" [Mode] ") + "Autonomous");
      yield new Label(chalk.green(" [System] ") + "Online");
    });

    yield new PiText(chalk.dim("─".repeat(40)));
    
    yield new Vertical(function* () {
        yield new PiText("Main Content Area");
        yield new PiText(chalk.blue("Building a better TUI experience..."));
    });

    yield new PiText("");
    yield new PiText(chalk.gray(" Press 'Q' to exit "));
  }
}

// 运行示例
if (process.argv[1] === import.meta.filename) {
    const app = new DemoApp();
    app.run();
}
