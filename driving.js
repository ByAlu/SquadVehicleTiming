"use strict";

const Driving = (() => {
  const drivetrainEfficiency = 0.85;
  const gripAcceleration = 0.55 * 9.81;
  const speedStep = 0.15;

  function engineTorque(keys, rpm) {
    if (rpm <= keys[0].rpm) return keys[0].nm;
    const next = keys.findIndex((key) => key.rpm > rpm);
    if (next < 0) return keys.at(-1).nm;

    const before = keys[next - 1];
    const after = keys[next];
    const range = after.rpm - before.rpm;
    const t = (rpm - before.rpm) / range;
    if (before.mode === "constant") return before.nm;
    if (before.mode !== "cubic") return before.nm + (after.nm - before.nm) * t;

    // Cubic Hermite interpolation using Unreal's leave and arrive tangents.
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * before.nm
      + (t3 - 2 * t2 + t) * before.leave * range
      + (-2 * t3 + 3 * t2) * after.nm
      + (t3 - t2) * after.arrive * range;
  }

  function prepare(profile) {
    const { radiusMeters, massKg, gears, torque, idleRpm, brakeTorqueNm, shiftSeconds } = profile;
    const braking = Math.min(gripAcceleration, brakeTorqueNm / (radiusMeters * massKg));
    const metersPerRotation = 2 * Math.PI * radiusMeters;
    const maxSpeed = profile.speedLimitKmh / 3.6;
    const samples = [{ speed: 0, distance: 0, time: 0 }];
    const shifts = [];
    let speed = 0;
    let distance = 0;
    let time = 0;

    for (const [index, gear] of gears.entries()) {
      const rpmPerMeterPerSecond = 60 * gear.ratio / metersPerRotation;
      const targetRpm = index === gears.length - 1 ? gear.limitRpm : gear.shiftRpm;
      const targetSpeed = Math.min(maxSpeed, targetRpm / rpmPerMeterPerSecond);
      if (index > 0 && speed > 0 && shiftSeconds > 0) {
        shifts.push({ speed, time: shiftSeconds });
        time += shiftSeconds;
        distance += speed * shiftSeconds;
        samples.push({ speed, distance, time, acceleration: samples.at(-1).acceleration });
      }

      while (speed < targetSpeed) {
        const nextSpeed = Math.min(targetSpeed, speed + speedStep);
        const midpoint = (speed + nextSpeed) / 2;
        const rpm = Math.max(idleRpm, midpoint * rpmPerMeterPerSecond);
        const force = engineTorque(torque, rpm) * gear.ratio * drivetrainEfficiency / radiusMeters;
        const acceleration = Math.min(gripAcceleration, force / massKg);
        if (!(acceleration > 0)) break;

        const duration = (nextSpeed - speed) / acceleration;
        time += duration;
        distance += midpoint * duration;
        speed = nextSpeed;
        samples.push({ speed, distance, time, acceleration });
      }
      if (speed === maxSpeed) break;
    }

    return speed > 0 && braking > 0 && Number.isFinite(time) ? { samples, braking, shifts } : null;
  }

  function accelerationAt(samples, speed) {
    let low = 0;
    let high = samples.length - 1;
    // Use the sample before a gear shift when the route ends its acceleration
    // at the shift speed. Additional speed requires completing the shift.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].speed < speed) low = middle + 1;
      else high = middle;
    }
    const next = samples[low];
    if (next.speed === speed || low === 0) return next;
    const previous = samples[low - 1];
    const elapsed = (next.time - previous.time) * (speed - previous.speed) / (next.speed - previous.speed);
    return {
      distance: previous.distance + (previous.speed + speed) * elapsed / 2,
      time: previous.time + elapsed,
    };
  }

  function travelSeconds(distance, model, speedLimitKmh = Infinity) {
    if (!(distance > 0 && speedLimitKmh > 0)) return 0;
    const { samples, braking } = model;
    const limit = Math.min(samples.at(-1).speed, speedLimitKmh / 3.6);
    let speed = limit;
    let acceleration = accelerationAt(samples, speed);
    let brakingDistance = speed * speed / (2 * braking);

    if (acceleration.distance + brakingDistance > distance) {
      let lower = 0;
      let upper = limit;
      for (let index = 0; index < 48; index++) {
        const middle = (lower + upper) / 2;
        const required = accelerationAt(samples, middle).distance + middle * middle / (2 * braking);
        if (required <= distance) lower = middle;
        else upper = middle;
      }
      speed = lower;
      if (speed === 0) return 0;
      acceleration = accelerationAt(samples, speed);
      brakingDistance = speed * speed / (2 * braking);
    }

    const cruiseDistance = Math.max(0, distance - acceleration.distance - brakingDistance);
    return acceleration.time + cruiseDistance / speed + speed / braking;
  }

  function accelerationFromSpeed(samples, speed) {
    let low = 1;
    let high = samples.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].speed <= speed) low = middle + 1;
      else high = middle;
    }
    return samples[Math.min(low, samples.length - 1)].acceleration;
  }

  function travelTerrainSeconds(pieces, model, speedLimitKmh = Infinity) {
    if (!pieces.length || !(speedLimitKmh > 0)) return 0;
    if (pieces.every(({ grade, speedFactor, gripFactor }) => grade === 0 && speedFactor === 1 && gripFactor === 1)) {
      return travelSeconds(pieces.reduce((total, piece) => total + piece.distance, 0), model, speedLimitKmh);
    }

    const { samples, shifts } = model;
    const maxSpeed = samples.at(-1).speed;
    const userLimit = speedLimitKmh / 3.6;
    const segments = pieces.map(({ distance, grade, speedFactor, powerFactor, gripFactor }) => ({
      distance,
      cap: Math.min(userLimit, maxSpeed * speedFactor),
      grip: gripAcceleration * gripFactor,
      power: powerFactor * (grade > 0 ? 1 / (1 + 7 * grade) : 1 - 1.5 * grade),
      braking: Math.min(gripAcceleration * gripFactor,
        model.braking * gripFactor * Math.max(0.35, Math.min(1.4, 1 + 2.5 * grade))),
    }));
    const safeSpeeds = new Float64Array(segments.length + 1);
    // Set approach speeds from the destination backwards so the vehicle can
    // slow for a surface change or stop without jumping to a lower speed.
    for (let index = segments.length - 1; index >= 0; index--) {
      const { cap, distance, braking } = segments[index];
      safeSpeeds[index] = Math.min(cap, Math.sqrt(safeSpeeds[index + 1] ** 2 + 2 * braking * distance));
    }

    let time = 0;
    let start = 0;
    for (const [index, segment] of segments.entries()) {
      const { distance, cap, grip, power, braking } = segment;
      const launch = Math.min(grip, accelerationFromSpeed(samples, start) * power);
      const reachable = Math.sqrt(start ** 2 + 2 * launch * distance);
      const acceleration = Math.min(grip, accelerationFromSpeed(samples, (start + Math.min(cap, reachable)) / 2) * power);
      const end = Math.min(safeSpeeds[index + 1], cap, Math.sqrt(start ** 2 + 2 * acceleration * distance));
      const peakSquared = (2 * acceleration * braking * distance + braking * start ** 2 + acceleration * end ** 2)
        / (acceleration + braking);
      const peak = Math.max(start, end, Math.min(cap, Math.sqrt(peakSquared)));
      const accelerating = (peak ** 2 - start ** 2) / (2 * acceleration);
      const brakingDistance = (peak ** 2 - end ** 2) / (2 * braking);
      const cruising = Math.max(0, distance - accelerating - brakingDistance);
      time += (peak - start) / acceleration + cruising / peak + (peak - end) / braking;
      for (const shift of shifts) {
        if (start <= shift.speed && shift.speed < peak) time += shift.time * (1 - shift.speed / peak);
      }
      start = end;
    }
    return time;
  }

  return { prepare, travelSeconds, travelTerrainSeconds };
})();

if (typeof module !== "undefined") module.exports = Driving;
