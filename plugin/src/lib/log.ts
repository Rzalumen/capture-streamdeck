export interface Logger {
  trace(...a: unknown[]): unknown;
  debug(...a: unknown[]): unknown;
  info(...a: unknown[]): unknown;
  warn(...a: unknown[]): unknown;
  error(...a: unknown[]): unknown;
}
export const nullLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
