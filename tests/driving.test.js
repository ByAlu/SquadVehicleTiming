"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Driving = require("../driving.js");
const Terrain = require("../terrain.js");

const profile = {
  radiusMeters: 0.5,
  massKg: 5000,
  gears: [{ ratio: 5, limitRpm: 5000 }],
  torque: [{ rpm: 0, nm: 1000 }],
  idleRpm: 0,
  brakeTorqueNm: 10000,
  shiftSeconds: 0,
  speedLimitKmh: 60,
  frictionMultiplier: 2,
};

const slope = {
  brakingFactor: 0.8,
  boostFactor: 12,
  minSpeedKmh: 10,
  maxSpeedKmh: 33,
  minAngleDegrees: 15,
  maxAngleDegrees: 47,
};

function travelSeconds(grade, distance, settings) {
  const conditions = Terrain.drivingConditions([{ distance, grade, surface: null }], false);
  return Driving.travelTerrainSeconds(conditions, Driving.prepare({ ...profile, slope: settings }));
}

test("SDK slope boost reduces uphill travel time within its configured ranges", () => {
  const unassisted = travelSeconds(0.1, 10, { ...slope, boostFactor: 0 });
  assert.ok(travelSeconds(0.1, 10, slope) < unassisted);
  assert.equal(travelSeconds(0.1, 10, { ...slope, minSpeedKmh: 0, maxSpeedKmh: 0 }), unassisted);
  assert.equal(travelSeconds(0.1, 10, { ...slope, minAngleDegrees: 0, maxAngleDegrees: 0 }), unassisted);
});

test("SDK downhill braking slows a descent while retaining a finite ETA from rest", () => {
  const distance = 1000;
  const grade = -0.45;
  const withBraking = travelSeconds(grade, distance, slope);
  assert.ok(Number.isFinite(withBraking));
  assert.ok(withBraking > travelSeconds(grade, distance, { ...slope, brakingFactor: 0 }));
});

test("water cruising speed balances the SDK drag sample against thrust", () => {
  const settings = {
    thrustKgCmS2: 199069.21875,
    densityKgCm3: 0.000997,
    surfaceAreaCm2: 10000,
    forwardDragCoefficient: 1,
    fullDepthDragScale: 1,
    massKg: 10000,
  };
  assert.ok(Math.abs(Driving.waterCruiseSpeedKmh(settings) - 7.2) < 1e-5);
  assert.ok(Driving.waterCruiseSpeedKmh({ ...settings, fullDepthDragScale: 0.5 }) > 7.2);
  assert.equal(Driving.waterCruiseSpeedKmh({ ...settings, surfaceAreaCm2: 0 }), null);

  const aav = { ...settings, thrustKgCmS2: 945136.5, surfaceAreaCm2: 105600,
    forwardDragCoefficient: 0.450077, massKg: 29000 };
  assert.ok(Math.abs(Driving.waterCruiseSpeedKmh(aav) - 7.2) < 1e-5);
});

test("the driving model respects the wading speed cap on flat ground", () => {
  const model = Driving.prepare(profile);
  const piece = { distance: 200, grade: 0, surface: null };
  const dry = Terrain.drivingConditions([piece], false);
  const wet = Terrain.drivingConditions([{ ...piece, wadingDepthCm: null }], false);
  assert.ok(Driving.travelTerrainSeconds(wet, model) > piece.distance / (14 / 3.6));
  assert.ok(Driving.travelTerrainSeconds(wet, model) > Driving.travelTerrainSeconds(dry, model));
});

test("wading uses second gear up to tire height and first gear above it", () => {
  const wheeled = { ...profile, gears: [{ ratio: 15, limitRpm: 3000, shiftRpm: 2700 }, { ratio: 10, limitRpm: 3000 }] };
  const piece = { distance: 200, grade: 0, surface: null };
  assert.equal(Terrain.wadingGear(100, wheeled), 2);
  assert.equal(Terrain.wadingGear(101, wheeled), 1);
  assert.equal(Terrain.wadingGear(50, { ...wheeled, gears: wheeled.gears.slice(0, 1) }), 1);
  const ctm131 = { ...wheeled, name: "CTM131", radiusMeters: 0.57 };
  assert.equal(Terrain.wadingGear(114, ctm131), 2);
  assert.equal(Terrain.wadingGear(115, ctm131), 1);
  const [tireDeep, aboveTires] = Terrain.drivingConditions(
    [{ ...piece, wadingDepthCm: 100 }, { ...piece, wadingDepthCm: 101 }], false, wheeled);
  assert.ok(Math.abs(tireDeep.speedLimitKmh - 18 * Math.PI) < 1e-9);
  assert.ok(Math.abs(aboveTires.speedLimitKmh - 12 * Math.PI) < 1e-9);
  const model = Driving.prepare(wheeled);
  assert.ok(Driving.travelTerrainSeconds([aboveTires], model) > Driving.travelTerrainSeconds([tireDeep], model));
  assert.equal(Terrain.wadingSpeedLimitKmh(101, { ...wheeled, tracked: true }), 14);
  assert.equal(Terrain.wadingSpeedLimitKmh(null, wheeled), 14);
  assert.equal(Terrain.wadingSpeedLimitKmh(101, { ...wheeled, name: "CTM131" }), 14);
  assert.equal(Terrain.wadingSpeedLimitKmh(100, { ...wheeled, name: "CTM131" }), tireDeep.speedLimitKmh);
});
