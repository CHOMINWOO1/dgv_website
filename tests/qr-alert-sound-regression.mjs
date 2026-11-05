import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../assets/qr-staff.js", import.meta.url), "utf8");
const inbox = await readFile(new URL("../assets/order-inbox.js", import.meta.url), "utf8");
const html = await readFile(new URL("../order_inbox.html", import.meta.url), "utf8");

function fixture({ supported = true, deniedStorage = false, initialState = "suspended", canResume = true, webkit = false } = {}) {
  const contexts = [];
  const vibrations = [];
  const storage = new Map();
  const elements = [];
  const node = () => ({
    children: [], dataset: {}, textContent: "", style: {},
    appendChild(child) { this.children.push(child); },
    setAttribute() {}, addEventListener() {}, remove() {}
  });
  const stack = node();
  const document = {
    getElementById(id) { return id === "qrToastStack" ? stack : null; },
    createElement() { const value = node(); elements.push(value); return value; },
    body: node()
  };
  const param = () => ({
    events: [],
    setValueAtTime(value, time) { this.events.push({ type: "set", value, time }); },
    exponentialRampToValueAtTime(value, time) { this.events.push({ type: "ramp", value, time }); }
  });
  class AudioContext {
    constructor() {
      this.state = initialState;
      this.currentTime = 0;
      this.destination = {};
      this.oscillators = [];
      this.gains = [];
      this.resumeCount = 0;
      contexts.push(this);
    }
    async resume() { this.resumeCount += 1; if (canResume) this.state = "running"; }
    createOscillator() {
      const value = {
        frequency: param(), disconnected: false,
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
        start(time) { this.startTime = time; },
        stop(time) { this.stopTime = time; }
      };
      this.oscillators.push(value);
      return value;
    }
    createGain() {
      const value = {
        gain: param(), disconnected: false,
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; }
      };
      this.gains.push(value);
      return value;
    }
  }
  const window = {
    DGV: {}, document,
    navigator: { vibrate(pattern) { vibrations.push(Array.from(pattern)); } },
    localStorage: {
      getItem(key) { if (deniedStorage) throw new Error("Storage denied"); return storage.get(key) ?? null; },
      setItem(key, value) { if (deniedStorage) throw new Error("Storage denied"); storage.set(key, value); }
    },
    setTimeout() { return 1; }, clearTimeout() {}
  };
  if (supported) window[webkit ? "webkitAudioContext" : "AudioContext"] = AudioContext;
  vm.runInNewContext(source, { window, document, console });
  return { api: window.QRStaff, contexts, vibrations, storage, stack };
}

const test = fixture();
assert.equal(test.api.playAlert(), false, "no sound before explicit enable");
assert.equal(test.contexts.length, 0);
assert.equal(test.api.soundPreferred(), false);
assert.equal(await test.api.enableSound(), true);
assert.equal(test.api.soundPreferred(), true);
assert.equal(test.storage.get("dgv-qr-order-sound"), "enabled");
assert.equal(test.contexts.length, 1);
const audio = test.contexts[0];
assert.equal(audio.resumeCount, 1);
assert.equal(audio.oscillators.length, 4, "preview uses same four-note alert as real orders");
assert.equal(test.vibrations.length, 0, "preview must not vibrate");

for (const [index, tone] of audio.oscillators.entries()) {
  const gain = audio.gains[index];
  const envelope = gain.gain.events;
  assert.equal(tone.type, "sine");
  assert.equal(tone.target, gain);
  assert.equal(gain.target, audio.destination);
  assert.equal(envelope.length, 4);
  assert.equal(envelope[0].value, .0001);
  assert.equal(envelope[1].value, .8, "high but below clipping-level peak");
  assert.equal(envelope[2].value, .8, "sustain instead of immediately fading");
  assert.ok(envelope[2].time - envelope[1].time >= .2);
  assert.equal(envelope[3].value, .0001);
  assert.ok(Math.abs(envelope[3].time - envelope[2].time - .06) < 1e-9);
  assert.ok(envelope.every(event => event.value > 0 && event.value < 1));
  if (index) assert.ok(tone.startTime > audio.oscillators[index - 1].stopTime, "notes must not overlap");
  tone.onended();
  assert.equal(tone.disconnected, true);
  assert.equal(gain.disconnected, true);
}
assert.ok(audio.oscillators.at(-1).stopTime >= 1.7);
assert.ok(audio.oscillators.at(-1).stopTime < 2);

assert.equal(test.api.playAlert(), false, "bursty Realtime/attention calls cannot stack loud sounds");
assert.equal(await test.api.enableSound(), true, "a double click still leaves sound enabled");
assert.equal(audio.oscillators.length, 4, "double-click preview cannot stack");
audio.currentTime = 2;
assert.equal(test.api.playAlert(), true);
assert.equal(audio.oscillators.length, 8);
assert.deepEqual(test.vibrations, [[180, 80, 180]]);
audio.currentTime = 4;
audio.state = "suspended";
assert.equal(test.api.playAlert(), false);
assert.equal(audio.oscillators.length, 8, "suspended context schedules nothing");
audio.state = "running";
assert.equal(test.api.playAlert(), true, "suspended call does not consume a future alert window");
assert.equal(audio.oscillators.length, 12);
audio.state = "closed";
assert.equal(test.api.playAlert(), false);
assert.equal(await test.api.enableSound(), true, "closed context can be recreated by user gesture");
assert.equal(test.contexts.length, 2);
assert.equal(test.contexts[1].oscillators.length, 4, "recreated context resets busy window");

const denied = fixture({ deniedStorage: true, webkit: true });
assert.equal(denied.api.soundPreferred(), false);
assert.equal(await denied.api.enableSound(), true, "storage denial and webkit fallback remain supported");
assert.equal(denied.contexts[0].oscillators.length, 4);
const unsupported = fixture({ supported: false });
assert.equal(await unsupported.api.enableSound(), false);
assert.match(unsupported.stack.children[0].textContent, /이 브라우저에서는 알림음을 사용할 수 없습니다/);
const blocked = fixture({ canResume: false });
assert.equal(await blocked.api.enableSound(), false);
assert.equal(blocked.contexts[0].oscillators.length, 0);
assert.equal(blocked.api.soundPreferred(), false);

assert.match(html, /assets\/qr-staff\.js\?v=20261105-loud-alert-1/);
assert.match(inbox, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible" && orders\.some\(\(order\) => order\.status === "submitted"\)\) \{\s*ui\.playAlert\(\);\s*\}\s*\}, 9000\)/);
assert.match(inbox, /soundBtn[\s\S]*?ui\.enableSound\(\)/);
console.log("QR louder alert sound regression checks passed.");
