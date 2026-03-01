import * as readline from "node:readline";

export function setupEscListener(onEsc: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const handler = (key: Buffer) => {
    if (key[0] === 0x1b && key.length === 1) {
      onEsc();
    }
    if (key[0] === 0x03) {
      process.exit();
    }
  };

  process.stdin.on("data", handler);

  return () => {
    process.stdin.removeListener("data", handler);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

export function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
