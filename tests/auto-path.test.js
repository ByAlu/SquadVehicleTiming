"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const AutoPath = require("../auto-path.js");
const Collision = require("../collision.js");

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
