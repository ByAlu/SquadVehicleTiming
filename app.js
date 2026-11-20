"use strict";

const find = (id) => document.getElementById(id);
const sdk = window.squadSdkData;
const mapSelect = find("map-select");
const vehicleSelect = find("vehicle-select");
const widthInput = find("width");
const heightInput = find("height");
const speedInput = find("speed");
const viewport = find("viewport");
const stage = find("stage");
const image = find("map-image");
const overlay = find("overlay");
const cursor = find("cursor");
const mapMessage = find("map-message");
const svgNamespace = "http://www.w3.org/2000/svg";
const numeric = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const route = [];
const edits = [];
const scales = new Map();
const speeds = new Map();
const keyboardPoint = { x: 0.5, y: 0.5 };
let keyboardActive = false;
let mode = "draw";
let gesture = null;
let loadId = 0;
let zoom = 1;
let left = 0;
let mapTop = 0;
let drawnWidth = 0;
let drawnHeight = 0;

function selectMap() {
  finishGesture();
  clearRoute();
  const map = sdk.maps[mapSelect.selectedIndex];
  const scale = scales.get(map.name) ?? [map.widthMeters ?? "", map.heightMeters ?? ""];
  [widthInput.value, heightInput.value] = scale;
  find("calibration").open = !map.widthMeters;
  find("map-heading").textContent = map.name;
  viewport.setAttribute("aria-label", `${map.name} route map`);
  updateMapDetail();
  updateEstimate();
  stage.classList.remove("ready");
  drawnWidth = 0;
  drawnHeight = 0;
  updateButtons();
  mapMessage.hidden = false;
  mapMessage.textContent = "Loading minimap…";
  const request = ++loadId;
  const src = `maps/${encodeURIComponent(map.name)}/minimap.webp`;
  const incoming = new Image();
  incoming.onload = () => {
    if (request !== loadId) return;
    image.src = src;
    image.width = incoming.naturalWidth;
    image.height = incoming.naturalHeight;
    mapMessage.hidden = true;
    stage.classList.add("ready");
    fitMap();
  };
  incoming.onerror = () => {
    if (request === loadId) mapMessage.textContent = "The minimap image could not be loaded.";
  };
  incoming.src = src;
}

function updateMapDetail() {
  const map = sdk.maps[mapSelect.selectedIndex];
  const manual = scales.has(map.name);
  if (widthInput.validity.valid && heightInput.validity.valid && widthInput.value && heightInput.value) {
    find("map-detail").textContent = `${numeric.format(widthInput.valueAsNumber)} × ${numeric.format(heightInput.valueAsNumber)} m · ${manual ? "Custom scale" : map.scaleLabel}`;
  } else {
    find("map-detail").textContent = "Enter the minimap width and height to measure this route.";
  }
}

function selectVehicle() {
  const vehicle = sdk.vehicles[Number(vehicleSelect.value)];
  find("vehicle-detail").textContent = [vehicle.faction, vehicle.type].filter(Boolean).join(" · ");
  speedInput.value = speeds.get(vehicle.id) ?? vehicle.assumedSpeedKmh ?? "";
  find("speed-detail").textContent = vehicle.assumedSpeedKmh
    ? `Starting assumption ${numeric.format(vehicle.assumedSpeedKmh)} km/h. Adjust for your route conditions.`
    : "Enter an average speed for your route conditions.";
  updateEstimate();
}

function updateEstimate() {
  const width = widthInput.valueAsNumber;
  const height = heightInput.valueAsNumber;
  const speed = speedInput.valueAsNumber;
  const distance = width >= 1 && height >= 1 ? RouteMath.routeLength(route, width, height) : 0;
  const seconds = speed >= 0.1 ? RouteMath.travelSeconds(distance, speed) : 0;
  find("distance").textContent = distance > 0
    ? distance >= 1000 ? `${numeric.format(distance / 1000)} km` : `${numeric.format(distance)} m`
    : "—";
  find("time").textContent = seconds > 0 && Number.isFinite(seconds) ? RouteMath.formatTime(seconds) : "—";
}

function updateButtons() {
  find("undo").disabled = !edits.length;
  find("clear").disabled = !route.length;
  find("zoom-in").disabled = !drawnWidth || zoom >= 7;
  find("zoom-out").disabled = !drawnWidth || zoom <= 1;
  find("zoom-fit").disabled = !drawnWidth;
}

function addMarker(point, label) {
  const x = point.x * drawnWidth;
  const y = point.y * drawnHeight;
  const marker = document.createElementNS(svgNamespace, "circle");
  const text = document.createElementNS(svgNamespace, "text");
  marker.setAttribute("cx", x);
  marker.setAttribute("cy", y);
  marker.setAttribute("r", 9);
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.textContent = label;
  find("markers").append(marker, text);
}

