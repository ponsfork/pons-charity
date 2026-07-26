/**
 * Minimal structured logger (no dependencies). Mirrors the tracing output style
 * of the Rust services: "<ISO time> <LEVEL> [scope] message".
 */

type Level = "info" | "warn" | "error" | "debug";

const COLOR: Record<Level, string> = {
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  debug: "\x1b[90m",
};
const RESET = "\x1b[0m";
const useColor = process.stdout.isTTY;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLOR[level]}${tag}${RESET}` : tag;
  const line = `${ts} ${head} [${scope}] ${msg}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) sink(line, extra);
  else sink(line);
}

export function makeLogger(scope: string) {
  return {
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
    debug: (msg: string, extra?: unknown) => {
      if (process.env.DEBUG) emit("debug", scope, msg, extra);
    },
  };
}

export type Logger = ReturnType<typeof makeLogger>;
