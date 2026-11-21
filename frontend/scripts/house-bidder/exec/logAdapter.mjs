// The CLI prints plain lines; the data layer (data/util.mjs makeLog) logs by level. This adapter
// joins the two so a data-layer message keeps its text: joined directly, a function logger is
// called as log(level, message, details) and the CLI printed only the level ("warn"), losing why.

const json = (details) => {
  if (details === undefined || details === null || details === '') return '';
  try {
    return ` ${JSON.stringify(details, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
  } catch {
    return '';
  }
};

/**
 * @param {(line: string) => void} lineLog  the CLI's one-line logger
 * @param {{ verbose?: boolean }} [opts]    debug lines (one per OpenSea call) only when verbose
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
export function levelLogger(lineLog, { verbose = false } = {}) {
  const line = (prefix) => (message, details) => lineLog(`${prefix}${message}${json(details)}`);
  return {
    debug: verbose ? line('debug: ') : () => {},
    info: line(''),
    warn: line('warn: '),
    error: line('error: '),
  };
}
