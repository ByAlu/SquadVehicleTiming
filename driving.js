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
    let speed = 0;
    let distance = 0;
    let time = 0;

    for (const [index, gear] of gears.entries()) {
      const rpmPerMeterPerSecond = 60 * gear.ratio / metersPerRotation;
      const targetRpm = index === gears.length - 1 ? gear.limitRpm : gear.shiftRpm;
      const targetSpeed = Math.min(maxSpeed, targetRpm / rpmPerMeterPerSecond);
      if (index > 0 && speed > 0 && shiftSeconds > 0) {
        time += shiftSeconds;
        distance += speed * shiftSeconds;
        samples.push({ speed, distance, time });
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
        samples.push({ speed, distance, time });
      }
      if (speed === maxSpeed) break;
    }

    return speed > 0 && braking > 0 && Number.isFinite(time) ? { samples, braking } : null;
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

  return { prepare, travelSeconds };
})();

if (typeof module !== "undefined") module.exports = Driving;
