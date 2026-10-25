import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { PowerModeEngine } from "./PowerModeEngine";

// The engine draws particles on a 2D canvas, shakes an element and plays Web Audio sounds.
// happy-dom has no 2D context or Web Audio, so these fakes record what the engine draws and
// which sound graph it builds. Math.random, performance.now and animation frames are controlled
// per test.

function createFakeContext() {
  const fills: Array<{ x: number; y: number; color: string }> = [];
  const ctx = {
    fillStyle: "",
    clearRects: 0,
    transforms: [] as number[][],
    clearRect: () => void ctx.clearRects++,
    fillRect: (x: number, y: number) => void fills.push({ x, y, color: ctx.fillStyle }),
    save: () => undefined,
    restore: () => undefined,
    setTransform: (...args: number[]) => void ctx.transforms.push(args),
  };
  return { ctx, fills };
}

class FakeParam {
  value = 0;
  setValueAtTime(value: number) {
    this.value = value;
  }
  // Envelopes are not observable through the engine's API, so ramps record nothing.
  linearRampToValueAtTime = () => undefined;
  exponentialRampToValueAtTime = () => undefined;
}

class FakeNode {
  type = "";
  connectedTo: FakeNode[] = [];
  disconnected = false;
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  playbackRate = new FakeParam();
  buffer: unknown = null;
  onended: (() => void) | null = null;
  constructor(readonly kind: string) {}
  connect(node: FakeNode) {
    this.connectedTo.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
  start = () => undefined;
  stop = () => undefined;
}

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  sampleRate = 100;
  destination = new FakeNode("destination");
  nodes: FakeNode[] = [];
  buffersCreated = 0;
  resumed = 0;
  closed = 0;
  constructor() {
    FakeAudioContext.created.push(this);
  }
  private add(kind: string) {
    const node = new FakeNode(kind);
    this.nodes.push(node);
    return node;
  }
  createGain = () => this.add("gain");
  createBiquadFilter = () => this.add("filter");
  createOscillator = () => this.add("oscillator");
  createBufferSource = () => this.add("source");
  createBuffer = (_channels: number, frames: number) => {
    this.buffersCreated++;
    const data = new Float32Array(frames);
    return { length: frames, getChannelData: () => data };
  };
  resume = () => {
    this.resumed++;
    return Promise.resolve();
  };
  close = () => {
    this.closed++;
    this.state = "closed";
    return Promise.resolve();
  };
  ofKind(kind: string) {
    return this.nodes.filter((node) => node.kind === kind);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const savedGlobals = ["window", "requestAnimationFrame", "cancelAnimationFrame"].map(
  (key) => [key, globals[key]] as const
);

let happyWindow: GlobalWindow;
let random: number;
let now: number;
let frames: Map<number, (time: number) => void>;
let timers: Array<() => void>;

function runFrame(time: number): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(time);
}

function setAudioContext(constructor: unknown): void {
  Object.defineProperty(happyWindow, "AudioContext", { value: constructor, configurable: true });
}

function createCanvas(ctx: unknown): HTMLCanvasElement {
  const canvas = happyWindow.document.createElement("canvas") as unknown as HTMLCanvasElement;
  canvas.getContext = (() => ctx) as HTMLCanvasElement["getContext"];
  return canvas;
}

beforeEach(() => {
  happyWindow = new GlobalWindow();
  happyWindow.happyDOM.setViewport({ width: 400, height: 300, devicePixelRatio: 2 });
  globals.window = happyWindow;
  frames = new Map();
  let nextFrame = 1;
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  };
  globals.cancelAnimationFrame = (id: number) => frames.delete(id);
  timers = [];
  spyOn(happyWindow, "setTimeout").mockImplementation(((callback: () => void) =>
    timers.push(callback)) as unknown as typeof happyWindow.setTimeout);
  random = 0;
  now = 1000;
  spyOn(Math, "random").mockImplementation(() => random);
  spyOn(performance, "now").mockImplementation(() => now);
  FakeAudioContext.created = [];
  setAudioContext(FakeAudioContext);
});

afterEach(() => {
  mock.restore();
  happyWindow.close();
  for (const [key, value] of savedGlobals) globals[key] = value;
});

function engineWithCanvas() {
  const { ctx, fills } = createFakeContext();
  const canvas = createCanvas(ctx);
  const engine = new PowerModeEngine();
  engine.setCanvas(canvas);
  return { engine, canvas, ctx, fills };
}

