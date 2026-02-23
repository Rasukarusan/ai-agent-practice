type LogLevel = "debug" | "info" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  error: 2,
};

export function setupLogger(name: string, level: LogLevel = "info") {
  const threshold = LOG_LEVELS[level];

  function log(msgLevel: LogLevel, message: string) {
    if (LOG_LEVELS[msgLevel] < threshold) return;
    const timestamp = new Date().toISOString();
    const tag = msgLevel.toUpperCase();
    console.log(`${timestamp} ${tag} [${name}] ${message}`);
  }

  return {
    debug: (msg: string) => log("debug", msg),
    info: (msg: string) => log("info", msg),
    error: (msg: string) => log("error", msg),
  };
}
