/**
 * Single source of truth for the keyboard shortcut listings shown to users.
 *
 * Both KeyboardHelp (the `?` overlay) and the About page's "Keyboard Shortcuts"
 * panel render from this so they can't drift from each other — or from the real
 * handler in App.jsx (TAB_KEYS = "1".."6"; the window keydown switch handles
 * j/k, Enter, Escape, g, f, c, s, /, m, ?).
 *
 * Shape: [sectionTitle, [[key, description], ...]][]
 */
export const SHORTCUTS = [
  ["Navigation", [
    ["j / k", "Next / previous item"],
    ["Enter", "Open selected item"],
    ["Escape", "Close modal / deselect"],
    ["g", "Go to Gallery"],
    ["1–6", "Switch tabs"],
  ]],
  ["Actions", [
    ["f", "Toggle favorite (focused card)"],
    ["c", "Add to cart (focused card)"],
    ["s or /", "Focus search"],
    ["m", "Toggle sound"],
    ["?", "Toggle this help"],
  ]],
];

/** Flattened [key, desc] list for compact single-column renders (e.g. About). */
export const SHORTCUTS_FLAT = SHORTCUTS.flatMap(([, rows]) => rows);