describe("PowerModeEngine canvas", () => {
  test("sizes the canvas to the window in device pixels and draws in CSS pixels", () => {
    const { canvas, ctx } = engineWithCanvas();

    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect([canvas.style.width, canvas.style.height]).toEqual(["100%", "100%"]);
    expect(ctx.transforms).toEqual([[2, 0, 0, 2, 0, 0]]);
  });

  test("falls back to a 1x pixel ratio and a 1px minimum size", () => {
    happyWindow.happyDOM.setViewport({ width: 0, height: 0, devicePixelRatio: 0 });
    const { canvas, ctx } = engineWithCanvas();

    expect([canvas.width, canvas.height]).toEqual([1, 1]);
    expect(ctx.transforms).toEqual([[1, 0, 0, 1, 0, 0]]);
  });

  test("follows window resizes only while a drawable canvas is attached", () => {
    const { engine, canvas, ctx } = engineWithCanvas();
    // Setting the same canvas again does not resize it again.
    engine.setCanvas(canvas);
    expect(ctx.transforms).toHaveLength(1);

    happyWindow.happyDOM.setViewport({ width: 500, height: 100 });
    expect([canvas.width, canvas.height]).toEqual([1000, 200]);

    engine.setCanvas(null);
    happyWindow.happyDOM.setViewport({ width: 50, height: 50 });
    expect([canvas.width, canvas.height]).toEqual([1000, 200]);
  });

  test("keeps the backing store when the size did not change", () => {
    const { engine, canvas } = engineWithCanvas();
    let writes = 0;
    Object.defineProperty(canvas, "width", {
      get: () => 800,
      set: () => void writes++,
    });
    engine.setCanvas(null);
    engine.setCanvas(canvas);
    // Assigning width clears a real canvas, so an unchanged size must not be written.
    expect(writes).toBe(0);
  });

  test("ignores a canvas without a 2D context", () => {
    const canvas = createCanvas(null);
    const engine = new PowerModeEngine();
    engine.setCanvas(canvas);
    engine.burst(10, 10, 3);

    expect(canvas.style.width).toBe("");
    expect(frames.size).toBe(0);
  });
});

describe("PowerModeEngine particles", () => {
  test("spawns 5 to 15 particles per burst and draws them on the next frame", () => {
    const { engine, fills } = engineWithCanvas();
    random = 0;
    engine.burst(100, 100);
    runFrame(0);
    expect(fills).toHaveLength(5);

    const second = engineWithCanvas();
    random = 0.99;
    second.engine.burst(100, 100);
    runFrame(0);
    expect(second.fills).toHaveLength(15);
  });

  test("sends insert particles up in bright colors and delete particles down in red", () => {
    const { engine, fills } = engineWithCanvas();
    random = 0.5;
    engine.burst(100, 100, 1, { kind: "insert" });
    // The first frame only sets the clock; the second one moves the particles.
    runFrame(0);
    fills.length = 0;
    runFrame(20);
    const insertFills = fills.splice(0);
    expect(insertFills.every((fill) => fill.y < 100)).toBe(true);
    expect(insertFills.every((fill) => fill.color.endsWith(", 100%, 65%)"))).toBe(true);
    // Insert hues walk the color wheel, so each particle of a burst gets its own color.
    expect(new Set(insertFills.map((fill) => fill.color)).size).toBe(insertFills.length);

    now += 25;
    engine.stop();
    engine.burst(100, 100, 1, { kind: "delete" });
    runFrame(0);
    fills.length = 0;
    runFrame(20);
    expect(fills.length).toBeGreaterThan(0);
    // Delete hues stay in the 10-49 orange/red band.
    expect(fills.every((fill) => fill.y > 100 && fill.color === "hsl(30, 100%, 60%)")).toBe(true);
  });

  test("throttles bursts to one per 25ms", () => {
    const { engine, fills } = engineWithCanvas();
    engine.burst(0, 0);
    now += 24;
    engine.burst(0, 0);
    runFrame(0);
    expect(fills).toHaveLength(5);

    fills.length = 0;
    now += 1;
    engine.burst(0, 0);
    runFrame(10);
    expect(fills).toHaveLength(10);
  });

  test("keeps at most 500 particles", () => {
    const { engine, fills } = engineWithCanvas();
    random = 0.99;
    for (let i = 0; i < 40; i++) {
      engine.burst(0, 0);
      now += 25;
    }
    runFrame(0);
    expect(fills).toHaveLength(500);
  });

  test("stops animating and clears the canvas once every particle has expired", () => {
    const { engine, ctx } = engineWithCanvas();
    engine.burst(0, 0);
    let time = 0;
    for (let i = 0; i < 100 && frames.size > 0; i++) {
      runFrame(time);
      time += 34;
    }
    expect(frames.size).toBe(0);
    const clearsAfterExpiry = ctx.clearRects;

    // stop() cancels a pending frame.
    now += 25;
    engine.burst(0, 0);
    expect(frames.size).toBe(1);
    engine.stop();
    expect(frames.size).toBe(0);
    expect(ctx.clearRects).toBe(clearsAfterExpiry + 1);
  });
});

