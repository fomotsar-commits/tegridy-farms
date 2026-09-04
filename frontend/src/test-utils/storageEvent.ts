/**
 * Dispatch a cross-tab `storage` event, from one place.
 *
 * WHY THIS EXISTS AT ALL. Three test files built this event inline, and CodeQL
 * flags every one of them as `js/superfluous-trailing-arguments` — "Superfluous
 * arguments passed to function StorageEvent". That finding is WRONG about the
 * DOM: the constructor really is `StorageEvent(type, eventInitDict?)`, and the
 * second argument is how `key` and `newValue` are set at all — they are readonly
 * on the instance, so there is no other way to build a usable one. CodeQL is
 * modelling the constructor as unary.
 *
 * The honest response to a confirmed false positive is to say so once, in a
 * place a reader can check, rather than to contort three correct call sites into
 * something the scanner happens to like. So the construction now happens here,
 * once, with the reasoning attached — and the three callers get shorter.
 *
 * If CodeQL's model is ever corrected, delete the suppression below and nothing
 * else changes.
 */
export function dispatchStorageEvent(key: string, newValue: string | null): void {
  // codeql[js/superfluous-trailing-arguments] — see the note above: the DOM
  // StorageEvent constructor takes (type, eventInitDict) and the init dict is
  // the only way to set key/newValue, which are readonly on the instance.
  const event = new StorageEvent('storage', { key, newValue });
  window.dispatchEvent(event);
}
