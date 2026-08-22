import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./ThemeContext";

// F531 regression. This provider themes nodes it does not own — the document
// element, body, and the meta theme-color the MAIN app also writes. Leaving the
// sub-app used to leave that state behind, so the last theme picked inside
// Tradermigos silently became the whole site's theme and the main app's own
// light/dark selection stopped matching any stylesheet rule. The main provider
// only re-applies on ITS theme change, so nothing ever corrected it.

function Switcher() {
  const { setTheme } = useTheme();
  return <button onClick={() => setTheme("midnight")}>midnight</button>;
}

function mainAppState() {
  return {
    root: document.documentElement.getAttribute("data-theme"),
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
    bodyClass: document.body.className,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
  document.body.className = "";
  document.body.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme");
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#f5f3ff");
  document.head.appendChild(meta);
  // What the main app owns before Tradermigos mounts.
  document.documentElement.setAttribute("data-theme", "light");
  document.body.classList.add("app-shell");
});

describe("nakamigos ThemeProvider hands the global theme back on unmount", () => {
  it("takes over documentElement + meta theme-color while mounted", () => {
    const { unmount } = render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("default");
    expect(document.querySelector('meta[name="theme-color"]').getAttribute("content")).toBe("#09090b");
    unmount();
  });

  it("restores the exact prior values after a theme change and unmount", () => {
    const before = mainAppState();
    const { getByText, unmount } = render(
      <ThemeProvider><Switcher /></ThemeProvider>
    );
    fireEvent.click(getByText("midnight"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");

    unmount();

    expect(mainAppState()).toEqual(before);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("removes data-theme entirely when the main app had not set one", () => {
    document.documentElement.removeAttribute("data-theme");
    const { unmount } = render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(true);
    unmount();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("leaves non-theme body classes owned by other code untouched", () => {
    const { unmount } = render(<ThemeProvider><div /></ThemeProvider>);
    document.body.classList.add("modal-open");
    unmount();
    expect(document.body.classList.contains("app-shell")).toBe(true);
    expect(document.body.classList.contains("modal-open")).toBe(true);
    expect(document.body.classList.contains("theme-default")).toBe(false);
  });

  it("restores body custom properties when .nakamigos-app is absent (the fallback target)", () => {
    // applyTheme falls back to document.body when the sub-app wrapper is not
    // mounted — body outlives the sub-app, so those vars leak too.
    render(<ThemeProvider><div /></ThemeProvider>).unmount();
    expect(document.body.style.getPropertyValue("--bg")).toBe("");
    expect(document.body.style.getPropertyValue("--card")).toBe("");
  });
});