describe("PowerModeEngine shake", () => {
  function shakeTarget() {
    const el = happyWindow.document.createElement("div") as unknown as HTMLElement;
    const engine = new PowerModeEngine();
    engine.setShakeElement(el);
    const offset = () => Number.parseFloat(el.style.getPropertyValue("translate"));
    return { el, engine, offset };
  }

  test("offsets the element, then restores its own translate and rotate after the shake", () => {
    const { el, engine, offset } = shakeTarget();
    el.style.setProperty("translate", "5px 0px");
    random = 0.25;
    engine.burst(0, 0, 12);

    // Offset = (2 * random - 1) * (1 + 0.7 * intensity).
    expect(offset()).toBeCloseTo(-4.7);
    expect(el.style.getPropertyValue("rotate")).not.toBe("");

    // A new shake before the first one ends keeps the element's original values.
    now += 100;
    engine.burst(0, 0, 12);
    expect(timers).toHaveLength(2);
    timers[1]();
    expect(el.style.getPropertyValue("translate")).toBe("5px 0px");
    expect(el.style.getPropertyValue("rotate")).toBe("");
  });

  test("clamps the intensity to 1..12 for the shake chance and size", () => {
    const { engine, offset } = shakeTarget();
    random = 0.05;
    engine.burst(0, 0, 0);
    expect(offset()).toBeCloseTo(-0.9 * 1.7);

    now += 100;
    random = 0.3;
    engine.burst(0, 0, 100);
    expect(offset()).toBeCloseTo(-0.4 * (1 + 12 * 0.7));
  });

  test("skips shakes by chance, within 100ms of the last one, and under reduced motion", () => {
    const { el, engine } = shakeTarget();
    random = 0.1;
    // Intensity 1 has a 6% chance.
    engine.burst(0, 0, 1);
    expect(el.style.getPropertyValue("translate")).toBe("");

    engine.burst(0, 0, 5);
    timers[0]();
    now += 99;
    engine.burst(0, 0, 5);
    expect(el.style.getPropertyValue("translate")).toBe("");

    now += 1;
    spyOn(happyWindow, "matchMedia").mockReturnValue({
      matches: true,
    } as unknown as ReturnType<GlobalWindow["matchMedia"]>);
    engine.burst(0, 0, 5);
    expect(el.style.getPropertyValue("translate")).toBe("");
  });

  test("restores the previous element at once when the shake element changes", () => {
    const { el, engine } = shakeTarget();
    random = 0;
    engine.burst(0, 0, 5);
    expect(el.style.getPropertyValue("translate")).not.toBe("");

    engine.setShakeElement(null);
    expect(el.style.getPropertyValue("translate")).toBe("");
  });
});

