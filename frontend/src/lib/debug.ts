/**
 * Opt-in debug logging. The graph and project code used to `console.log` constantly (one line per edge on every
 * load -- tens of thousands at scale -- which slows the page and buries real errors). Enable with
 * `localStorage.setItem('designer:debug', '1')` and reload; errors and warnings are never gated.
 */
let enabled = false;
try {
  enabled = typeof localStorage !== 'undefined' && localStorage.getItem('designer:debug') === '1';
} catch {
  enabled = false;
}

export function dbg(...args: unknown[]): void {
  if (enabled) console.log(...args);
}
