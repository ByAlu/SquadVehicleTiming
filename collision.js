"use strict";

const Collision = (() => {
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
          resolve(data);
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

  function waterGrid(terrain, collision, alignToCollision = false) {
    if (collision?.water) return collision.water;
    if (!terrain) return null;
    if (!mappedWaterByTerrain.has(terrain)) {
      const water = terrain.surfaces.map((surface) => surface.type === "Water");
      const rows = water.includes(true)
        ? terrain.rows.map((row) => row.map((cell) => water[cell?.[3]] ? "#" : ".").join(""))
        : null;
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

  function segment(a, b, data, water = null) {
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

  function path(points, data, water = null) {
    let status = "clear";
    for (let index = 1; index < points.length; index++) {
      const check = segment(points[index - 1], points[index], data, water);
      if (check === "blocked") return check;
      if (check === "unknown") status = check;
    }
    return status;
  }

  return { load, segment, path, elevations, waterGrid, drawOverlay, overlayLabelAt };
})();

if (typeof module !== "undefined") module.exports = Collision;