function renderRoute() {
  const points = route.map(({ x, y }) => `${x * drawnWidth},${y * drawnHeight}`).join(" ");
  find("route-shadow").setAttribute("points", points);
  find("route-line").setAttribute("points", points);
  find("markers").replaceChildren();
  if (route.length) addMarker(route[0], "A");
  if (route.length > 1) addMarker(route.at(-1), "B");
  cursor.setAttribute("cx", keyboardPoint.x * drawnWidth);
  cursor.setAttribute("cy", keyboardPoint.y * drawnHeight);
  cursor.setAttribute("visibility", keyboardActive ? "visible" : "hidden");
}

function routeChanged() {
  find("route-status").textContent = route.length > 1 ? "Add another point to extend the route." :
    route.length ? "Add an end point." : "Add a start point.";
  renderRoute();
  updateEstimate();
  updateButtons();
}

function clearRoute() {
  finishGesture();
  route.length = 0;
  edits.length = 0;
  routeChanged();
}

function undo() {
  finishGesture();
  if (!edits.length) return;
  route.length = edits.pop();
  routeChanged();
}

function positionMap() {
  const maxLeft = viewport.clientWidth - drawnWidth;
  const maxTop = viewport.clientHeight - drawnHeight;
  left = maxLeft > 0 ? maxLeft / 2 : Math.max(maxLeft, Math.min(left, 0));
  mapTop = maxTop > 0 ? maxTop / 2 : Math.max(maxTop, Math.min(mapTop, 0));
  stage.style.transform = `translate(${left}px, ${mapTop}px)`;
}

function layoutMap(nextZoom, anchorX, anchorY) {
  if (!stage.classList.contains("ready")) return;
  const x = drawnWidth ? (anchorX - left) / drawnWidth : 0.5;
  const y = drawnHeight ? (anchorY - mapTop) / drawnHeight : 0.5;
  const imageWidth = Number(image.getAttribute("width"));
  const imageHeight = Number(image.getAttribute("height"));
  const fit = Math.min(viewport.clientWidth / imageWidth, viewport.clientHeight / imageHeight);
  zoom = Math.max(1, Math.min(nextZoom, 7));
  drawnWidth = imageWidth * fit * zoom;
  drawnHeight = imageHeight * fit * zoom;
  left = anchorX - x * drawnWidth;
  mapTop = anchorY - y * drawnHeight;
  stage.style.width = `${drawnWidth}px`;
  stage.style.height = `${drawnHeight}px`;
  overlay.setAttribute("viewBox", `0 0 ${drawnWidth} ${drawnHeight}`);
  find("zoom-fit").textContent = `${Math.round(zoom * 100)}%`;
  positionMap();
  renderRoute();
  updateButtons();
}

function centerZoom(level) {
  layoutMap(level, viewport.clientWidth / 2, viewport.clientHeight / 2);
}

function fitMap() {
  drawnWidth = 0;
  drawnHeight = 0;
  centerZoom(1);
}

function localPoint(event) {
  const bounds = viewport.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function mapPoint(point) {
  return { x: (point.x - left) / drawnWidth, y: (point.y - mapTop) / drawnHeight };
}

function inside({ x, y }) {
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function appendPoint(point, minimumPixels = 0) {
  const previous = route.at(-1);
  if (previous) {
    const gap = Math.hypot((previous.x - point.x) * drawnWidth, (previous.y - point.y) * drawnHeight);
    if (gap <= minimumPixels) return;
  }
  if (gesture && route.length === gesture.start) edits.push(gesture.start);
  route.push(point);
  routeChanged();
}

function finishGesture() {
  if (!gesture) return;
  const { id } = gesture;
  gesture = null;
  if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
}

function setMode(nextMode) {
  finishGesture();
  mode = nextMode;
  find("draw").setAttribute("aria-pressed", mode === "draw");
  find("pan").setAttribute("aria-pressed", mode === "pan");
  viewport.classList.toggle("pan", mode === "pan");
}

viewport.addEventListener("pointerdown", (event) => {
  if (!drawnWidth || event.button !== 0 || gesture) return;
  const position = localPoint(event);
  const point = mapPoint(position);
  if (mode === "draw" && !inside(point)) return;
  viewport.focus({ preventScroll: true });
  keyboardActive = false;
  gesture = { id: event.pointerId, start: route.length, position };
  viewport.setPointerCapture(event.pointerId);
  if (mode === "draw") appendPoint(point);
  renderRoute();
});

viewport.addEventListener("pointermove", (event) => {
  if (gesture?.id !== event.pointerId) return;
  const position = localPoint(event);
  if (mode === "pan") {
    left += position.x - gesture.position.x;
    mapTop += position.y - gesture.position.y;
    gesture.position = position;
    positionMap();
  } else {
    const point = mapPoint(position);
    if (inside(point)) appendPoint(point, 4);
  }
});

for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  viewport.addEventListener(eventName, (event) => {
    if (gesture?.id !== event.pointerId) return;
    if (eventName === "pointerup" && mode === "draw") {
      const point = mapPoint(localPoint(event));
      if (inside(point)) appendPoint(point, 1);
    }
    finishGesture();
  });
}

viewport.addEventListener("wheel", (event) => {
  if (!drawnWidth || gesture || document.activeElement !== viewport || event.ctrlKey) return;
  event.preventDefault();
  const { x, y } = localPoint(event);
  layoutMap(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), x, y);
}, { passive: false });

