"use strict";

const Terrain = (() => {
  // Estimated pace as a fraction of the firm-road speed, wheeled then tracked.
  const surfacePace = {
    Dirt: [0.84, 0.93], DirtGravel: [0.88, 0.95], Gravel: [0.9, 0.95],
    Grass: [0.76, 0.89], GrassField: [0.71, 0.86], Leaves: [0.74, 0.85], Bush: [0.62, 0.78],
    Rock: [0.76, 0.84], LooseRocks: [0.69, 0.82], Clay: [0.71, 0.84],
    Sand: [0.6, 0.76], Mud: [0.47, 0.67], Snow: [0.64, 0.8],
  };

  async function load(map) {
    const script = document.createElement("script");
    script.src = `maps/${encodeURIComponent(map.name)}/terrain.js`;
    const payload = await new Promise((resolve, reject) => {
      script.onload = () => {
        script.remove();
        resolve(script.terrainPayload);
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Terrain bundle could not be loaded."));
      };
      document.head.append(script);
    });
    const bytes = Uint8Array.from(atob(payload), (value) => value.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const data = await new Response(stream).json();
    if (data.map !== map.name || data.schemaVersion !== 1 || !data.grid?.rows || !data.grid?.columns) {
      throw new Error("Terrain bundle does not match the selected map.");
    }
    return data;
  }

  function sampleRoute(points, width, height, terrain) {
    const { columns, rows } = terrain.grid;
    const sampleSpacing = Math.min(width / columns, height / rows);
    const pieces = [];
    let sampledMeters = 0;
    let classifiedMeters = 0;
    let waterMeters = 0;

    function sample(x, y) {
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return terrain.rows[Math.min(rows - 1, Math.floor(y * rows))][Math.min(columns - 1, Math.floor(x * columns))];
    }

    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const dx = points[index].x - start.x;
      const dy = points[index].y - start.y;
      const distance = Math.hypot(dx * width, dy * height);
      if (!distance) continue;
      const ux = dx * width / distance;
      const uy = dy * height / distance;
      const count = Math.max(1, Math.ceil(2 * Math.hypot(dx * columns, dy * rows)));
      const horizontal = distance / count;
      for (let part = 0; part < count; part++) {
        const fraction = (part + 0.5) / count;
        const x = start.x + dx * fraction;
        const y = start.y + dy * fraction;
        const cell = sample(x, y);
        let grade = 0;
        let surface = null;
        if (cell) {
          sampledMeters += horizontal;
          surface = terrain.surfaces[cell[3]];
          if (isClassified(surface)) classifiedMeters += horizontal;
          if (surface.type === "Water") waterMeters += horizontal;
          if (cell[1] !== null && cell[2] !== null) {
            grade = (cell[1] * ux + cell[2] * uy) / 1000;
          } else {
            // Use nearby elevations when the trace did not have a usable normal.
            const before = sample(x - ux * sampleSpacing / width, y - uy * sampleSpacing / height);
            const after = sample(x + ux * sampleSpacing / width, y + uy * sampleSpacing / height);
            if (before && after && before[3] === cell[3] && after[3] === cell[3]) {
              grade = (after[0] - before[0]) / (20 * sampleSpacing);
            }
          }
        }
        grade = Math.max(-0.45, Math.min(0.45, grade));
        pieces.push({ legIndex: index - 1, distance: horizontal * Math.hypot(1, grade), grade, surface });
      }
    }
    return { pieces, sampledMeters, classifiedMeters, waterMeters };
  }

  function isClassified(surface) {
    return surface && surface.type !== "Unknown" && surface.type !== "Default";
  }

  function paceForGrade(grade, surfacePace) {
    return surfacePace / (1 + 4 * Math.max(0, grade) + 1.25 * Math.max(0, -grade));
  }

  function paceForSurface(surface, tracked) {
    return surfacePace[surface?.type]?.[tracked ? 1 : 0] ?? 1;
  }

  function drivingConditions(pieces, tracked) {
    return pieces.map(({ distance, grade, surface }) => {
      const pace = paceForSurface(surface, tracked);
      const friction = isClassified(surface) && surface.type !== "Water" && Number.isFinite(surface.friction)
        ? Math.sqrt(Math.max(0.25, Math.min(1, surface.friction / 0.95)))
        : 1;
      return { distance, grade, speedFactor: paceForGrade(grade, pace), powerFactor: pace * friction, gripFactor: friction };
    });
  }

  return { load, sampleRoute, drivingConditions, paceForSurface, paceForGrade };
})();

if (typeof module !== "undefined") module.exports = Terrain;
