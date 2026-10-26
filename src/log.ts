/**
 * Logging conventions:
 *  - HTTP access lines and general progress go to stdout.
 *  - Warnings, errors and denial notices (with recommendations) go to stderr.
 */

const useColor = (stream: NodeJS.WriteStream) =>
  Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (stream: NodeJS.WriteStream, code: number, text: string) =>
  useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;

export interface Logger {
  http(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  deny(lines: string[]): void;
}

export const consoleLogger: Logger = {
  http(line) {
    process.stdout.write(`${paint(process.stdout, 2, timestamp())} ${line}\n`);
  },
  info(line) {
    process.stdout.write(`${paint(process.stdout, 2, timestamp())} ${paint(process.stdout, 36, "info")} ${line}\n`);
  },
  warn(line) {
    process.stderr.write(`${paint(process.stderr, 2, timestamp())} ${paint(process.stderr, 33, "warn")} ${line}\n`);
  },
  error(line) {
    process.stderr.write(`${paint(process.stderr, 2, timestamp())} ${paint(process.stderr, 31, "error")} ${line}\n`);
  },
  deny(lines) {
    const [first = "", ...rest] = lines;
    process.stderr.write(`${paint(process.stderr, 2, timestamp())} ${paint(process.stderr, 31, "DENY")} ${first}\n`);
    for (const line of rest) process.stderr.write(`${" ".repeat(timestamp().length + 1)}     ${line}\n`);
  },
};

export const silentLogger: Logger = {
  http() {},
  info() {},
  warn() {},
  error() {},
  deny() {},
};

/** Colors a status code for the access log: green 2xx, cyan 3xx, yellow 4xx, red 5xx. */
export function paintStatus(status: number): string {
  const code = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  return paint(process.stdout, code, String(status));
}

export function paintTag(tag: string): string {
  const code = tag === "HIT" ? 32 : tag === "DENY" ? 31 : tag === "MISS" ? 33 : 2;
  return paint(process.stdout, code, tag.padEnd(5));
}

function timestamp(): string {
  return new Date().toISOString();
}
