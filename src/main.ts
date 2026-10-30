// main.ts
// Phase 3: camera + hand tracking + gesture engine + the audio looper.
// A held gesture becomes a command (gestureEngine), the command goes to the looper
// (audio/looper.ts), and this file shows what is happening on screen.

import { DrawingUtils } from "@mediapipe/tasks-vision";
import { HandTracker, type HandReading, type HandSide } from "./handTracker";
import { GestureEngine, type HandStatus, type IntentEvent } from "./gestureEngine";
import { BINDINGS, type Intent } from "./config";
import { AudioEngine } from "./audio/audioEngine";
import { Looper, type BarsSetting, type LayerInfo, type LooperSnapshot, type LooperState } from "./audio/looper";
import { MAX_VOLUME } from "./audio/mix";
import { buildSessionZip, parseSessionZip } from "./session/session";
import { clearAutosave, loadAutosave, saveAutosave, type AutosaveRecord } from "./session/autosave";

// MediaPipe's left/right labels depend on mirroring. For your setup, false is correct.
// true = swap the labels, false = trust them. Flip it if left and right look reversed.
const SWAP_HANDEDNESS = false;

// Friendly names for the gestures MediaPipe knows.
const GESTURE_NAMES: Record<string, string> = {
  Victory: "Victory",
  Closed_Fist: "Fist",
  Open_Palm: "Open palm",
  Thumb_Up: "Thumbs up",
  Thumb_Down: "Thumbs down",
  Pointing_Up: "Pointing up",
  ILoveYou: "I love you",
  None: "-",
};

function gestureName(raw: string): string {
  return GESTURE_NAMES[raw] ?? raw;
}

// Small helper: find an element or fail loudly (helps catch typos in the HTML ids).
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const video = el<HTMLVideoElement>("video");
const canvas = el<HTMLCanvasElement>("overlay");
const startButton = el<HTMLButtonElement>("start");
const statusText = el<HTMLDivElement>("status");
const fpsText = el<HTMLDivElement>("fps");
const toast = el<HTMLDivElement>("toast");
const logList = el<HTMLOListElement>("log");
const logEmpty = el<HTMLDivElement>("log-empty");

const hud: Record<HandSide, { gesture: HTMLElement; conf: HTMLElement; ring: HTMLElement; action: HTMLElement }> = {
  Left: { gesture: el("left-gesture"), conf: el("left-conf"), ring: el("left-ring"), action: el("left-action") },
  Right: { gesture: el("right-gesture"), conf: el("right-conf"), ring: el("right-ring"), action: el("right-action") },
};

// Looper panel
const looperState = el<HTMLDivElement>("looper-state");
const looperDetail = el<HTMLDivElement>("looper-detail");
const timeline = el<HTMLDivElement>("timeline");
const timelineFill = el<HTMLDivElement>("tl-fill");
const timelineHead = el<HTMLDivElement>("tl-head");
const micLevel = el<HTMLDivElement>("mic-level");
const micName = el<HTMLDivElement>("mic-name");

// Settings panel
const bpmInput = el<HTMLInputElement>("bpm");
const tapButton = el<HTMLButtonElement>("tap");
const barsSelect = el<HTMLSelectElement>("bars");
const metronomeBox = el<HTMLInputElement>("metronome");
const clickAlways = el<HTMLInputElement>("click-always");
const trimInput = el<HTMLInputElement>("trim");
const trimValue = el<HTMLSpanElement>("trim-val");
const latencyInfo = el<HTMLDivElement>("latency-info");
const lockInfo = el<HTMLDivElement>("lock-info");

// Layers panel
const layersBox = el<HTMLDivElement>("layers");
const layersEmpty = el<HTMLDivElement>("layers-empty");
const layersHelp = el<HTMLDivElement>("layers-help");
const saveButton = el<HTMLButtonElement>("save-session");
const loadButton = el<HTMLButtonElement>("load-session");
const loadFile = el<HTMLInputElement>("load-file");
const restoreButton = el<HTMLButtonElement>("restore-autosave");
const forgetButton = el<HTMLButtonElement>("forget-autosave");
const sessionInfo = el<HTMLDivElement>("session-info");
const autosaveInfo = el<HTMLDivElement>("autosave-info");

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("Canvas is not supported in this browser");
const drawing = new DrawingUtils(ctx);

