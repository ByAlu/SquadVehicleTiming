"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { gzipSync } = require("node:zlib");
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
  const end = { x: 0.50283553, y: 0.47882778 };
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
});

test("measured water depth allows a ground route through a shallow Water surface", () => {
  const grid = { columns: 4, rows: 1 };
  const land = [0, 0, 0, 0];
  const water = [0, 0, 0, 1];
  const terrain = { grid, rows: [[land, water, land, water]], surfaces: [{ type: "Dirt" }, { type: "Water" }] };
  const collision = { grid, rows: ["...."], water: { grid, rows: ["...#"] } };
  const start = { x: 0.125, y: 0.5 };
  const shore = { x: 0.625, y: 0.5 };
  const deep = { x: 0.875, y: 0.5 };
  const options = { tracked: false, speedKmh: 65, collision };

  const mask = Collision.waterGrid(terrain, collision);
  assert.equal(Collision.path([start, shore], mask), "clear");
  assert.equal(Collision.path([start, deep], mask), "blocked");
  assert.equal(AutoPath.find(start, shore, terrain, 16, 4, options)?.direct, true);
  assert.equal(AutoPath.find(start, deep, terrain, 16, 4, options), null);
  assert.equal(AutoPath.find(start, deep, terrain, 16, 4, { ...options, waterSpeedKmh: 10 })?.direct, true);

  const timedWater = Collision.waterGrid(terrain, collision, true);
  const shallow = Terrain.sampleRoute([start, shore], 16, 4, terrain, null, timedWater);
  assert.equal(shallow.waterMeters, 0);
  assert.ok(shallow.pieces.some((piece) => piece.surface?.type === "Water" && !piece.water));
});

test("a depth scan with no deep water takes precedence over terrain Water", async (t) => {
  const grid = { columns: 1, rows: 1 };
  const terrain = { grid, rows: [[[0, 0, 0, 0]]], surfaces: [{ type: "Water" }] };
  global.document = {
    createElement: () => ({ remove() {} }),
    head: {
      append(element) {
        element.collisionData = { map: "Test", schemaVersion: 1, grid, rows: ["."] };
        element.onload();
      },
    },
  };
  t.after(() => { delete global.document; });
  const depths = gzipSync(Uint8Array.of(120)).toString("base64");
  const collision = await Collision.load({ name: "Test" }, [1, 1], [1, 1, depths]);

  assert.deepEqual(Collision.waterGrid(terrain, collision).rows, ["."]);
  assert.equal(Terrain.wadingDepthAt(0.5, 0.5, collision.wadingWater), 120);
  assert.equal(AutoPath.find({ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, terrain, 4, 4, {
    tracked: false, speedKmh: 65, collision,
  })?.direct, true);
});

test("auto-routing can detour around a slow but passable ford", () => {
  const grid = { columns: 5, rows: 3 };
  const land = [0, 0, 0, 0];
  const terrain = { grid, rows: Array.from({ length: 3 }, () => Array(5).fill(land)), surfaces: [{ type: "Asphalt" }] };
  const collision = { grid, rows: [".....", ".....", "....."], wadingWater: { grid, rows: [".....", ".###.", "....."] } };
  const start = { x: 0.1, y: 0.5 };
  const end = { x: 0.9, y: 0.5 };
  const options = { tracked: false, speedKmh: 65, collision };
  const result = AutoPath.find(start, end, terrain, 50, 30, options);

  assert.equal(result?.direct, true);
  assert.ok(result.via.some(({ y }) => y !== start.y));
  const crossing = Terrain.sampleRoute([start, end], 50, 30, terrain, null, null, collision.wadingWater);
  const conditions = Terrain.drivingConditions(crossing.pieces, false);
  assert.ok(conditions.some((piece) => piece.speedLimitKmh === 14));
  assert.ok(conditions.some((piece) => piece.speedLimitKmh === Infinity));
});

test("auto-routing considers the gear allowed by the sampled wading depth", () => {
  const grid = { columns: 5, rows: 3 };
  const land = [0, 0, 0, 0];
  const terrain = { grid, rows: Array.from({ length: 3 }, () => Array(5).fill(land)), surfaces: [{ type: "Asphalt" }] };
  const depths = new Uint8Array(15);
  const collision = { grid, rows: [".....", ".....", "....."], wadingWater: { grid, depths } };
  const profile = { radiusMeters: 0.5, speedLimitKmh: 60, gears: [{ ratio: 40, limitRpm: 3000 }, { ratio: 10, limitRpm: 3000 }] };
  const start = { x: 0.1, y: 0.5 };
  const end = { x: 0.9, y: 0.5 };
  const options = { tracked: false, speedKmh: 60, collision, profile };

  depths.fill(100, 6, 9);
  assert.deepEqual(AutoPath.find(start, end, terrain, 50, 30, options), { direct: true, via: [] });
  depths.fill(101, 6, 9);
  const result = AutoPath.find(start, end, terrain, 50, 30, options);
  assert.equal(result?.direct, true);
  assert.ok(result.via.some(({ y }) => y !== start.y));
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

function loadMapCollision(t, name) {
  const script = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../water-data.js"), "utf8"), script);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../wading-water-data.js"), "utf8"), script);
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
  return Collision.load({ name }, script.window.squadWaterData[name], script.window.squadWadingWaterData[name]);
}

