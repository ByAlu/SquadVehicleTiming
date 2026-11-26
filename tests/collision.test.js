"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Collision = require("../collision.js");

test("collision overlay and cursor distinguish clear, blocked, deep water, and unsampled cells", () => {
  const grid = { columns: 3, rows: 2 };
  const collision = { grid, rows: [".#?", "?.#"], water: { grid, rows: [".#.", "##."] } };
  let pixels;
  const canvas = {
    getContext: () => ({
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: ({ data }) => { pixels = data; },
    }),
  };

  assert.deepEqual(Collision.drawOverlay(canvas, collision), [
    ["Solid obstacle", "#fb6468"], ["Deep water", "#4d9de8"],
    ["No ground sample", "#9795aa"], ["Clear ground", "transparent"],
  ]);
  assert.equal(canvas.width, 3);
  assert.equal(canvas.height, 2);
  assert.deepEqual([...pixels], [
    0, 0, 0, 0, 251, 100, 104, 255, 151, 149, 170, 255,
    77, 157, 232, 255, 77, 157, 232, 255, 251, 100, 104, 255,
  ]);
  assert.equal(Collision.overlayLabelAt(0, 0, collision), "Clear ground");
  assert.equal(Collision.overlayLabelAt(0.5, 0, collision), "Solid obstacle");
  assert.equal(Collision.overlayLabelAt(1, 0, collision), "No ground sample");
  assert.equal(Collision.overlayLabelAt(0, 1, collision), "Deep water");
  assert.equal(Collision.overlayLabelAt(1, 1, collision), "Solid obstacle");
  assert.equal(Collision.overlayLabelAt(-0.1, 0, collision), null);
});