let tracker: HandTracker | null = null;
let looper: Looper | null = null;
let lastVideoTime = -1;

// For the FPS counter.
let frames = 0;
let fpsWindowStart = performance.now();

// ---------------------------------------------------------------------------
// Settings (remembered between visits)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "gesture-looper-settings";

interface Settings {
  bpm: number;
  bars: string; // "1", "2", "4", "8" or "auto"
  metronome: boolean; // master switch: off = no click at all
  clickAlways: boolean;
  trimMs: number;
}

const settings: Settings = { bpm: 100, bars: "2", metronome: true, clickAlways: false, trimMs: 0 };

function loadSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    if (typeof saved.bpm === "number") settings.bpm = saved.bpm;
    if (typeof saved.bars === "string") settings.bars = saved.bars;
    if (typeof saved.metronome === "boolean") settings.metronome = saved.metronome;
    if (typeof saved.clickAlways === "boolean") settings.clickAlways = saved.clickAlways;
    if (typeof saved.trimMs === "number") settings.trimMs = saved.trimMs;
  } catch {
    // storage unavailable: just use the defaults
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

function barsFromString(value: string): BarsSetting {
  return value === "auto" ? "auto" : Number(value);
}

/** Copies the settings onto the screen controls and, if audio is running, into the looper. */
function applySettings(): void {
  bpmInput.value = String(settings.bpm);
  barsSelect.value = settings.bars;
  metronomeBox.checked = settings.metronome;
  clickAlways.checked = settings.clickAlways;
  clickAlways.disabled = !settings.metronome; // "during playback" means nothing when the click is off
  trimInput.value = String(settings.trimMs);
  trimValue.textContent = `${settings.trimMs} ms`;
  if (looper) {
    looper.setBpm(settings.bpm);
    looper.setBars(barsFromString(settings.bars));
    looper.setMetronome(settings.metronome);
    looper.setMetronomeAlways(settings.clickAlways);
    looper.setTrimMs(settings.trimMs);
  }
}

function setBpm(bpm: number): void {
  const clamped = Math.min(200, Math.max(40, Math.round(bpm)));
  if (looper && !looper.setBpm(clamped)) {
    bpmInput.value = String(settings.bpm); // locked: put the old value back
    return;
  }
  settings.bpm = clamped;
  bpmInput.value = String(clamped);
  saveSettings();
}

bpmInput.addEventListener("change", () => {
  const value = Number(bpmInput.value);
  setBpm(Number.isFinite(value) ? value : settings.bpm);
  bpmInput.blur(); // give the keyboard back to the page so the R/S/U/C/M shortcuts work
});

// Tap tempo: tap a few times in rhythm and the average gap sets the BPM.
let taps: number[] = [];
tapButton.addEventListener("click", () => {
  const now = performance.now();
  if (taps.length > 0 && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 2) {
    const averageGap = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / averageGap);
  }
});

barsSelect.addEventListener("change", () => {
  if (looper && !looper.setBars(barsFromString(barsSelect.value))) {
    barsSelect.value = settings.bars;
    return;
  }
  settings.bars = barsSelect.value;
  saveSettings();
  barsSelect.blur(); // give the keyboard back to the page so the R/S/U/C/M shortcuts work
});

/** Turns the metronome on or off from the checkbox or the M key. */
function setMetronome(on: boolean): void {
  settings.metronome = on;
  metronomeBox.checked = on;
  clickAlways.disabled = !on;
  looper?.setMetronome(on);
  saveSettings();
}

metronomeBox.addEventListener("change", () => setMetronome(metronomeBox.checked));

clickAlways.addEventListener("change", () => {
  settings.clickAlways = clickAlways.checked;
  looper?.setMetronomeAlways(settings.clickAlways);
  saveSettings();
});

trimInput.addEventListener("input", () => {
  settings.trimMs = Number(trimInput.value);
  trimValue.textContent = `${settings.trimMs} ms`;
  looper?.setTrimMs(settings.trimMs);
  saveSettings();
});

// ---------------------------------------------------------------------------
// Commands: from gestures (or keyboard) to the looper
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;

/** Flashes a short message on the camera picture. */
function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 1500);
}

