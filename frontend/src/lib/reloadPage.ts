/** A full page reload, behind a name a test can replace: jsdom's own `location.reload` cannot be spied on. */
export function reloadPage(): void {
  window.location.reload();
}
