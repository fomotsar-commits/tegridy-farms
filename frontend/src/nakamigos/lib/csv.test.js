import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exportCSV } from "./csv";

/**
 * exportCSV writes a Blob and triggers a download. We capture the CSV text by
 * stubbing Blob (text() is async in jsdom, so we record parts synchronously)
 * plus URL.createObjectURL and the anchor click.
 */
describe("exportCSV", () => {
  let blobSpy;

  beforeEach(() => {
    // Capture the Blob parts synchronously since blob.text() is async in jsdom.
    blobSpy = [];
    vi.stubGlobal("Blob", class MockBlob {
      constructor(parts) { this._text = parts.join(""); blobSpy.push(this._text); }
      get text() { return async () => this._text; }
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing for an empty rows array", () => {
    exportCSV([], "empty");
    expect(blobSpy.length).toBe(0);
  });

  it("unions keys across heterogeneous rows so no column is dropped", () => {
    exportCSV([{ a: 1 }, { b: 2 }], "hetero");
    const csv = blobSpy[0];
    const lines = csv.replace(/^﻿/, "").split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe("1,"); // row 1 has no b
    expect(lines[2]).toBe(",2"); // row 2 has no a
  });

  it("quotes values containing a bare carriage return", () => {
    exportCSV([{ note: "line1\rline2" }], "cr");
    const csv = blobSpy[0];
    expect(csv).toContain('"line1\rline2"');
  });

  it("still guards against formula injection", () => {
    exportCSV([{ cell: "=SUM(A1:A2)" }], "inj");
    const csv = blobSpy[0];
    expect(csv).toContain("'=SUM(A1:A2)");
  });
});