function runIntent(event: IntentEvent): void {
  const message = looper ? looper.handleIntent(event.intent) : "Audio is not ready";
  console.log("INTENT", event.intent, message);

  showToast(message);

  // Add to the log (newest first, keep the last 8).
  const item = document.createElement("li");
  const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.textContent = `${clock}  ${event.label}: ${message}`;
  logList.prepend(item);
  while (logList.children.length > 8) logList.lastElementChild?.remove();
  logEmpty.hidden = true;
}

const engine = new GestureEngine(runIntent);

// Keyboard backup, handy for testing the sound without the camera.
const KEY_INTENTS: Record<string, { intent: Intent; label: string }> = {
  r: { intent: "RECORD_TOGGLE", label: "Key R" },
  s: { intent: "STOP", label: "Key S" },
  u: { intent: "UNDO", label: "Key U" },
  c: { intent: "CLEAR_ALL", label: "Key C" },
};

document.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.matches("input[type=number], select, textarea")) return;

  // Number keys: 1-9 mute that layer, Shift + number solos it.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    if (!looper) return;
    const n = Number(digit[1]);
    showToast(e.shiftKey ? looper.toggleSoloAt(n) : looper.toggleMuteAt(n));
    return;
  }

  if (e.key.toLowerCase() === "m") {
    setMetronome(!settings.metronome);
    showToast(settings.metronome ? "Metronome on" : "Metronome off");
    return;
  }
  const key = KEY_INTENTS[e.key.toLowerCase()];
  if (key) runIntent({ intent: key.intent, hand: "Left", label: key.label, timeMs: performance.now() });
});

// Fill the "Gesture map" cheat sheet straight from the config, so it is always accurate.
function renderBindings(): void {
  const list = el<HTMLUListElement>("bindings");
  for (const b of BINDINGS) {
    const item = document.createElement("li");
    const seconds = (b.holdMs / 1000).toFixed(1);
    item.textContent = `${b.hand} ${gestureName(b.gesture)}  →  ${b.label}  (hold ${seconds}s)`;
    list.appendChild(item);
  }
}
renderBindings();

// ---------------------------------------------------------------------------
// Layers panel: one row per recorded layer
// ---------------------------------------------------------------------------

interface LayerRow {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  key: HTMLSpanElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  slider: HTMLInputElement;
  head: HTMLDivElement;
}

const layerRows = new Map<number, LayerRow>();
let shownVersion = -1;

function drawPeaks(canvasEl: HTMLCanvasElement, peaks: Float32Array): void {
  const w = (canvasEl.width = 480);
  const h = (canvasEl.height = 72);
  const c = canvasEl.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, w, h);
  c.fillStyle = "#b69cff";
  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const barH = Math.max(2, Math.min(1, peaks[i] * 1.6) * h);
    c.fillRect(i * barW, (h - barH) / 2, Math.max(1, barW - 1), barH);
  }
}

function makeLayerRow(info: LayerInfo): LayerRow {
  const root = document.createElement("div");
  root.className = "layer";

  const key = document.createElement("span");
  key.className = "lkey";
  const name = document.createElement("span");
  name.className = "lname";

  const wave = document.createElement("div");
  wave.className = "wave";
  const waveCanvas = document.createElement("canvas");
  drawPeaks(waveCanvas, info.peaks);
  const head = document.createElement("div");
  head.className = "lhead";
  wave.append(waveCanvas, head);

  const mute = document.createElement("button");
  mute.type = "button";
  mute.textContent = "M";
  mute.title = "Mute (number key)";
  mute.addEventListener("click", () => {
    if (looper) showToast(looper.toggleMute(info.id));
    mute.blur();
  });

  const solo = document.createElement("button");
  solo.type = "button";
  solo.textContent = "S";
  solo.title = "Solo (Shift + number key)";
  solo.addEventListener("click", () => {
    if (looper) showToast(looper.toggleSolo(info.id));
    solo.blur();
  });

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(MAX_VOLUME);
  slider.step = "0.01";
  slider.title = "Volume";
  slider.addEventListener("input", () => looper?.setLayerVolume(info.id, Number(slider.value)));
  slider.addEventListener("change", () => slider.blur());

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "\u2715";
  del.title = "Delete this layer";
  del.addEventListener("click", () => {
    if (looper) showToast(looper.removeLayer(info.id));
  });

  root.append(key, name, wave, mute, solo, slider, del);
  return { root, name, key, mute, solo, slider, head };
}

