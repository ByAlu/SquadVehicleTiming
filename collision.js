"use strict";

const Collision = (() => {
  const terrainMath = typeof module === "undefined" ? Terrain : require("./terrain.js");
  const elevationsByGrid = new WeakMap();
  const mappedWaterByTerrain = new WeakMap();
  const alignedWaterByCollision = new WeakMap();
  const overlayTypes = {
    blocked: { label: "Solid obstacle", color: "#fb6468" },
    water: { label: "Deep water", color: "#4d9de8" },
    unknown: { label: "No ground sample", color: "#9795aa" },
    clear: { label: "Clear ground", color: "transparent" },
  };

  function elevations(data) {
    if (!data?.elevationDmInt16Le) return null;
    if (elevationsByGrid.has(data)) return elevationsByGrid.get(data);
    const bytes = Uint8Array.from(atob(data.elevationDmInt16Le), (byte) => byte.charCodeAt(0));
    if (bytes.length !== data.grid.columns * data.grid.rows * 2) throw new Error("Invalid collision elevations.");
    const source = new DataView(bytes.buffer);
    const heights = Int16Array.from({ length: bytes.length / 2 }, (_, index) => source.getInt16(index * 2, true));
    elevationsByGrid.set(data, heights);
    return heights;
  }

  function load(map, water, wadingWater) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `maps/${encodeURIComponent(map.name)}/collision.js`;
      script.onload = async () => {
        script.remove();
        const data = script.collisionData;
        try {
          if (data?.map !== map.name || data.schemaVersion !== 1 || !(data.grid?.columns > 0) ||
              data.rows?.length !== data.grid.rows || !data.rows.every((row) =>
                typeof row === "string" && row.length === data.grid.columns && /^[.#?]+$/.test(row))) {
            throw new Error("Collision grid does not match the selected map.");
          }
          elevations(data);
          if (water) data.water = decodeWater(data.grid, water);
          if (wadingWater?.length > 2) data.wadingWater = await decodeWadingWater(data.grid, wadingWater);
          resolve(data.detail ? refineGrid(data) : data);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Collision grid unavailable."));
      };
      document.head.append(script);
    });
  }

  function decodeWater(grid, [columns, rows, ...ranges]) {
    if (columns !== grid.columns || rows !== grid.rows) return null;
    if (!ranges.length) return { grid, rows: Array(rows).fill(".".repeat(columns)) };
    const cells = new Uint8Array(columns * rows).fill(".".charCodeAt(0));
    const blocked = "#".charCodeAt(0);
    for (let index = 0; index < ranges.length; index += 2) {
      cells.fill(blocked, ranges[index], ranges[index + 1]);
    }
    const lines = Array.from({ length: rows }, (_, row) =>
      String.fromCharCode(...cells.subarray(row * columns, (row + 1) * columns)));
    return { grid, rows: lines };
  }

  async function decodeWadingWater(grid, data) {
    const [columns, rows, payload] = data;
    if (columns !== grid.columns || rows !== grid.rows) return null;
    if (typeof payload !== "string") return decodeWater(grid, data);
    if (!payload) return null;
    const packed = Uint8Array.from(atob(payload), (byte) => byte.charCodeAt(0));
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const depths = new Uint8Array(await new Response(stream).arrayBuffer());
    if (depths.length !== columns * rows) throw new Error("Invalid wading depths.");
    return { grid, depths };
  }

  function refineGrid(data) {
    const { column, row, scale, columns, rows, waterSpans, wadingDepthCm } = data.detail;
    const base = data.grid;
    if (![column, row, scale, columns].every(Number.isInteger) || scale < 2 || column < 0 || row < 0 ||
        columns <= 0 || !Array.isArray(rows) || !rows.length || columns % scale || rows.length % scale ||
        column + columns / scale > base.columns || row + rows.length / scale > base.rows ||
        !rows.every((line) => typeof line === "string" && line.length === columns && /^[.#?]+$/.test(line))) {
      throw new Error("Invalid collision detail grid.");
    }
    const patch = { columns, rows: rows.length };
    const grid = { columns: base.columns * scale, rows: base.rows * scale,
      columnSpacingMeters: base.columnSpacingMeters / scale, rowSpacingMeters: base.rowSpacingMeters / scale };
    const left = column * scale;
    const top = row * scale;

    function expandRows(source, detail) {
      return source.flatMap((line, coarseRow) => {
        const expanded = line.replace(/./g, (cell) => cell.repeat(scale));
        return Array.from({ length: scale }, (_, subrow) => {
          const fineRow = detail[coarseRow * scale + subrow - top];
          return fineRow === undefined ? expanded : expanded.slice(0, left) + fineRow + expanded.slice(left + columns);
        });
      });
    }

    function expandSamples(source, detail) {
      if (detail.length !== columns * patch.rows) throw new Error("Invalid collision detail samples.");
      const expanded = new source.constructor(grid.columns * grid.rows);
      for (let y = 0; y < base.rows; y++) {
        const offset = y * scale * grid.columns;
        for (let x = 0; x < base.columns; x++) {
          expanded.fill(source[y * base.columns + x], offset + x * scale, offset + (x + 1) * scale);
        }
        for (let subrow = 1; subrow < scale; subrow++) {
          expanded.copyWithin(offset + subrow * grid.columns, offset, offset + grid.columns);
        }
      }
      for (let y = 0; y < patch.rows; y++) {
        expanded.set(detail.subarray(y * columns, (y + 1) * columns), (top + y) * grid.columns + left);
      }
      return expanded;
    }

    const baseGround = { grid: base, heights: elevations(data) };
    const detailBounds = { left, top, right: left + columns, bottom: top + patch.rows };
    const refined = { ...data, grid, baseGround, detailBounds, rows: expandRows(data.rows, rows) };
    const detailHeights = elevations({ grid: patch, elevationDmInt16Le: data.detail.elevationDmInt16Le });
    elevationsByGrid.set(refined, expandSamples(baseGround.heights, detailHeights));
    const water = decodeWater(patch, [columns, patch.rows, ...waterSpans]);
    if (data.water) refined.water = { grid, rows: expandRows(data.water.rows, water.rows) };
    if (data.wadingWater) {
      const detailDepths = Uint8Array.from(atob(wadingDepthCm), (byte) => byte.charCodeAt(0));
      if (data.wadingWater.depths) {
        refined.wadingWater = { grid, depths: expandSamples(data.wadingWater.depths, detailDepths) };
      } else {
        const wet = rows.map((_, y) => Array.from(detailDepths.subarray(y * columns, (y + 1) * columns),
          (depth) => depth ? "#" : ".").join(""));
        refined.wadingWater = { grid, rows: expandRows(data.wadingWater.rows, wet) };
      }
    }
    return refined;
  }

  function inDetail(column, row, bounds) {
    return column >= bounds.left && column < bounds.right && row >= bounds.top && row < bounds.bottom;
  }

  function waterGrid(terrain, collision, alignToCollision = false) {
    if (collision?.water) return collision.water;
    if (!terrain) return null;
    if (!mappedWaterByTerrain.has(terrain)) {
      const water = terrain.surfaces.map((surface) => surface.type === "Water");
      const rows = water.includes(true) ? Array.from({ length: terrain.grid.rows }, (_, row) =>
        Array.from({ length: terrain.grid.columns }, (_, column) =>
          water[terrainMath.surfaceIndexAt(terrain, column, row)] ? "#" : ".").join("")) : null;
      mappedWaterByTerrain.set(terrain, rows ? { grid: terrain.grid, rows } : null);
    }
    const mapped = mappedWaterByTerrain.get(terrain);
    if (!collision || !mapped || !alignToCollision) return mapped;
    if (!alignedWaterByCollision.has(collision)) {
      const { grid } = collision;
      const columns = Int32Array.from({ length: grid.columns }, (_, x) =>
        Math.floor((x + 0.5) * mapped.grid.columns / grid.columns));
      const dry = ".".repeat(grid.columns);
      const rows = Array.from({ length: grid.rows }, (_, y) => {
        const mappedLine = mapped.rows[Math.floor((y + 0.5) * mapped.grid.rows / grid.rows)];
        if (!mappedLine.includes("#")) return dry;
        return Array.from(columns, (column) => mappedLine[column]).join("");
      });
      alignedWaterByCollision.set(collision, { grid, rows });
    }
    return alignedWaterByCollision.get(collision);
  }

  function overlayCell(column, row, data, water) {
    const cell = data.rows[row][column];
    if (cell === "#") return "blocked";
    if (water?.rows[row]?.[column] === "#") return "water";
    return cell === "." ? "clear" : "unknown";
  }

  function overlayLabelAt(x, y, data, water = data.water) {
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const { columns, rows } = data.grid;
    const column = Math.min(columns - 1, Math.floor(x * columns));
    const row = Math.min(rows - 1, Math.floor(y * rows));
    return overlayTypes[overlayCell(column, row, data, water)].label;
  }

  function drawOverlay(canvas, data, water = data.water) {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { columns, rows } = data.grid;
    canvas.width = columns;
    canvas.height = rows;
    const image = context.createImageData(columns, rows);
    const colors = Object.fromEntries(Object.entries(overlayTypes).map(([type, { color }]) =>
      [type, Number.parseInt(color.slice(1), 16)]));
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const type = overlayCell(column, row, data, water);
        if (type === "clear") continue;
        const rgb = colors[type];
        const offset = (row * columns + column) * 4;
        image.data[offset] = rgb >> 16;
        image.data[offset + 1] = (rgb >> 8) & 255;
        image.data[offset + 2] = rgb & 255;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    return Object.values(overlayTypes).map(({ label, color }) => [label, color]);
  }

  function clearance(data, mapWidth, mapHeight, vehicleWidth) {
    if (!data || ![mapWidth, mapHeight, vehicleWidth].every((value) => Number.isFinite(value) && value > 0)) return null;
    const { columns, rows } = data.grid;
    const width = mapWidth / columns;
    const height = mapHeight / rows;
    const radius = vehicleWidth / 2;
    const radiusSquared = radius * radius;
    const stepCells = new Map();

    function sweep(ax, ay, bx, by, visit, clip) {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const first = Math.ceil((Math.min(ay, by) - radius) / height) - 1;
      const last = Math.floor((Math.max(ay, by) + radius) / height);

      function intersects(left, top, right, bottom) {
        if ((!dx && (ax < left || ax > right)) || (!dy && (ay < top || ay > bottom))) return false;
        const x1 = dx ? (left - ax) / dx : -Infinity;
        const x2 = dx ? (right - ax) / dx : Infinity;
        const y1 = dy ? (top - ay) / dy : -Infinity;
        const y2 = dy ? (bottom - ay) / dy : Infinity;
        return Math.max(0, Math.min(x1, x2), Math.min(y1, y2)) <= Math.min(1, Math.max(x1, x2), Math.max(y1, y2));
      }

      function nearCorner(x, y) {
        const t = lengthSquared ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
        const offsetX = x - (ax + dx * t);
        const offsetY = y - (ay + dy * t);
        return offsetX * offsetX + offsetY * offsetY <= radiusSquared;
      }

      for (let row = clip ? Math.max(0, first) : first; row <= (clip ? Math.min(rows - 1, last) : last); row++) {
        const top = row * height;
        const bottom = top + height;
        const a = dy ? (top - radius - ay) / dy : 0;
        const b = dy ? (bottom + radius - ay) / dy : 1;
        const x1 = ax + dx * Math.max(0, Math.min(a, b));
        const x2 = ax + dx * Math.min(1, Math.max(a, b));
        const leftmost = Math.ceil((Math.min(x1, x2) - radius) / width) - 1;
        const rightmost = Math.floor((Math.max(x1, x2) + radius) / width);
        for (let column = clip ? Math.max(0, leftmost) : leftmost;
          column <= (clip ? Math.min(columns - 1, rightmost) : rightmost); column++) {
          if (clip && data.rows[row][column] !== "#") continue;
          const left = column * width;
          const right = left + width;
          // Expanding a cell by the vehicle radius adds two strips and four rounded corners.
          if (intersects(left - radius, top, right + radius, bottom) ||
              intersects(left, top - radius, right, bottom + radius) ||
              nearCorner(left, top) || nearCorner(left, bottom) || nearCorner(right, top) || nearCorner(right, bottom)) {
            if (visit(column, row)) return true;
          }
        }
      }
      return false;
    }

    return {
      blocksSegment: (a, b) => sweep(a.x * mapWidth, a.y * mapHeight, b.x * mapWidth, b.y * mapHeight, () => true, true),
      blocksStep(x, y, dx, dy) {
        const key = (dy + 1) * 3 + dx + 1;
        if (!stepCells.has(key)) {
          const offsets = [];
          sweep(width / 2, height / 2, (dx + 0.5) * width, (dy + 0.5) * height, (column, row) => {
            offsets.push([column, row]);
          }, false);
          stepCells.set(key, offsets);
        }
        return stepCells.get(key).some(([column, row]) => data.rows[y + row]?.[x + column] === "#");
      },
    };
  }

  function segment(a, b, data, water = null, footprint = null) {
    if (!data) return "unknown";
    const { columns, rows } = data.grid;
    const ax = a.x * columns;
    const ay = a.y * rows;
    const bx = b.x * columns;
    const by = b.y * rows;
    const dx = bx - ax;
    const dy = by - ay;
    if (![ax, ay, bx, by].every(Number.isFinite) || Math.min(ax, bx, ay, by) < 0 ||
        Math.max(ax, bx) > columns || Math.max(ay, by) > rows) return "unknown";
    if (footprint?.blocksSegment(a, b)) return "blocked";
    let x = Math.min(columns - 1, Math.floor(ax));
    let y = Math.min(rows - 1, Math.floor(ay));
    const endX = Math.min(columns - 1, Math.floor(bx));
    const endY = Math.min(rows - 1, Math.floor(by));
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    let crossingX = dx ? (x + (dx > 0 ? 1 : 0) - ax) / dx : Infinity;
    let crossingY = dy ? (y + (dy > 0 ? 1 : 0) - ay) / dy : Infinity;
    let unknown = false;

    function blocked(column, row) {
      const cell = data.rows[row]?.[column];
      if (cell !== "." && cell !== "#" && water?.rows[row]?.[column] !== "#") unknown = true;
      return cell === "#";
    }

    // Check both sides when the segment runs along an internal cell boundary.
    const onVerticalBoundary = !dx && ax > 0 && ax < columns && Number.isInteger(ax);
    const onHorizontalBoundary = !dy && ay > 0 && ay < rows && Number.isInteger(ay);
    while (true) {
      if (blocked(x, y) || (onVerticalBoundary && blocked(x - 1, y)) ||
          (onHorizontalBoundary && blocked(x, y - 1))) return "blocked";
      if (x === endX && y === endY) return unknown ? "unknown" : "clear";
      const tx = x === endX ? Infinity : crossingX;
      const ty = y === endY ? Infinity : crossingY;
      const crossX = tx <= ty + 1e-10;
      const crossY = ty <= tx + 1e-10;
      if (crossX && crossY && (blocked(x + stepX, y) || blocked(x, y + stepY))) return "blocked";
      if (crossX) {
        x += stepX;
        crossingX += 1 / Math.abs(dx);
      }
      if (crossY) {
        y += stepY;
        crossingY += 1 / Math.abs(dy);
      }
    }
  }

  function path(points, data, water = null, footprint = null) {
    let status = "clear";
    for (let index = 1; index < points.length; index++) {
      const check = segment(points[index - 1], points[index], data, water, footprint);
      if (check === "blocked") return check;
      if (check === "unknown") status = check;
    }
    return status;
  }

  return { load, segment, path, clearance, elevations, waterGrid, drawOverlay, overlayLabelAt, inDetail };
})();

if (typeof module !== "undefined") module.exports = Collision;
