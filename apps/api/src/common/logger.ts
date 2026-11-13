import { config } from '../config.js';
const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const min = levels[(config.logLevel as Level) ?? 'info'] ?? 20;
/** Structured JSON logs. Never pass tokens or precise passenger coordinates in fields. */
function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (levels[level] < min || process.env.VITEST) return;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};
