// The first-visit tour must point at something the visitor can see.
//
// On a phone the header's tab row is hidden and the bottom bar is shown; both
// carry data-tour="gallery". The tour used to take the first match in the page,
// the hidden header tab, and drew its spotlight round a box of no size at the
// top of the screen. These tests give each element the box a browser would
// (jsdom lays nothing out) and ask which one the tour picks.

import { describe, it, expect, afterEach } from "vitest";
import { pickTourTarget, placeTourCard } from "./tourTarget";

const VW = 390;
const VH = 844;

function box(el, { top, left, width, height }) {
  el.getBoundingClientRect = () => ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
}

function add(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return wrap;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("which element a tour step points at", () => {
  it("skips the hidden header tab and takes the bottom bar's tab on a phone", () => {
    const page = add(`
      <header><button id="head" data-tour="gallery">Gallery</button></header>
      <section id="grid" data-tour="gallery"></section>
      <nav><button id="bar" data-tour="gallery">Gallery</button></nav>`);
    box(page.querySelector("#head"), { top: 0, left: 0, width: 0, height: 0 }); // display: none
    box(page.querySelector("#grid"), { top: 720, left: 16, width: 358, height: 3000 }); // runs off the screen
    box(page.querySelector("#bar"), { top: 786, left: 14, width: 64, height: 44 });

    expect(pickTourTarget("[data-tour='gallery']", { vw: VW, vh: VH })?.id).toBe("bar");
  });

  it("keeps the header tab on a desktop, where it is on screen", () => {
    const page = add(`
      <header><button id="head" data-tour="gallery">Gallery</button></header>
      <nav><button id="bar" data-tour="gallery">Gallery</button></nav>`);
    box(page.querySelector("#head"), { top: 66, left: 70, width: 64, height: 44 });
    box(page.querySelector("#bar"), { top: 0, left: 0, width: 0, height: 0 }); // the bar is hidden on a desktop

    expect(pickTourTarget("[data-tour='gallery']", { vw: 1440, vh: 900 })?.id).toBe("head");
  });

  it("takes a drawn element that is only partly on screen when nothing is wholly on screen", () => {
    const page = add(`<button id="a" data-tour="floor"></button><section id="b" data-tour="floor"></section>`);
    box(page.querySelector("#a"), { top: 0, left: 0, width: 0, height: 0 });
    box(page.querySelector("#b"), { top: 600, left: 0, width: 390, height: 900 });

    expect(pickTourTarget("[data-tour='floor']", { vw: VW, vh: VH })?.id).toBe("b");
  });

  it("returns nothing when every match is hidden, so the card is centred", () => {
    const page = add(`<button id="keys" data-tour="shortcuts"></button>`);
    box(page.querySelector("#keys"), { top: 0, left: 0, width: 0, height: 0 });

    expect(pickTourTarget("[data-tour='shortcuts']", { vw: VW, vh: VH })).toBeNull();
  });

  it("tries the selectors in the order the step gives them", () => {
    const page = add(`<div id="later" class="later"></div><div id="first" class="first"></div>`);
    box(page.querySelector("#later"), { top: 10, left: 10, width: 50, height: 50 });
    box(page.querySelector("#first"), { top: 100, left: 10, width: 50, height: 50 });

    expect(pickTourTarget(".first, .later", { vw: VW, vh: VH })?.id).toBe("first");
  });
});

describe("where the card sits", () => {
  const rect = (top, left, width, height) => ({ top, left, width, height, right: left + width, bottom: top + height });

  it("goes above a target at the foot of the screen, with its arrow over the target", () => {
    const bar = rect(786, 14, 64, 44);
    const { pos, side, arrowLeft } = placeTourCard(bar, "bottom", { vw: VW, vh: VH });

    expect(side).toBe("top");
    expect(pos.top).toBeUndefined();
    expect(VH - pos.bottom).toBeLessThanOrEqual(bar.top); // the card ends above the target
    expect(pos.left + arrowLeft).toBeCloseTo(bar.left + bar.width / 2, 0);
  });

  it("stays below a target at the top of the screen", () => {
    const connect = rect(10, 300, 80, 36);
    const { pos, side } = placeTourCard(connect, "bottom-end", { vw: VW, vh: VH });

    expect(side).toBe("bottom");
    expect(pos.top).toBeGreaterThanOrEqual(connect.bottom);
  });

  it("never lets the card run off either side of a narrow screen", () => {
    const { pos } = placeTourCard(rect(10, 340, 40, 36), "bottom", { vw: 360, vh: 740 });
    expect(pos.left).toBeGreaterThanOrEqual(16);
    expect(pos.left + 320).toBeLessThanOrEqual(360 - 16 + 0.5);
  });
});
