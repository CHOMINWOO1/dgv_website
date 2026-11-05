import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../assets/qr-staff.js", import.meta.url), "utf8");
const inbox = await readFile(new URL("../assets/order-inbox.js", import.meta.url), "utf8");
const html = await readFile(new URL("../order_inbox.html", import.meta.url), "utf8");

function fixture({ supported = true, deniedStorage = false, initialState = "suspended", canResume = true, webkit = false, hasSpeech = false, voices = [{ lang: "vi-VN", name: "Vietnamese" }] } = {}) {
  const contexts = [];
  const vibrations = [];
  const storage = new Map();
  const elements = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 1;
  let signedOut = 0;
  let reloaded = 0;
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
        stop(time) { this.stopTime = time; this.stopCalls = (this.stopCalls || 0) + 1; }
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
  const speech = {
    voices, utterances: [], speaking: false, pending: false, cancelCount: 0,
    throwGetVoices: false, throwSpeak: false,
    getVoices() { if (this.throwGetVoices) throw new Error("Voice unavailable"); return this.voices; },
    speak(utterance) { if (this.throwSpeak) throw new Error("Speech unavailable"); this.utterances.push(utterance); this.speaking = true; },
    cancel() { this.cancelCount += 1; this.speaking = false; this.pending = false; this.utterances.at(-1)?.onerror?.({ error: "canceled" }); },
    finish(error) { this.speaking = false; const utterance = this.utterances.at(-1); if (error) utterance?.onerror?.({ error }); else utterance?.onend?.(); }
  };
  const window = {
    DGV: { async signOut() { signedOut += 1; } }, document,
    location: { reload() { reloaded += 1; } },
    navigator: { vibrate(pattern) { vibrations.push(Array.from(pattern)); } },
    localStorage: {
      getItem(key) { if (deniedStorage) throw new Error("Storage denied"); return storage.get(key) ?? null; },
      setItem(key, value) { if (deniedStorage) throw new Error("Storage denied"); storage.set(key, value); }
    },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  if (hasSpeech) {
    window.speechSynthesis = speech;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  }
  if (supported) window[webkit ? "webkitAudioContext" : "AudioContext"] = AudioContext;
  vm.runInNewContext(source, { window, document, console });
  function advance(milliseconds) {
    const target = clock + milliseconds;
    const move = time => {
      contexts.forEach(context => { if (context.state === "running") context.currentTime += (time - clock) / 1000; });
      clock = time;
    };
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      move(next[1].due);
      timers.delete(next[0]);
      next[1].callback();
    }
    move(target);
  }
  return { api: window.QRStaff, contexts, vibrations, storage, stack, speech, advance, get signedOut() { return signedOut; }, get reloaded() { return reloaded; } };
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
  assert.equal(envelope[1].value, .95, "higher but below clipping-level peak");
  assert.equal(envelope[2].value, .95, "sustain instead of immediately fading");
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
test.advance(2000);
assert.equal(test.api.playAlert(), true);
assert.equal(audio.oscillators.length, 8);
assert.deepEqual(test.vibrations, [[180, 80, 180]]);
test.advance(2000);
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

// Vietnamese speech follows the tone, at maximum supported speech volume.
const spoken = fixture({ hasSpeech: true, voices: [{ lang: "en-US", name: "English" }, { lang: "vi-VN", name: "Vietnamese" }] });
assert.equal(await spoken.api.enableSound(), true);
assert.equal(spoken.speech.utterances.length, 0);
spoken.advance(1849);
assert.equal(spoken.speech.utterances.length, 0, "speech must wait until the chime has ended");
spoken.advance(1);
assert.equal(spoken.speech.utterances.length, 1);
const firstVoice = spoken.speech.utterances[0];
assert.equal(firstVoice.text, "Có đơn hàng mới. Vui lòng xác nhận.");
assert.equal(firstVoice.voice.name, "Vietnamese");
assert.equal(firstVoice.lang, "vi-VN");
assert.equal(firstVoice.volume, 1);
assert.equal(firstVoice.rate, 1);
assert.equal(firstVoice.pitch, 1);
assert.equal(spoken.api.playAlert(), false, "one pending/speaking announcement only");
assert.equal(await spoken.api.enableSound(), true);
assert.equal(spoken.speech.utterances.length, 1, "preview double click does not create a speech queue");
spoken.speech.finish();
assert.equal(spoken.api.playAlert(), true, "speech end releases the notification lock");

// Preview survives a no-order render; real-order alerts stop when acknowledged.
const preview = fixture({ hasSpeech: true });
await preview.api.enableSound();
preview.api.stopAlert();
preview.advance(1850);
assert.equal(preview.speech.utterances.length, 1, "explicit preview survives normal stop");
preview.api.stopAlert();
assert.equal(preview.speech.cancelCount, 0, "normal empty-order render preserves active preview");
preview.api.stopAlert({ force: true });
assert.equal(preview.speech.cancelCount, 1);
assert.equal(preview.api.playAlert(), true);
preview.api.stopAlert();
preview.advance(2000);
assert.equal(preview.speech.utterances.length, 1, "acknowledgement cancels delayed real-order voice");
assert.equal(preview.api.playAlert(), true);
preview.advance(1850);
assert.equal(preview.speech.utterances.length, 2);
preview.api.stopAlert();
assert.equal(preview.speech.cancelCount, 2, "acknowledgement cancels active real-order voice");
assert.ok(preview.contexts[0].oscillators.every(tone => tone.stopCalls >= 2), "stop also stops scheduled tones");
preview.advance(9000);
assert.equal(preview.speech.utterances.length, 2, "no stale timers speak after cancellation");

// Lazy voice lists are queried again when speech is due and on future alerts.
const lazy = fixture({ hasSpeech: true, voices: [] });
await lazy.api.enableSound();
lazy.speech.voices = [{ lang: "vi_VN", name: "Loaded Vietnamese" }];
lazy.advance(1850);
assert.equal(lazy.speech.utterances[0].voice.name, "Loaded Vietnamese");
const noVi = fixture({ hasSpeech: true, voices: [{ lang: "en-US", name: "English" }] });
await noVi.api.enableSound();
noVi.advance(1850);
assert.equal(noVi.speech.utterances.length, 0, "must not use a wrong-language voice");
assert.match(noVi.stack.children[0].textContent, /베트남어 음성을 사용할 수 없어/);
noVi.speech.voices = [{ lang: "vi", name: "Newly installed Vietnamese" }];
assert.equal(noVi.api.playAlert(), true);
noVi.advance(1850);
assert.equal(noVi.speech.utterances.length, 1, "later alerts can use newly available voices");

// Speech failure never disables tones, and a stuck utterance times out before 9s.
const stuck = fixture({ hasSpeech: true });
await stuck.api.enableSound();
stuck.advance(7849);
assert.equal(stuck.speech.cancelCount, 0);
stuck.advance(1);
assert.equal(stuck.speech.cancelCount, 1);
assert.equal(stuck.api.playAlert(), true, "watchdog releases stuck speech");
const failing = fixture({ hasSpeech: true });
failing.speech.throwSpeak = true;
await failing.api.enableSound();
failing.advance(1850);
assert.equal(failing.contexts[0].oscillators.length, 4);
assert.equal(failing.api.playAlert(), true, "synchronous speech exception does not lock future tones");
failing.speech.throwSpeak = false;
failing.advance(1850);
assert.equal(failing.speech.utterances.length, 1);
failing.speech.finish("language-unavailable");
assert.equal(failing.api.playAlert(), true, "asynchronous speech error releases future alerts");
const unavailable = fixture({ hasSpeech: true });
unavailable.speech.throwGetVoices = true;
assert.equal(await unavailable.api.enableSound(), true);
unavailable.advance(1850);
assert.equal(unavailable.api.playAlert(), true, "voice enumeration exception does not disable alerts");
const busy = fixture({ hasSpeech: true });
busy.speech.speaking = true;
await busy.api.enableSound();
busy.advance(1850);
assert.equal(busy.speech.utterances.length, 0, "do not queue over another speech owner");
busy.api.stopAlert({ force: true });
assert.equal(busy.speech.cancelCount, 0, "do not cancel speech not owned by this helper");

const logout = fixture({ hasSpeech: true });
await logout.api.enableSound();
logout.advance(1850);
await logout.api.signOut();
assert.equal(logout.speech.cancelCount, 1, "logout force-cancels even a preview");
assert.equal(logout.signedOut, 1);
assert.equal(logout.reloaded, 1);

// Filtering the screen must not silence a still-unacknowledged order.
const renderSource = inbox.match(/^  function renderOrders\(\) \{[\s\S]*?^  \}/m)?.[0];
assert.ok(renderSource);
let normalStops = 0;
const renderContext = {
  orders: [{ status: "submitted" }],
  ui: { stopAlert() { normalStops += 1; }, byId(id) { return id === "statusFilter" ? { value: "submitted" } : { innerHTML: "" }; } },
  filteredOrders() { return []; }, collapseFinalizedSales(rows) { return rows; },
  isHistoricalOrder() { return false; }, renderSummary() {}
};
vm.createContext(renderContext);
vm.runInContext(`${renderSource}; renderOrders();`, renderContext);
assert.equal(normalStops, 0, "hidden-by-filter new order keeps the alert active");
renderContext.orders = [{ status: "accepted" }];
vm.runInContext("renderOrders();", renderContext);
assert.equal(normalStops, 1, "acknowledgement of the last new order stops alerts");
renderContext.orders = [{ status: "accepted" }, { status: "submitted" }];
vm.runInContext("renderOrders();", renderContext);
assert.equal(normalStops, 1, "acknowledgement of one of multiple orders does not stop alerts");

assert.match(html, /assets\/qr-staff\.js\?v=20261105-voice-alert-1/);
assert.match(html, /assets\/order-inbox\.js\?v=20261105-voice-alert-1/);
assert.match(inbox, /function renderOrders\(\) \{\s*if \(!orders\.some\(\(order\) => order\.status === "submitted"\)\) ui\.stopAlert\?\.\(\)/);
assert.match(inbox, /addEventListener\("beforeunload", \(\) => \{\s*ui\.stopAlert\?\.\(\{ force: true \}\)/);
assert.match(inbox, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible" && orders\.some\(\(order\) => order\.status === "submitted"\)\) \{\s*ui\.playAlert\(\);\s*\}\s*\}, 9000\)/);
assert.match(inbox, /soundBtn[\s\S]*?ui\.enableSound\(\)/);
console.log("QR louder Vietnamese voice alert regression checks passed.");