/** Brings the rows in line with the looper's layers (adds, updates and removes as needed). */
function syncLayerRows(infos: LayerInfo[]): void {
  const present = new Set(infos.map((i) => i.id));
  for (const [id, row] of layerRows) {
    if (!present.has(id)) {
      row.root.remove();
      layerRows.delete(id);
    }
  }
  const anySolo = infos.some((i) => i.solo);
  infos.forEach((info, index) => {
    let row = layerRows.get(info.id);
    if (!row) {
      row = makeLayerRow(info);
      layerRows.set(info.id, row);
    }
    if (layersBox.children[index] !== row.root) layersBox.insertBefore(row.root, layersBox.children[index] ?? null);
    row.key.textContent = index < 9 ? String(index + 1) : "";
    row.name.textContent = info.name;
    row.mute.classList.toggle("on-mute", info.muted);
    row.solo.classList.toggle("on-solo", info.solo);
    row.root.classList.toggle("dimmed", info.muted || (anySolo && !info.solo));
    if (document.activeElement !== row.slider) row.slider.value = String(info.volume);
  });
  layersEmpty.hidden = infos.length > 0;
  layersHelp.hidden = infos.length === 0;
  saveButton.disabled = infos.length === 0;
}

// ---------------------------------------------------------------------------
// Saving, loading and autosave
// ---------------------------------------------------------------------------

function setSessionInfo(message: string): void {
  sessionInfo.textContent = message;
}

function stamp(when: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
}

