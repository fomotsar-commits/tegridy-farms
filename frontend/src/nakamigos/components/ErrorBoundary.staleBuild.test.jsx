import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

// The marketplace signs through its own wallet code (ethers, about fifty call sites),
// which the site's records of an open transaction do not see. So here the page never
// reloads itself after a deploy: this boundary offers the reload as a button.

const realLocation = window.location;
let reload;

function StaleChunk() {
  throw new TypeError("Failed to fetch dynamically imported module: https://memetics.finance/assets/Analytics-old.js");
}

beforeEach(() => {
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...realLocation, reload } });
  window.sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: realLocation });
  vi.restoreAllMocks();
});

describe("the marketplace boundary and a chunk that failed to load", () => {
  it("does not reload the page by itself", () => {
    render(
      <ErrorBoundary title="Tab error">
        <StaleChunk />
      </ErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("says a new version is there and reloads on the visitor's press", () => {
    render(
      <ErrorBoundary title="Tab error">
        <StaleChunk />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("A new version of the app is available.");
    fireEvent.click(screen.getByRole("button", { name: "Reload Page" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the marketplace holds the page for as long as it is mounted", () => {
    const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
    const shell = app.slice(app.indexOf("export default function App()"));
    expect(shell).toMatch(/^export default function App\(\) \{\n(\s*\/\/.*\n)*\s*useEffect\(\(\) => holdReload\(\), \[\]\);/);
    expect(app).toMatch(/import \{ holdReload \} from "\.\.\/lib\/reloadHold";/);
  });
});
