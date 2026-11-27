"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { gzipSync } = require("node:zlib");
const Terrain = require("../terrain.js");
const Collision = require("../collision.js");

test("packed terrain bundles preserve surfaces, steep grades, and missing samples", async (t) => {
  const cells = Buffer.alloc(36);
  cells.writeInt16LE(150, 0);
  cells.writeInt32LE(45000, 2);
  cells.writeInt32LE(-2147483648, 6);
  cells.writeInt16LE(-32768, 12);
  cells.writeInt16LE(-60, 24);
  cells.writeUInt16LE(1, 34);
  const data = { map: "Packed test", schemaVersion: 2, grid: { columns: 3, rows: 1 },
    surfaces: [{ type: "Dirt" }, { type: "Water" }], cellsGzipBase64: gzipSync(cells).toString("base64") };
  global.document = {
    createElement: () => ({ remove() {} }),
    head: { append(script) { script.terrainData = { ...data }; script.onload(); } },
  };
  t.after(() => { delete global.document; });

  const terrain = await Terrain.load({ name: data.map });
  assert.deepEqual(Terrain.cellAt(terrain, 0, 0), [150, 45000, null, 0]);
  assert.equal(Terrain.cellAt(terrain, 1, 0), null);
  assert.equal(Terrain.cellAt(terrain, 3, 0), null);
  assert.equal(Terrain.surfaceAt(0.9, 0.5, terrain).type, "Water");
  assert.deepEqual(Collision.waterGrid(terrain, null).rows, ["..#"]);
  assert.deepEqual(Terrain.cellAt(data, 2, 0), [-60, 0, 0, 1]);
});

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
