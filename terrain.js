"use strict";

const Terrain = (() => {
  const maxGrade = 0.45;
  const fallbackWadingSpeedKmh = 14;
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
  const packedCells = new WeakMap();
  const cellBytes = 12;
  const missingGrade = -2147483648;
  const missingElevation = -32768;
  const heightColors = ["#29265c", "#345f8c", "#21918c", "#84b860", "#f7e284"];

  function rememberCells(terrain, buffer, offset = 0, length = buffer.byteLength) {
    if (length !== terrain.grid.columns * terrain.grid.rows * cellBytes) {
      throw new Error("Invalid packed terrain grid.");
    }
    const cells = new DataView(buffer, offset, length);
    packedCells.set(terrain, cells);
    return cells;
  }

  function cellsFor(terrain) {
    const cached = packedCells.get(terrain);
    if (cached || terrain.schemaVersion !== 2) return cached;
    // Node callers can read terrain.json directly without loading the browser bundle.
    const bytes = require("node:zlib").gunzipSync(Buffer.from(terrain.cellsGzipBase64, "base64"));
    return rememberCells(terrain, bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function decompress(payload) {
    const text = atob(payload);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  }

  async function load(map) {
    const script = document.createElement("script");
    script.src = `maps/${encodeURIComponent(map.name)}/terrain.js`;
    const bundle = await new Promise((resolve, reject) => {
      script.onload = () => {
        script.remove();
        resolve(script.terrainData ?? script.terrainPayload);
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Terrain bundle could not be loaded."));
      };
      document.head.append(script);
    });
    const data = typeof bundle === "string" ? await new Response(decompress(bundle)).json() : bundle;
    if (data?.map !== map.name || ![1, 2].includes(data.schemaVersion) || !data.grid?.rows || !data.grid?.columns) {
      throw new Error("Terrain bundle does not match the selected map.");
    }
    if (data.schemaVersion === 2) {
      const cells = new Uint8Array(data.grid.columns * data.grid.rows * cellBytes);
      let offset = 0;
      for await (const chunk of decompress(data.cellsGzipBase64)) {
        cells.set(chunk, offset);
        offset += chunk.length;
      }
      rememberCells(data, cells.buffer, 0, offset);
      delete data.cellsGzipBase64;
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

  function cellAt(terrain, column, row) {
    const { columns, rows } = terrain.grid;
    if (!(column >= 0 && column < columns && row >= 0 && row < rows)) return null;
    const cells = cellsFor(terrain);
    if (!cells) return terrain.rows[row]?.[column];
    const offset = (row * columns + column) * cellBytes;
    const height = cells.getInt16(offset, true);
    if (height === missingElevation) return null;
    const right = cells.getInt32(offset + 2, true);
    const down = cells.getInt32(offset + 6, true);
    return [height, right === missingGrade ? null : right, down === missingGrade ? null : down,
      cells.getUint16(offset + 10, true)];
  }

  function surfaceIndexAt(terrain, column, row) {
    const cells = cellsFor(terrain);
    if (!cells) return terrain.rows[row]?.[column]?.[3];
    const offset = (row * terrain.grid.columns + column) * cellBytes;
    return cells.getInt16(offset, true) === missingElevation ? undefined : cells.getUint16(offset + 10, true);
  }

  function elevationDm(terrain, cells, column, row) {
    return cells ? cells.getInt16((row * terrain.grid.columns + column) * cellBytes, true)
      : terrain.rows[row]?.[column]?.[0] ?? missingElevation;
  }

  function elevationAt(x, y, terrain) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const { columns, rows } = terrain.grid;
    const height = elevationDm(terrain, cellsFor(terrain), Math.min(columns - 1, Math.floor(x * columns)),
      Math.min(rows - 1, Math.floor(y * rows)));
    return height === missingElevation ? null : height / 10;
  }

  function drawHeightOverlay(canvas, terrain) {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { columns, rows } = terrain.grid;
    const cells = cellsFor(terrain);
    let low = Infinity;
    let high = -Infinity;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const height = elevationDm(terrain, cells, column, row);
        if (height === missingElevation) continue;
        if (height < low) low = height;
        if (height > high) high = height;
      }
    }
    if (low === Infinity) return null;

    const colors = heightColors.map((hex) => Number.parseInt(hex.slice(1), 16));
    const ramp = Array.from({ length: 256 }, (_, index) => {
      const position = index * (colors.length - 1) / 255;
      const first = Math.min(colors.length - 2, Math.floor(position));
      const fraction = position - first;
      return [16, 8, 0].map((shift) => {
        const from = (colors[first] >> shift) & 255;
        const to = (colors[first + 1] >> shift) & 255;
        return Math.round(from + (to - from) * fraction);
      });
    });
    // Limit the display canvas while sampling the cursor from the full terrain grid.
    const scale = Math.min(1, 2048 / Math.max(columns, rows));
    const width = canvas.width = Math.max(1, Math.round(columns * scale));
    const height = canvas.height = Math.max(1, Math.round(rows * scale));
    const image = context.createImageData(width, height);
    const columnAt = Int32Array.from({ length: width }, (_, x) => Math.floor((x + 0.5) * columns / width));
    for (let y = 0; y < height; y++) {
      const row = Math.floor((y + 0.5) * rows / height);
      for (let x = 0; x < width; x++) {
        const value = elevationDm(terrain, cells, columnAt[x], row);
        if (value === missingElevation) continue;
        const [red, green, blue] = ramp[high === low ? 128 : Math.round(255 * (value - low) / (high - low))];
        const offset = (y * width + x) * 4;
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const gradient = low === high ? `rgb(${ramp[128].join(",")})` : `linear-gradient(to right, ${heightColors.join(", ")})`;
    return { min: low / 10, max: high / 10, gradient };
  }

  function sampleCell(x, y, terrain) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const { columns, rows } = terrain.grid;
    return cellAt(terrain, Math.min(columns - 1, Math.floor(x * columns)), Math.min(rows - 1, Math.floor(y * rows)));
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
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const { columns, rows } = terrain.grid;
    return terrain.surfaces[surfaceIndexAt(terrain, Math.min(columns - 1, Math.floor(x * columns)),
      Math.min(rows - 1, Math.floor(y * rows)))] ?? null;
  }

  function groundGrade(x, y, ux, uy, width, height, ground) {
    const { columns, rows } = ground.grid;
    const column = Math.min(columns - 1, Math.floor(x * columns));
    const row = Math.min(rows - 1, Math.floor(y * rows));
    const at = (cx, cy) => cx >= 0 && cx < columns && cy >= 0 && cy < rows ? ground.heights[cy * columns + cx] : -32768;
    const bounds = ground.detailBounds;
    if (bounds && (column < bounds.left || column >= bounds.right || row < bounds.top || row >= bounds.bottom)) {
      return groundGrade(x, y, ux, uy, width, height, ground.baseGround);
    }
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

  function waterAt(x, y, water) {
    if (!water) return false;
    const { columns, rows } = water.grid;
    return water.rows[Math.min(rows - 1, Math.floor(y * rows))]?.[
      Math.min(columns - 1, Math.floor(x * columns))] === "#";
  }

  function wadingDepthInCell(water, column, row) {
    if (water?.depths) return water.depths[row * water.grid.columns + column] ?? 0;
    // A legacy wet cell has no measured depth.
    return water?.rows[row]?.[column] === "#" ? null : 0;
  }

  function wadingDepthAt(x, y, water, surface) {
    if (water) {
      const { columns, rows } = water.grid;
      const depth = wadingDepthInCell(water, Math.min(columns - 1, Math.floor(x * columns)),
        Math.min(rows - 1, Math.floor(y * rows)));
      if (depth !== 0) return depth;
    }
    return surface?.type === "Water" ? null : 0;
  }

  function wadingGear(depthCm, profile) {
    if (!(depthCm > 0) || !profile || profile.tracked || !(profile.radiusMeters > 0) || !profile.gears?.length) return null;
    const tireHeightCm = Math.round(200 * profile.radiusMeters);
    return Math.min(profile.gears.length, depthCm > tireHeightCm ? 1 : 2);
  }

  function wadingSpeedLimitKmh(depthCm, profile) {
    if (depthCm === 0) return Infinity;
    const gear = wadingGear(depthCm, profile);
    if (!gear) return fallbackWadingSpeedKmh;
    const { ratio, limitRpm } = profile.gears[gear - 1];
    const limit = 2 * Math.PI * profile.radiusMeters * limitRpm * 0.06 / ratio;
    // The CTM131 transport reached 14 km/h in first-gear water at the Al Basrah ford.
    const observedLimit = gear === 1 && profile.name === "CTM131" ? 14 : Infinity;
    return Math.min(profile.speedLimitKmh, limit, observedLimit);
  }

  function sampleRoute(points, width, height, terrain, ground = null, water = null, wadingWater = null) {
    const { columns, rows } = terrain.grid;
    const sampleGrid = ground?.grid ?? wadingWater?.grid ?? water?.grid ?? terrain.grid;
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
        if (waterAt(x, y, water)) {
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
        const wadingDepthCm = wadingDepthAt(x, y, wadingWater, terrain.surfaces[cell?.[3]]);
        if (cell || measuredGrade !== null || wadingDepthCm !== 0) sampledMeters += horizontal;
        if (cell) {
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
          grade = measuredGrade;
        }
        grade = Math.max(-maxGrade, Math.min(maxGrade, grade));
        pieces.push({ legIndex: index - 1, distance: horizontal * Math.hypot(1, grade), grade, surface, wadingDepthCm });
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

  function drivingConditions(pieces, tracked, profile = null) {
    return pieces.map(({ distance, grade, surface, water, wadingDepthCm = 0 }) => {
      const pace = paceForSurface(surface, tracked);
      const friction = surface?.type !== "Water" && Number.isFinite(surface?.friction) && surface.friction > 0
        ? surface.friction
        : 1;
      const speedLimitKmh = wadingSpeedLimitKmh(wadingDepthCm, profile);
      return { distance, grade, speedFactor: paceForGrade(grade, pace), powerFactor: pace, gripFactor: friction, water, speedLimitKmh };
    });
  }

  return { maxGrade, load, drawSurfaceOverlay, drawHeightOverlay, elevationAt, cellAt, surfaceIndexAt, surfaceAt, waterAt, wadingDepthAt, wadingDepthInCell, wadingGear,
    wadingSpeedLimitKmh, sampleRoute, drivingConditions, paceForSurface, paceForGrade };
})();

if (typeof module !== "undefined") module.exports = Terrain;