test("Yehorivka marks the verified barns, house, and walls as obstacles", async (t) => {
  const collision = await loadMapCollision(t, "Yehorivka");
  const center = (column, row) => ({ x: (column + 0.5) / 6351, y: (row + 0.5) / 6350 });
  for (const [column, row] of [[3244, 3788], [3706, 3920], [3189, 3784], [3385, 3892], [3360, 3935]]) {
    const point = center(column, row);
    assert.equal(Collision.overlayLabelAt(point.x, point.y, collision), "Solid obstacle", `${column}, ${row}`);
    assert.equal(Collision.segment(point, point, collision), "blocked", `${column}, ${row}`);
  }
  const openCell = center(3309, 3912);
  assert.equal(Collision.segment(openCell, openCell, collision), "clear");
});

test("Black Coast ignores both staging barriers and detects overlapping physical obstacles", async (t) => {
  const collision = await loadMapCollision(t, "Black Coast");
  for (const [column, row, blocked] of [
    [3326, 702, false], [3339, 702, true],
    [2590, 2950, false], [2592, 2949, true], [2603, 2948, true],
  ]) {
    const point = { x: (column + 0.5) / 4600, y: (row + 0.5) / 4600 };
    assert.equal(Collision.overlayLabelAt(point.x, point.y, collision), blocked ? "Solid obstacle" : "Clear ground", `${column}, ${row}`);
    assert.equal(Collision.segment(point, point, collision), blocked ? "blocked" : "clear", `${column}, ${row}`);
  }
});

test("the Al Basrah ford limits the CTM131 to first gear over a non-Water terrain sample", async (t) => {
  const name = "Al Basrah";
  const terrain = require("../maps/Al Basrah/terrain.json");
  const collision = await loadMapCollision(t, name);
  const { columns, rows, columnSpacingMeters, rowSpacingMeters } = collision.grid;
  const start = { x: 0.55925, y: 0.7325 };
  const end = { x: 0.55975, y: start.y };
  const water = Collision.waterGrid(terrain, collision);

  assert.equal(Collision.segment(start, end, collision), "clear");
  assert.equal(Collision.segment(start, end, water), "clear");
  const crossing = Terrain.sampleRoute([start, end], columns * columnSpacingMeters, rows * rowSpacingMeters,
    terrain, null, water, collision.wadingWater);
  const catalog = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../vehicles/catalog.js"), "utf8"), catalog);
  const truck = catalog.window.squadVehicles.find(({ name, faction }) => name === "CTM131 Transport QJY88" && faction === "PLA");
  const profile = truck.drivingProfiles[0];
  const [sample] = crossing.pieces;
  assert.ok(sample.surface);
  assert.notEqual(sample.surface.type, "Water");
  assert.equal(Terrain.wadingGear(sample.wadingDepthCm, profile), 1);
  assert.equal(Terrain.drivingConditions(crossing.pieces, false, profile)[0].speedLimitKmh, 14);
});

