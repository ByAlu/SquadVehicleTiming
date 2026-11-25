"use strict";

const Terrain = (() => {
  const maxGrade = 0.45;
  // Estimated pace as a fraction of the firm-road speed, wheeled then tracked.
  const surfacePace = {
    Dirt: [0.84, 0.93], DirtGravel: [0.88, 0.95], Gravel: [0.9, 0.95],
    Grass: [0.76, 0.89], GrassField: [0.71, 0.86], Leaves: [0.74, 0.85], Bush: [0.62, 0.78],
    Rock: [0.76, 0.84], LooseRocks: [0.69, 0.82], Clay: [0.71, 0.84],
    Sand: [0.6, 0.76], Mud: [0.47, 0.67], Snow: [0.64, 0.8],
  };
  const surfaceColors = {
    Asphalt: "#343c4e", Brick: "#d4654e", Bush: "#326341", Carpet: "#d16a98", Clay: "#ca7449",
    Concrete: "#a4a7b1", Default: "#78817a", Dirt: "#a46a42", DirtGravel: "#c9946d", Glass: "#92f1e9",
    Grass: "#6ea84b", GrassField: "#a9c665", Gravel: "#9a8173", Leaves: "#d7b84d", LooseRocks: "#836e9f",
    Metal: "#66849d", Mud: "#654239", Plaster: "#efcfad", Plastic: "#d08ddb", Rock: "#626271",
    Sand: "#f0d283", Snow: "#f4f8ff", Tile: "#86b1b2", Unknown: "#505963", Water: "#4194e3", Wood: "#ad8750",
  };
  const waterSurface = { type: "Water" };

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

  function drawSurfaceOverlay(canvas, terrain, water = null) {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { columns, rows } = water?.grid ?? terrain.grid;
    canvas.width = columns;
    canvas.height = rows;
    const image = context.createImageData(columns, rows);
    const colors = new Map(Object.entries(surfaceColors).map(([type, color]) => {
      const rgb = Number.parseInt(color.slice(1), 16);
      return [type, { color, red: rgb >> 16, green: (rgb >> 8) & 255, blue: rgb & 255 }];
    }));
    const legend = new Map();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const surface = surfaceAt((x + 0.5) / columns, (y + 0.5) / rows, terrain, water);
        if (!surface) continue;
        const { color, red, green, blue } = colors.get(surface.type) ?? colors.get("Unknown");
        const offset = (y * columns + x) * 4;
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        image.data[offset + 3] = 255;
        legend.set(surface.type, color);
      }
    }
    context.putImageData(image, 0, 0);
    return [...legend].sort(([left], [right]) => left.localeCompare(right));
  }

  function sampleCell(x, y, terrain) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const { columns, rows } = terrain.grid;
    return terrain.rows[Math.min(rows - 1, Math.floor(y * rows))]?.[Math.min(columns - 1, Math.floor(x * columns))];
  }

  function surfaceAt(x, y, terrain, water = null) {
    if (water) {
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
      const { columns, rows } = water.grid;
      const column = Math.min(columns - 1, Math.floor(x * columns));
      const row = Math.min(rows - 1, Math.floor(y * rows));
      if (water.rows[row]?.[column] === "#") return waterSurface;
      // Sample at the overlay pixel center so the cursor matches the painted surface.
      x = (column + 0.5) / columns;
      y = (row + 0.5) / rows;
    }
    return terrain.surfaces[sampleCell(x, y, terrain)?.[3]] ?? null;
  }

  function groundGrade(x, y, ux, uy, width, height, ground) {
    const { columns, rows } = ground.grid;
    const column = Math.min(columns - 1, Math.floor(x * columns));
    const row = Math.min(rows - 1, Math.floor(y * rows));
    const at = (cx, cy) => cx >= 0 && cx < columns && cy >= 0 && cy < rows ? ground.heights[cy * columns + cx] : -32768;
    const center = at(column, row);
    if (center === -32768) return null;
    const axis = (before, after, spacing) => {
      if (before === -32768 && after === -32768) return 0;
      if (before === -32768) return (after - center) / (10 * spacing);
      if (after === -32768) return (center - before) / (10 * spacing);
      return (after - before) / (20 * spacing);
    };
    return ux * axis(at(column - 1, row), at(column + 1, row), width / columns) +
      uy * axis(at(column, row - 1), at(column, row + 1), height / rows);
  }

  function sampleRoute(points, width, height, terrain, ground = null, water = null) {
    const { columns, rows } = terrain.grid;
    const sampleGrid = ground?.grid ?? water?.grid ?? terrain.grid;
    const sampleSpacing = Math.min(width / columns, height / rows);
    const pieces = [];
    let sampledMeters = 0;
    let classifiedMeters = 0;
    let waterMeters = 0;

    const sample = (x, y) => sampleCell(x, y, terrain);

    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const dx = points[index].x - start.x;
      const dy = points[index].y - start.y;
      const distance = Math.hypot(dx * width, dy * height);
      if (!distance) continue;
      const ux = dx * width / distance;
      const uy = dy * height / distance;
      const count = Math.max(1, Math.ceil(2 * Math.hypot(dx * sampleGrid.columns, dy * sampleGrid.rows)));
      const horizontal = distance / count;
      for (let part = 0; part < count; part++) {
        const fraction = (part + 0.5) / count;
        const x = start.x + dx * fraction;
        const y = start.y + dy * fraction;
        if (water && water.rows[Math.min(water.grid.rows - 1, Math.floor(y * water.grid.rows))]?.[
          Math.min(water.grid.columns - 1, Math.floor(x * water.grid.columns))] === "#") {
          sampledMeters += horizontal;
          classifiedMeters += horizontal;
          waterMeters += horizontal;
          pieces.push({ legIndex: index - 1, distance: horizontal, grade: 0, surface: null, water: true });
          continue;
        }
        const cell = sample(x, y);
        const measuredGrade = ground ? groundGrade(x, y, ux, uy, width, height, ground) : null;
        let grade = 0;
        let surface = null;
        if (cell) {
          sampledMeters += horizontal;
          surface = terrain.surfaces[cell[3]];
          if (isClassified(surface)) classifiedMeters += horizontal;
          if (measuredGrade !== null) {
            grade = measuredGrade;
          } else if (cell[1] !== null && cell[2] !== null) {
            grade = (cell[1] * ux + cell[2] * uy) / 1000;
          } else {
            // Use nearby elevations when the trace did not have a usable normal.
            const before = sample(x - ux * sampleSpacing / width, y - uy * sampleSpacing / height);
            const after = sample(x + ux * sampleSpacing / width, y + uy * sampleSpacing / height);
            if (before && after && before[3] === cell[3] && after[3] === cell[3]) {
              grade = (after[0] - before[0]) / (20 * sampleSpacing);
            }
          }
        } else if (measuredGrade !== null) {
          sampledMeters += horizontal;
          grade = measuredGrade;
        }
        grade = Math.max(-maxGrade, Math.min(maxGrade, grade));
        pieces.push({ legIndex: index - 1, distance: horizontal * Math.hypot(1, grade), grade, surface });
      }
    }
    return { pieces, sampledMeters, classifiedMeters, waterMeters };
  }

  function isClassified(surface) {
    return surface && surface.type !== "Unknown" && surface.type !== "Default";
  }

  function paceForGrade(grade, surfacePace) {
    return grade < 0 ? surfacePace * (1 - 1.25 * grade) : surfacePace / (1 + 4 * grade);
  }

  function paceForSurface(surface, tracked) {
    return surfacePace[surface?.type]?.[tracked ? 1 : 0] ?? 1;
  }

  function drivingConditions(pieces, tracked) {
    return pieces.map(({ distance, grade, surface, water }) => {
      const pace = paceForSurface(surface, tracked);
      const friction = surface?.type !== "Water" && Number.isFinite(surface?.friction) && surface.friction > 0
        ? surface.friction
        : 1;
      return { distance, grade, speedFactor: paceForGrade(grade, pace), powerFactor: pace, gripFactor: friction, water };
    });
  }

  return { maxGrade, load, drawSurfaceOverlay, surfaceAt, sampleRoute, drivingConditions, paceForSurface, paceForGrade };
})();

if (typeof module !== "undefined") module.exports = Terrain;
