"use strict";

const Driving = (() => {
  const drivetrainEfficiency = 1.0;
  const gravity = 9.8;
  const fallbackFriction = 0.55;
  const speedStep = 0.15;
  const waterPhysicsStep = 1 / 60;

  function waterCruiseSpeedKmh(settings) {
    const { thrustKgCmS2, densityKgCm3, surfaceAreaCm2, forwardDragCoefficient, fullDepthDragScale, massKg } =
      settings ?? {};
    if (![thrustKgCmS2, densityKgCm3, surfaceAreaCm2, forwardDragCoefficient, fullDepthDragScale, massKg]
      .every((value) => Number.isFinite(value) && value > 0)) return null;

    const drag = 0.5 * densityKgCm3 * surfaceAreaCm2 * forwardDragCoefficient;
    // Solve thrust = scale * drag * speed² / (1 + drag * speed * step / mass).
    const linear = thrustKgCmS2 * waterPhysicsStep / (massKg * fullDepthDragScale);
    const constant = thrustKgCmS2 / (drag * fullDepthDragScale);
    const speedCmS = (linear + Math.hypot(linear, 2 * Math.sqrt(constant))) / 2;
    const speedKmh = speedCmS * 0.036;
    return Number.isFinite(speedKmh) && speedKmh > 0 ? speedKmh : null;
  }

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

  function prepare(profile, groundFriction = 1) {
    const { radiusMeters, massKg, gears, torque, idleRpm, brakeTorqueNm, shiftSeconds } = profile;
    const gripAcceleration = (profile.frictionMultiplier ?? fallbackFriction) * groundFriction * gravity;
    const brakeAcceleration = brakeTorqueNm / (radiusMeters * massKg);
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
        samples.push({ speed, distance, time, engineAcceleration: samples.at(-1).engineAcceleration });
      }

      while (speed < targetSpeed) {
        const nextSpeed = Math.min(targetSpeed, speed + speedStep);
        const midpoint = (speed + nextSpeed) / 2;
        const rpm = Math.max(idleRpm, midpoint * rpmPerMeterPerSecond);
        const force = engineTorque(torque, rpm) * gear.ratio * drivetrainEfficiency / radiusMeters;
        const engineAcceleration = force / massKg;
        const acceleration = Math.min(gripAcceleration, engineAcceleration);
        if (!(acceleration > 0)) break;

        const duration = (nextSpeed - speed) / acceleration;
        time += duration;
        distance += midpoint * duration;
        speed = nextSpeed;
        samples.push({ speed, distance, time, engineAcceleration });
      }
      if (speed === maxSpeed) break;
    }

    if (!(speed > 0 && brakeAcceleration > 0 && Number.isFinite(time))) return null;
    return { profile, samples, brakeAcceleration, gripAcceleration, shifts };
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

  function accelerationTimeAtDistance(samples, distance) {
    let low = 1;
    let high = samples.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].distance < distance) low = middle + 1;
      else high = middle;
    }
    const before = samples[low - 1];
    const after = samples[low];
    const traveled = distance - before.distance;
    const fraction = traveled / (after.distance - before.distance);
    const speed = Math.sqrt(before.speed ** 2 + fraction * (after.speed ** 2 - before.speed ** 2));
    return before.time + 2 * traveled / (before.speed + speed);
  }

  function flatTravelClock(model, speedLimitKmh) {
    if (!(speedLimitKmh > 0)) return () => 0;
    const { samples } = model;
    const speed = Math.min(samples.at(-1).speed, speedLimitKmh / 3.6);
    const acceleration = accelerationAt(samples, speed);
    return (position) => {
      if (!(position > 0)) return 0;
      if (position < acceleration.distance) return accelerationTimeAtDistance(samples, position);
      return acceleration.time + (position - acceleration.distance) / speed;
    };
  }

  function travelSeconds(distance, model, speedLimitKmh = Infinity) {
    return distance > 0 ? flatTravelClock(model, speedLimitKmh)(distance) : 0;
  }

  function travelLegSeconds(distances, model, speedLimitKmh = Infinity) {
    if (!distances.length) return [];
    const timeAt = flatTravelClock(model, speedLimitKmh);
    let position = 0;
    let elapsed = 0;
    return distances.map((distance) => {
      position += distance;
      const time = timeAt(position);
      const duration = time - elapsed;
      elapsed = time;
      return duration;
    });
  }

  function accelerationFromSpeed(samples, speed) {
    let low = 1;
    let high = samples.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].speed <= speed) low = middle + 1;
      else high = middle;
    }
    return samples[Math.min(low, samples.length - 1)].engineAcceleration;
  }

  function slopeFade(value, min, max) {
    if (Math.abs(max - min) <= 1e-8) return value < max ? 1 : 0;
    return 1 - Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  function slopeAcceleration(slope, incline, speed) {
    if (!slope || speed <= 0.1) return 0;
    if (incline < 0) return speed * incline * slope.brakingFactor;

    const speedFade = slopeFade(speed * 3.6, slope.minSpeedKmh, slope.maxSpeedKmh);
    // UpdateSlopeForces compares the direction's vertical component with radians.
    const radiansPerDegree = Math.PI / 180;
    const angleFade = slopeFade(incline, slope.minAngleDegrees * radiansPerDegree, slope.maxAngleDegrees * radiansPerDegree);
    return speed * incline * slope.boostFactor * speedFade * angleFade;
  }

  function downhillSpeedLimit(cap, accelerationAtSpeed) {
    if (accelerationAtSpeed(cap) >= 0) return cap;

    // Keep the cruise target within the speed the modeled drive force can sustain.
    let low = 0;
    let high = cap;
    for (let index = 0; index < 12; index++) {
      const speed = (low + high) / 2;
      if (accelerationAtSpeed(speed) >= 0) low = speed;
      else high = speed;
    }
    return low;
  }

  function travelTerrainPieceSeconds(pieces, model, speedLimitKmh = Infinity) {
    if (!pieces.length) return [];
    if (!(speedLimitKmh > 0)) return pieces.map(() => 0);
    const groundFriction = pieces[0].gripFactor;
    if (pieces.every(({ grade, speedFactor, powerFactor, gripFactor, speedLimitKmh: pieceLimit = Infinity }) =>
      grade === 0 && speedFactor === 1 && powerFactor === 1 && gripFactor === groundFriction && pieceLimit >= speedLimitKmh)) {
      const flatModel = groundFriction === 1 ? model : prepare(model.profile, groundFriction);
      return travelLegSeconds(pieces.map((piece) => piece.distance), flatModel, speedLimitKmh);
    }

    const { profile: { slope }, samples, shifts, brakeAcceleration, gripAcceleration } = model;
    const maxSpeed = samples.at(-1).speed;
    const userLimit = speedLimitKmh / 3.6;
    const segments = pieces.map(({ distance, grade, speedFactor, powerFactor, gripFactor, speedLimitKmh: pieceLimit = Infinity }) => {
      const incline = grade / Math.hypot(1, grade);
      const downhill = slope && grade < 0;
      const grip = gripAcceleration * gripFactor;
      const power = powerFactor * (grade > 0 ? 1 / (1 + 7 * grade) : downhill ? 1 : 1 - 1.5 * grade);
      const gravityAssist = downhill ? -gravity * incline : 0;
      const accelerationAtSpeed = (speed) => Math.min(grip, accelerationFromSpeed(samples, speed) * power)
        + gravityAssist + slopeAcceleration(slope, incline, speed);
      const target = Math.min(userLimit, pieceLimit / 3.6, maxSpeed * speedFactor);
      const cap = downhill ? downhillSpeedLimit(target, accelerationAtSpeed) : target;
      const braking = Math.min(grip, brakeAcceleration * Math.max(0.35, Math.min(1.4, 1 + 2.5 * grade)));
      return { distance, cap, incline, accelerationAtSpeed, braking };
    });
    const safeSpeeds = new Float64Array(segments.length + 1);
    safeSpeeds[segments.length] = Infinity;
    // Set approach speeds from the destination backwards so the vehicle can
    // slow for terrain changes. The destination imposes no speed restriction.
    for (let index = segments.length - 1; index >= 0; index--) {
      const { cap, distance, braking } = segments[index];
      safeSpeeds[index] = Math.min(cap, Math.sqrt(safeSpeeds[index + 1] ** 2 + 2 * braking * distance));
    }

    let start = 0;
    return segments.map((segment, index) => {
      const { distance, cap, incline, accelerationAtSpeed } = segment;
      const launch = Math.max(0, accelerationAtSpeed(start));
      const reachable = Math.sqrt(start ** 2 + 2 * launch * distance);
      const sampleSpeed = (start + Math.min(cap, reachable)) / 2;
      const acceleration = Math.max(0, accelerationAtSpeed(sampleSpeed));
      const braking = segment.braking + Math.max(0, -slopeAcceleration(slope, incline, sampleSpeed));
      if (start === 0 && acceleration === 0) return Infinity;
      const end = Math.min(safeSpeeds[index + 1], cap, Math.sqrt(start ** 2 + 2 * acceleration * distance));
      const peakSquared = (2 * acceleration * braking * distance + braking * start ** 2 + acceleration * end ** 2)
        / (acceleration + braking);
      const peak = Math.max(start, end, Math.min(cap, Math.sqrt(peakSquared)));
      const accelerating = acceleration > 0 ? (peak ** 2 - start ** 2) / (2 * acceleration) : 0;
      const brakingDistance = (peak ** 2 - end ** 2) / (2 * braking);
      const cruising = Math.max(0, distance - accelerating - brakingDistance);
      const accelerationTime = acceleration > 0 ? (peak - start) / acceleration : 0;
      let time = accelerationTime + cruising / peak + (peak - end) / braking;
      for (const shift of shifts) {
        if (start <= shift.speed && shift.speed < peak) time += shift.time * (1 - shift.speed / peak);
      }
      start = end;
      return time;
    });
  }

  function travelTerrainSeconds(pieces, model, speedLimitKmh = Infinity) {
    return travelTerrainPieceSeconds(pieces, model, speedLimitKmh).reduce((total, time) => total + time, 0);
  }

  return { prepare, travelSeconds, travelLegSeconds, travelTerrainSeconds, travelTerrainPieceSeconds, waterCruiseSpeedKmh };
})();

if (typeof module !== "undefined") module.exports = Driving;