test("Black Coast water data blocks cells the vehicle collision scan marked clear", async (t) => {
  const name = "Black Coast";
  const directory = path.join(__dirname, "../maps", name);
  const collision = await loadMapCollision(t, name);
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

test("Harju samples the dry tracks and bridge deck above the ocean collider", async (t) => {
  const collision = await loadMapCollision(t, "Harju");
  const { columns, rows } = collision.grid;
  for (const [column, row] of [[2338, 1610], [2342, 1614], [2318, 1578], [2438, 1598],
    [2466, 1582], [2490, 1570], [2582, 1526]]) {
    const point = { x: (column + 0.5) / columns, y: (row + 0.5) / rows };
    assert.notEqual(Collision.segment(point, point, collision), "unknown", `${column}, ${row}`);
    assert.equal(Collision.segment(point, point, collision.water), "clear", `${column}, ${row}`);
    assert.equal(collision.wadingWater.depths[row * columns + column], 0, `${column}, ${row}`);
  }
  const river = { x: 2482.5 / columns, y: 1622.5 / rows };
  assert.equal(Collision.overlayLabelAt(river.x, river.y, collision), "Deep water");
  assert.equal(Collision.segment(river, river, collision.water), "blocked");
});

test("Harju routes across the 1 m bridge deck while retaining handrail collisions", async (t) => {
  const collision = await loadMapCollision(t, "Harju");
  const terrain = require("../maps/Harju/terrain.json");
  const { columns, rows, columnSpacingMeters, rowSpacingMeters } = collision.grid;
  assert.equal(columnSpacingMeters, 1);
  assert.equal(rowSpacingMeters, 1);
  const center = (column, row) => ({ x: (column + 0.5) / columns, y: (row + 0.5) / rows });
  const deck = center(2466, 1582);
  const rail = center(2466, 1578);
  assert.equal(Collision.overlayLabelAt(deck.x, deck.y, collision), "Clear ground");
  assert.equal(Collision.overlayLabelAt(rail.x, rail.y, collision), "Solid obstacle");
  assert.equal(Collision.segment(deck, rail, collision), "blocked");

  const start = center(2390, 1600);
  const end = center(2546, 1550);
  const route = AutoPath.find(start, end, terrain, columns * columnSpacingMeters, rows * rowSpacingMeters,
    { tracked: false, speedKmh: 60, collision });
  assert.ok(route?.via.length);
  assert.equal(Collision.path([start, ...route.via, end], collision), "clear");
  assert.equal(Collision.path([start, ...route.via, end], collision.water), "clear");
  assert.ok(route.via.some(({ x, y }) => Math.hypot((x - deck.x) * columns, (y - deck.y) * rows) < 4));

  const straight = [center(2430, 1597), center(2500, 1568)];
  assert.equal(Collision.path(straight, collision), "clear");
  assert.equal(Collision.path(straight, collision.water), "clear");
});

test("Gorodok allows a ford below the 150 cm water threshold", async (t) => {
  const name = "Gorodok";
  const terrain = require("../maps/Gorodok/terrain.json");
  const collision = await loadMapCollision(t, name);
  const { columns, rows, columnSpacingMeters, rowSpacingMeters } = collision.grid;
  const start = { x: 946.5 / 1016, y: 137.5 / 1016 };
  const end = { x: 948.5 / 1016, y: start.y };

  assert.equal(Collision.segment(start, end, Collision.waterGrid(terrain, collision)), "clear");
  assert.equal(AutoPath.find(start, end, terrain, columns * columnSpacingMeters, rows * rowSpacingMeters, {
    tracked: false, speedKmh: 65, collision,
  })?.direct, true);
});

test("Tallil Outskirts permits ground routing through a shallow crossing", async (t) => {
  const name = "Tallil Outskirts";
  const terrain = require("../maps/Tallil Outskirts/terrain.json");
  const collision = await loadMapCollision(t, name);
  const { columns, rows, columnSpacingMeters, rowSpacingMeters } = collision.grid;
  const start = { x: 497.5 / 1171, y: 106.5 / 1170 };
  const end = { x: 505.5 / 1171, y: start.y };
  const mask = Collision.waterGrid(terrain, collision);

  assert.ok(mask.rows.every((row) => !row.includes("#")));
  assert.equal(Collision.segment(start, end, collision), "clear");
  assert.equal(Collision.segment(start, end, mask), "clear");
  assert.equal(AutoPath.find(start, end, terrain, columns * columnSpacingMeters, rows * rowSpacingMeters, {
    tracked: false, speedKmh: 65, collision,
  })?.direct, true);
});
