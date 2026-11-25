"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Terrain = require("../terrain.js");

test("terrain overlay and cursor use deep water at the mask resolution", () => {
  const sand = { type: "Sand" };
  const terrain = {
    grid: { columns: 2, rows: 1 },
    rows: [[[0, 0, 0, 0], null]],
    surfaces: [sand],
  };
  const water = { grid: { columns: 4, rows: 1 }, rows: [".##."] };
  let pixels;
  const canvas = {
    getContext: () => ({
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: ({ data }) => { pixels = data; },
    }),
  };

  assert.deepEqual(Terrain.drawSurfaceOverlay(canvas, terrain), [["Sand", "#f0d283"]]);
  assert.equal(canvas.width, 2);
  assert.deepEqual(Terrain.drawSurfaceOverlay(canvas, terrain, water), [
    ["Sand", "#f0d283"], ["Water", "#4194e3"],
  ]);
  assert.equal(canvas.width, 4);
  assert.equal(canvas.height, 1);
  assert.deepEqual([...pixels], [
    240, 210, 131, 255, // Dry sand
    65, 148, 227, 255, // Water above sand
    65, 148, 227, 255, // Water with no terrain sample
    0, 0, 0, 0, // No terrain sample
  ]);
  assert.equal(Terrain.surfaceAt(0.125, 0.5, terrain, water), sand);
  assert.equal(Terrain.surfaceAt(0.375, 0.5, terrain, water).type, "Water");
  assert.equal(Terrain.surfaceAt(0.625, 0.5, terrain, water).type, "Water");
  assert.equal(Terrain.surfaceAt(1, 1, terrain, water), null);
});
