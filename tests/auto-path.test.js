"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const AutoPath = require("../auto-path.js");
const Collision = require("../collision.js");
const Terrain = require("../terrain.js");

test("auto-routing finds a clear detour through the Logar Valley compound", () => {
  const directory = path.join(__dirname, "../maps/Logar Valley");
  const terrain = JSON.parse(fs.readFileSync(path.join(directory, "terrain.json"), "utf8"));
  const script = { document: { currentScript: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, "collision.js"), "utf8"), script);
  const collision = script.document.currentScript.collisionData;
  const width = terrain.grid.columns * terrain.grid.columnSpacingMeters;
  const height = terrain.grid.rows * terrain.grid.rowSpacingMeters;
  const start = { x: 0.49510064, y: 0.39804176 };
  const end = { x: 0.50340307, y: 0.47882778 };
  assert.equal(Collision.segment(start, end, collision), "blocked");
  assert.equal(Collision.segment(start, start, collision), "clear");
  assert.equal(Collision.segment(end, end, collision), "clear");
  for (const tracked of [false, true]) {
    const result = AutoPath.find(start, end, terrain, width, height, { tracked, speedKmh: 65, collision });
    assert.ok(result?.via.length);
    assert.equal(result.direct, false);
    assert.equal(Collision.path([start, ...result.via, end], collision), "clear");
  }
});

test("auto-routing avoids deep water and uses the clear crossing", () => {
  const grid = { columns: 5, rows: 5 };
  const cell = [0, 0, 0, 0];
  const terrain = { grid, rows: Array.from({ length: 5 }, () => Array(5).fill(cell)), surfaces: [{ type: "Dirt" }] };
  const collision = {
    grid,
    rows: Array(5).fill("....."),
    water: { grid, rows: ["..#..", ".....", "..#..", "..#..", "..#.."] },
  };
  const start = { x: 0.1, y: 0.5 };
  const end = { x: 0.9, y: 0.5 };
  const options = { tracked: false, speedKmh: 65, collision };
  const result = AutoPath.find(start, end, terrain, 20, 20, options);
  assert.equal(result?.direct, false);
  assert.ok(result.via.length);
  assert.equal(Collision.path([start, ...result.via, end], collision.water), "clear");
  assert.equal(AutoPath.find(start, { x: 0.5, y: 0.5 }, terrain, 20, 20, options), null);

  collision.water.rows[1] = "..#..";
  assert.equal(AutoPath.find(start, end, terrain, 20, 20, options), null);
});

test("auto-routing falls back to mapped water when depth data is unavailable", () => {
  const grid = { columns: 3, rows: 1 };
  const land = [0, 0, 0, 0];
  const water = [0, 0, 0, 1];
  const terrain = { grid, rows: [[land, water, land]], surfaces: [{ type: "Dirt" }, { type: "Water" }] };
  const collision = { grid, rows: ["..."], water: null };
  const start = { x: 0.1, y: 0.5 };
  const end = { x: 0.9, y: 0.5 };
  assert.equal(AutoPath.find(start, end, terrain, 12, 4, { tracked: false, speedKmh: 65, collision }), null);
  collision.water = { grid, rows: ["#.."] };
  const mapped = { x: 0.5, y: 0.5 };
  assert.equal(Collision.segment(mapped, mapped, Collision.waterGrid(terrain, collision)), "blocked");
});

test("amphibious routing crosses water without ground support and still avoids mapped blockers", () => {
  const grid = { columns: 5, rows: 3 };
  const cell = [0, 0, 0, 0];
  const terrain = { grid, rows: Array.from({ length: 3 }, () => Array(5).fill(cell)), surfaces: [{ type: "Dirt" }] };
  const collision = {
    grid,
    rows: [".???.", ".?#?.", ".???."],
    water: { grid, rows: [".###.", ".###.", ".###."] },
  };
  const start = { x: 0.1, y: 0.5 };
  const end = { x: 0.9, y: 0.5 };
  const options = { tracked: false, speedKmh: 60, collision };
  assert.equal(AutoPath.find(start, end, terrain, 50, 30, options), null);
  const result = AutoPath.find(start, end, terrain, 50, 30, { ...options, waterSpeedKmh: 10 });
  assert.equal(result?.direct, false);
  const path = [start, ...result.via, end];
  assert.equal(Collision.path(path, collision, collision.water), "clear");
  const water = Terrain.sampleRoute(path, 50, 30, terrain, null, collision.water);
  assert.ok(water.waterMeters > 0);
  assert.ok(Terrain.drivingConditions(water.pieces, false).some((piece) => piece.water && piece.grade === 0));

  const afloat = { x: 0.3, y: 0.5 };
  assert.equal(AutoPath.find(start, afloat, terrain, 50, 30, { ...options, waterSpeedKmh: 10 })?.direct, true);
});

test("amphibious auto-routing rejects a steep bank above unsampled water", () => {
  const grid = { columns: 2, rows: 1 };
  const terrain = { grid, rows: [[[0, 600, 0, 0], null]], surfaces: [{ type: "Dirt" }] };
  const collision = { grid, rows: [".?"], water: { grid, rows: [".#"] } };
  const options = { tracked: false, speedKmh: 60, waterSpeedKmh: 10, collision };
  assert.equal(AutoPath.find({ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, terrain, 8, 4, options), null);
});

test("Black Coast water data blocks cells the vehicle collision scan marked clear", async (t) => {
  const script = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../water-data.js"), "utf8"), script);
  const name = "Black Coast";
  const directory = path.join(__dirname, "../maps", name);
  global.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(element) {
        const context = { document: { currentScript: element } };
        vm.runInNewContext(fs.readFileSync(path.join(directory, "collision.js"), "utf8"), context);
        element.onload();
      },
    },
  };
  t.after(() => { delete global.document; });
  const collision = await Collision.load({ name }, script.window.squadWaterData[name]);
  const terrain = JSON.parse(fs.readFileSync(path.join(directory, "terrain.json"), "utf8"));
  const shore = { x: 0.555, y: 0.8 };
  const water = { x: 0.255, y: 0.8 };
  const mask = Collision.waterGrid(terrain, collision);
  const width = terrain.grid.columns * terrain.grid.columnSpacingMeters;
  const height = terrain.grid.rows * terrain.grid.rowSpacingMeters;
  assert.equal(Collision.segment(shore, shore, collision), "clear");
  assert.equal(Collision.segment(shore, shore, mask), "clear");
  assert.equal(Collision.segment(water, water, collision), "clear");
  assert.equal(Collision.segment(water, water, mask), "blocked");
  assert.equal(AutoPath.find(shore, water, terrain, width, height, { tracked: false, speedKmh: 65, collision }), null);
});