describe("PowerModeEngine sound", () => {
  function audio(index = 0): FakeAudioContext {
    const ctx = FakeAudioContext.created[index];
    expect(ctx).toBeDefined();
    return ctx;
  }

  const filterTypes = (ctx: FakeAudioContext) => ctx.ofKind("filter").map((node) => node.type);

  test("plays a typewriter click and a gun shot through one quiet master gain", () => {
    const engine = new PowerModeEngine();
    random = 0;
    engine.burst(0, 0);

    const ctx = audio();
    const [master, ...soundGains] = ctx.ofKind("gain");
    // The master attenuates every sound; its exact level is a tuning choice.
    expect(master.gain.value).toBeGreaterThan(0);
    expect(master.gain.value).toBeLessThan(1);
    expect(master.connectedTo).toEqual([ctx.destination]);
    expect(soundGains.every((gain) => gain.connectedTo[0] === master)).toBe(true);
    expect(filterTypes(ctx)).toEqual(["highpass", "lowpass"]);
    expect(ctx.ofKind("oscillator").map((node) => node.type)).toEqual(["triangle", "square"]);
    // Both sounds share one noise buffer.
    expect(ctx.buffersCreated).toBe(1);
  });

  test("gives delete sounds their own pitch", () => {
    const engine = new PowerModeEngine();
    random = 0;
    engine.burst(0, 0, 1, { kind: "insert" });
    now += 30;
    engine.burst(0, 0, 1, { kind: "delete" });

    // Each burst plays a click (highpass) and a gun shot (lowpass). The exact cutoffs are
    // tuning choices, so only check that a delete changes both of them.
    const [insertClick, insertGun, deleteClick, deleteGun] = audio().ofKind("filter");
    expect(filterTypes(audio())).toEqual(["highpass", "lowpass", "highpass", "lowpass"]);
    expect(deleteClick.frequency.value).not.toBe(insertClick.frequency.value);
    expect(deleteGun.frequency.value).not.toBe(insertGun.frequency.value);
  });

  test("picks sounds by chance, and higher intensity makes the gun likelier", () => {
    const engine = new PowerModeEngine();
    random = 0.1;
    engine.burst(0, 0, 1);
    expect(filterTypes(audio())).toEqual(["highpass"]);

    now += 30;
    engine.burst(0, 0, 12);
    expect(filterTypes(audio())).toEqual(["highpass", "highpass", "lowpass"]);

    // The click chance also grows with intensity: 61% at intensity 1, capped at 95%.
    now += 30;
    random = 0.7;
    engine.burst(0, 0, 1);
    expect(filterTypes(audio())).toHaveLength(3);
    now += 30;
    engine.burst(0, 0, 12);
    expect(filterTypes(audio())).toEqual(["highpass", "highpass", "lowpass", "highpass"]);
    now += 30;
    random = 0.97;
    engine.burst(0, 0, 12);
    expect(filterTypes(audio())).toHaveLength(4);

    // A delete at intensity 1 has a 41% click chance and a 3% gun chance.
    now += 30;
    random = 0.5;
    engine.burst(0, 0, 1, { kind: "delete" });
    expect(filterTypes(audio())).toHaveLength(4);
  });

  test("throttles sounds to one per 30ms, counting only bursts that played", () => {
    const engine = new PowerModeEngine();
    random = 0.99;
    engine.burst(0, 0);
    expect(FakeAudioContext.created).toHaveLength(0);

    now += 1;
    random = 0;
    engine.burst(0, 0);
    const played = audio().nodes.length;
    now += 29;
    engine.burst(0, 0);
    expect(audio().nodes).toHaveLength(played);

    now += 1;
    engine.burst(0, 0);
    expect(audio().nodes).toHaveLength(played * 2 - 1);
  });

  test("resumes a suspended context and disconnects each sound when it ends", () => {
    const engine = new PowerModeEngine();
    random = 0.1;
    engine.burst(0, 0, 1);
    const ctx = audio();
    expect(ctx.resumed).toBe(0);

    const [source] = ctx.ofKind("source");
    source.onended?.();
    // The click uses a noise source, a filter, two gains and an oscillator; the master stays.
    expect(ctx.nodes.filter((node) => node.disconnected)).toHaveLength(5);
    expect(ctx.ofKind("gain")[0].disconnected).toBe(false);

    ctx.state = "suspended";
    now += 30;
    random = 0;
    // This burst plays a click and a gun shot; the gun shot cleans up its own five nodes.
    engine.burst(0, 0, 1);
    expect(ctx.resumed).toBe(2);
    const gunSource = ctx.ofKind("source")[2];
    gunSource.onended?.();
    expect(ctx.nodes.filter((node) => node.disconnected)).toHaveLength(10);
  });

  test("replaces a closed context and closes its context on stop", () => {
    const engine = new PowerModeEngine();
    random = 0;
    engine.burst(0, 0);
    audio().state = "closed";
    now += 30;
    engine.burst(0, 0);
    expect(FakeAudioContext.created).toHaveLength(2);

    engine.stop();
    expect(audio(1).closed).toBe(1);
    now += 30;
    engine.burst(0, 0);
    expect(FakeAudioContext.created).toHaveLength(3);
  });

  test("falls back to webkitAudioContext", () => {
    setAudioContext(undefined);
    Object.defineProperty(happyWindow, "webkitAudioContext", {
      value: FakeAudioContext,
      configurable: true,
    });
    random = 0;
    new PowerModeEngine().burst(0, 0);
    expect(FakeAudioContext.created).toHaveLength(1);
  });

  test("stays silent for good once Web Audio is missing or fails to start", () => {
    setAudioContext(undefined);
    const missing = new PowerModeEngine();
    random = 0;
    missing.burst(0, 0);
    setAudioContext(FakeAudioContext);
    now += 30;
    missing.burst(0, 0);
    expect(FakeAudioContext.created).toHaveLength(0);

    let attempts = 0;
    setAudioContext(
      class {
        constructor() {
          attempts++;
          throw new Error("blocked");
        }
      }
    );
    const failing = new PowerModeEngine();
    failing.burst(0, 0);
    now += 30;
    failing.burst(0, 0);
    expect(attempts).toBe(1);
  });
});