viewport.addEventListener("keydown", (event) => {
  if (!drawnWidth || gesture) return;
  const directions = { ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0] };
  if (Object.hasOwn(directions, event.key)) {
    const [dx, dy] = directions[event.key];
    keyboardActive = true;
    keyboardPoint.x = Math.max(0, Math.min(1, keyboardPoint.x + dx * 12 / drawnWidth));
    keyboardPoint.y = Math.max(0, Math.min(1, keyboardPoint.y + dy * 12 / drawnHeight));
    const x = left + keyboardPoint.x * drawnWidth;
    const y = mapTop + keyboardPoint.y * drawnHeight;
    left += Math.max(10 - x, 0) + Math.min(viewport.clientWidth - 10 - x, 0);
    mapTop += Math.max(10 - y, 0) + Math.min(viewport.clientHeight - 10 - y, 0);
    positionMap();
    renderRoute();
  } else if ((event.key === "Enter" || event.key === " ") && mode === "draw") {
    keyboardActive = true;
    const start = route.length;
    appendPoint({ ...keyboardPoint });
    if (route.length > start) edits.push(start);
    updateButtons();
    renderRoute();
  } else if (event.key === "+" || event.key === "=") {
    centerZoom(zoom * 1.5);
  } else if (event.key === "-") {
    centerZoom(zoom / 1.5);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    undo();
  } else {
    return;
  }
  event.preventDefault();
});

viewport.addEventListener("blur", () => {
  keyboardActive = false;
  renderRoute();
});

if (sdk?.maps.length && sdk.vehicles.length) {
  find("version").textContent = `SDK ${sdk.version}`;
  for (const map of sdk.maps) mapSelect.add(new Option(map.name, map.name));
  mapSelect.value = sdk.maps.some((map) => map.name === "Yehorivka") ? "Yehorivka" : sdk.maps[0].name;
  const factions = new Map();
  const vehicleLabels = new Map();
  for (const { faction, name } of sdk.vehicles) {
    const key = `${faction}/${name}`;
    vehicleLabels.set(key, (vehicleLabels.get(key) ?? 0) + 1);
  }
  sdk.vehicles.forEach((vehicle, index) => {
    if (!factions.has(vehicle.faction)) {
      const group = document.createElement("optgroup");
      group.label = vehicle.faction;
      vehicleSelect.append(group);
      factions.set(vehicle.faction, group);
    }
    const duplicate = vehicleLabels.get(`${vehicle.faction}/${vehicle.name}`) > 1;
    const label = duplicate && vehicle.type ? `${vehicle.name} · ${vehicle.type}` : vehicle.name;
    factions.get(vehicle.faction).append(new Option(label, index));
  });
  mapSelect.addEventListener("change", selectMap);
  vehicleSelect.addEventListener("change", selectVehicle);
  for (const input of [widthInput, heightInput]) {
    input.addEventListener("input", () => {
      scales.set(mapSelect.value, [widthInput.value, heightInput.value]);
      updateMapDetail();
      updateEstimate();
    });
  }
  speedInput.addEventListener("input", () => {
    speeds.set(sdk.vehicles[Number(vehicleSelect.value)].id, speedInput.value);
    updateEstimate();
  });
  find("draw").addEventListener("click", () => setMode("draw"));
  find("pan").addEventListener("click", () => setMode("pan"));
  find("undo").addEventListener("click", undo);
  find("clear").addEventListener("click", clearRoute);
  find("zoom-out").addEventListener("click", () => centerZoom(zoom / 1.5));
  find("zoom-in").addEventListener("click", () => centerZoom(zoom * 1.5));
  find("zoom-fit").addEventListener("click", fitMap);
  new ResizeObserver(() => centerZoom(zoom)).observe(viewport);
  selectVehicle();
  selectMap();
} else {
  for (const control of document.querySelectorAll("button, input, select")) control.disabled = true;
  find("map-heading").textContent = "Route map";
  mapMessage.hidden = false;
  mapMessage.textContent = "SDK data is missing. See the README to export it.";
}