saveButton.addEventListener("click", () => {
  saveButton.blur();
  const data = looper?.exportState();
  if (!data) {
    setSessionInfo("Nothing to save yet.");
    return;
  }
  const now = new Date();
  const zip = buildSessionZip(data, now);
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `gesture-looper-${stamp(now)}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  setSessionInfo(`Saved ${link.download} (${(zip.length / 1048576).toFixed(1)} MB). Check your Downloads folder.`);
  showToast("Session saved");
});

/** Replacing a running session needs a second click, so nothing is lost by accident. */
function confirmReplace(button: HTMLButtonElement, normalLabel: string): boolean {
  if (!looper || looper.snapshot().layers === 0) return true;
  if (button.classList.contains("armed")) {
    button.classList.remove("armed");
    button.textContent = normalLabel;
    return true;
  }
  button.classList.add("armed");
  button.textContent = "Click again to replace";
  setSessionInfo("This replaces your current layers. Click again to continue.");
  window.setTimeout(() => {
    button.classList.remove("armed");
    button.textContent = normalLabel;
  }, 4000);
  return false;
}

async function applyImport(data: Awaited<ReturnType<typeof parseSessionZip>>, label: string): Promise<void> {
  if (!looper) return;
  const result = await looper.importState(data);
  settings.bpm = Math.round(result.bpm);
  settings.bars = String(result.barsSetting);
  applySettings();
  saveSettings();
  setSessionInfo(`${label}: ${plural(data.layers.length, "layer")}, ${data.bars} ${data.bars === 1 ? "bar" : "bars"} at ${settings.bpm} BPM.`);
  showToast(label);
}

loadButton.addEventListener("click", () => {
  loadButton.blur();
  if (!looper) {
    setSessionInfo("Start the camera and microphone first.");
    return;
  }
  if (confirmReplace(loadButton, "Load session")) loadFile.click();
});

loadFile.addEventListener("change", async () => {
  const file = loadFile.files?.[0];
  loadFile.value = ""; // so choosing the same file again still triggers
  if (!file) return;
  try {
    const data = await parseSessionZip(new Uint8Array(await file.arrayBuffer()));
    await applyImport(data, "Session loaded");
  } catch (err) {
    console.error(err);
    setSessionInfo(`Could not load that file: ${(err as Error).message}`);
  }
});

let autosaveRecord: AutosaveRecord | null = null;
let autosaveTimer: number | undefined;

async function refreshAutosaveInfo(): Promise<void> {
  autosaveRecord = await loadAutosave();
  const ready = looper !== null && autosaveRecord !== null;
  restoreButton.disabled = !ready;
  forgetButton.disabled = autosaveRecord === null;
  if (autosaveRecord) {
    const at = new Date(autosaveRecord.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = new Date(autosaveRecord.savedAt).toLocaleDateString();
    autosaveInfo.textContent = `Autosave: ${plural(autosaveRecord.data.layers.length, "layer")}, saved ${day} ${at}.`;
  } else {
    autosaveInfo.textContent = "Autosave: nothing stored yet. It saves by itself while you work.";
  }
}

/** Called after every layer change. Waits a moment so a moving slider is not saved 100 times. */
function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void runAutosave(), 1500);
}

async function runAutosave(): Promise<void> {
  autosaveTimer = undefined;
  const data = looper?.exportState();
  if (!data) return; // empty: keep the last real session, so an accidental "Clear all" can be undone
  await saveAutosave(data);
  await refreshAutosaveInfo();
}

window.addEventListener("pagehide", () => {
  if (autosaveTimer !== undefined) {
    window.clearTimeout(autosaveTimer);
    void runAutosave();
  }
});

restoreButton.addEventListener("click", async () => {
  restoreButton.blur();
  if (!autosaveRecord || !confirmReplace(restoreButton, "Restore autosave")) return;
  try {
    await applyImport(autosaveRecord.data, "Autosave restored");
  } catch (err) {
    console.error(err);
    setSessionInfo(`Could not restore: ${(err as Error).message}`);
  }
});

forgetButton.addEventListener("click", async () => {
  forgetButton.blur();
  await clearAutosave();
  await refreshAutosaveInfo();
  setSessionInfo("Autosave deleted.");
});

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/** Sets up sound and the microphone. Never throws: hands still work if the mic is blocked. */
async function initAudio(audioCtx: AudioContext): Promise<void> {
  try {
    const audio = await AudioEngine.create(audioCtx);
    looper = new Looper(audio);
    looper.onChange = scheduleAutosave;
    applySettings();
    void refreshAutosaveInfo();
    micName.textContent = `Microphone: ${audio.micLabel || "default"}`;
  } catch (err) {
    console.error(err);
    micName.textContent = `Microphone unavailable: ${(err as Error).message}`;
    looperState.textContent = "No audio";
  }
}

async function start(): Promise<void> {
  startButton.disabled = true;

  try {
    // The sound system must be created straight from the click, or the browser keeps it muted.
    const audioCtx = new AudioContext({ latencyHint: "interactive" });
    void audioCtx.resume();

    statusText.textContent = "Loading hand model and microphone...";
    const audioReady = initAudio(audioCtx);
    tracker = await HandTracker.create();
    await audioReady;

    statusText.textContent = "Waiting for camera permission...";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: false, // the microphone is opened separately by the audio engine
    });
    video.srcObject = stream;
    await video.play();

    // Make the drawing canvas the same size as the camera picture.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    statusText.textContent = "Show your hands to the camera";
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    statusText.textContent = `Could not start: ${(err as Error).message}`;
    startButton.disabled = false;
  }
}

// Runs once per screen refresh (about 60 times per second).
function loop(): void {
  if (tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    // Only analyse when the camera has produced a genuinely new frame.
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const hands = tracker.detect(video, now, SWAP_HANDEDNESS);
    const statuses = engine.update(hands, now);
    render(hands, statuses);
    countFrame();
  }
  updateLooperUI();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Drawing the screen
// ---------------------------------------------------------------------------

function describe(status: HandStatus): string {
  switch (status.state) {
    case "charging":
      return `Holding: ${status.binding?.label ?? ""}`;
    case "fired":
      return `Done: ${status.binding?.label ?? ""}`;
    case "waiting":
      return status.progress > 0 ? "Release the gesture to re-arm" : "Re-arming...";
    default:
      return "";
  }
}

function render(hands: HandReading[], statuses: Record<HandSide, HandStatus>): void {
  // 1. Draw the skeletons over the camera picture.
  ctx!.clearRect(0, 0, canvas.width, canvas.height);
  for (const hand of hands) {
    const color = hand.side === "Left" ? "#ffb86b" : "#7fd6ff";
    drawing.drawConnectors(hand.landmarks, HandTracker.CONNECTIONS, {
      color,
      lineWidth: 4,
    });
    drawing.drawLandmarks(hand.landmarks, { color: "#ffffff", lineWidth: 1, radius: 3 });
  }

  // 2. Update the text panels and progress rings. A hand that is not visible shows a dash.
  for (const side of ["Left", "Right"] as const) {
    const hand = hands.find((h) => h.side === side);
    const status = statuses[side];

    if (hand) {
      hud[side].gesture.textContent = gestureName(hand.gesture);
      hud[side].conf.textContent = `confidence ${(hand.confidence * 100).toFixed(0)}%`;
    } else {
      hud[side].gesture.textContent = "-";
      hud[side].conf.textContent = "not visible";
    }

    hud[side].ring.style.setProperty("--p", `${Math.round(status.progress * 100)}%`);
    hud[side].ring.classList.toggle("done", status.state === "waiting" && status.progress > 0);
    hud[side].action.textContent = describe(status);
  }
}

const STATE_TITLES: Record<LooperState, string> = {
  idle: "Ready",
  countIn: "Count-in",
  recording: "Recording",
  playing: "Playing",
  stopped: "Stopped",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function detailText(s: LooperSnapshot): string {
  switch (s.state) {
    case "idle": {
      const length = s.barsSetting === "auto" ? "free-length" : plural(s.barsSetting, "bar");
      return `Hold Victory to record a ${length} loop at ${Math.round(s.bpm)} BPM`;
    }
    case "countIn":
      return `Recording starts in ${plural(s.beatsToStart ?? 0, "beat")}`;
    case "recording": {
      const bar = s.recBar ?? 1;
      if (s.loopBars === null) return `Bar ${bar}: Victory again closes the loop at the end of the bar`;
      return `Bar ${Math.min(bar, s.loopBars)} of ${s.loopBars}: Victory again ends the take early`;
    }
    case "playing":
      return `${plural(s.layers, "layer")} playing, ${plural(s.loopBars ?? 0, "bar")} at ${Math.round(s.bpm)} BPM. Victory adds a layer`;
    case "stopped":
      return `${plural(s.layers, "layer")} kept. Fist resumes, Victory adds a layer`;
  }
}

let shownLevel = 0;

function updateLooperUI(): void {
  if (!looper) return;
  const s = looper.snapshot();

  looperState.textContent = s.state === "countIn" && s.beatsToStart ? `Count-in: ${s.beatsToStart}` : STATE_TITLES[s.state];
  looperDetail.textContent = detailText(s);

  // Timeline: playhead position, bar lines, colour by state.
  timeline.style.setProperty("--bars", String(s.loopBars ?? 1));
  timeline.classList.toggle("recording", s.state === "recording");
  timeline.classList.toggle("playing", s.state === "playing");
  timeline.classList.toggle("active", s.playhead !== null);
  const percent = (s.playhead ?? 0) * 100;
  timelineFill.style.width = `${percent}%`;
  timelineHead.style.left = `${percent}%`;

  // Microphone level (decibel scale, falls back smoothly).
  shownLevel = Math.max(s.micLevel, shownLevel * 0.88);
  const db = 20 * Math.log10(Math.max(shownLevel, 1e-4));
  micLevel.style.width = `${Math.min(100, Math.max(0, ((db + 60) / 60) * 100))}%`;

  // Layer rows (rebuilt only when something changed) and their playheads.
  if (s.layersVersion !== shownVersion) {
    shownVersion = s.layersVersion;
    syncLayerRows(looper.getLayerInfos());
  }
  for (const row of layerRows.values()) row.head.style.left = `${percent}%`;

  // Settings that cannot change while a loop exists.
  bpmInput.disabled = s.locked;
  barsSelect.disabled = s.locked;
  lockInfo.hidden = !s.locked;
  latencyInfo.textContent = `Estimated latency: ${Math.round(s.latencyMs)} ms. If your voice lands early or late against the click, nudge the trim.`;
}

function countFrame(): void {
  frames++;
  const now = performance.now();
  if (now - fpsWindowStart >= 1000) {
    fpsText.textContent = String(Math.round((frames * 1000) / (now - fpsWindowStart)));
    frames = 0;
    fpsWindowStart = now;
  }
}

loadSettings();
applySettings();
void refreshAutosaveInfo(); // show what is stored right away, even before the microphone starts
startButton.addEventListener("click", start);
