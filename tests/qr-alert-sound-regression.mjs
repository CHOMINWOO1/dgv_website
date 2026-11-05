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
  class AudioContext {
    constructor() {
      this.state = initialState;
      this.currentTime = 0;
      this.destination = {};
      this.sampleRate = 48000;
      this.buffers = [];
      this.players = [];
      this.resumeCount = 0;
      contexts.push(this);
    }
    async resume() { this.resumeCount += 1; if (canResume) this.state = "running"; }
    createBuffer(channels, length, sampleRate) {
      const samples = Array.from({ length: channels }, () => new Float32Array(length));
      const value = { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels, getChannelData(channel) { return samples[channel]; } };
      this.buffers.push(value);
      return value;
    }
    createBufferSource() {
      const value = {
        disconnected: false,
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
        start(time) { this.startTime = time; },
        stop(time) { this.stopTime = time; this.stopCalls = (this.stopCalls || 0) + 1; }
      };
      this.players.push(value);
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
assert.equal(audio.players.length, 1, "preview uses one cached telephone-ring buffer");
assert.equal(test.vibrations.length, 0, "preview must not vibrate");

const ring = audio.buffers[0];
assert.equal(audio.buffers.length, 1);
assert.equal(ring.numberOfChannels, 1);
assert.equal(ring.duration, 1.78);
assert.equal(audio.players[0].buffer, ring);
assert.equal(audio.players[0].target, audio.destination);
const samples = ring.getChannelData(0);
assert.ok(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= .950001), "finite samples with headroom below clipping");
const slice = (from, to) => samples.slice(Math.ceil(from * ring.sampleRate), Math.floor(to * ring.sampleRate));
const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
assert.ok(rms(slice(.05, .65)) > .4, "first ringing burst has sustained energy");
assert.ok(rms(slice(1, 1.6)) > .4, "second ringing burst has sustained energy");
assert.ok(slice(.73, .94).every(sample => sample === 0), "clear gap between rings");
assert.ok(slice(1.68, 1.78).every(sample => sample === 0), "silence before speech starts");
assert.equal(samples[0], 0, "fade starts at silence");
assert.ok(rms(slice(0, .004)) < rms(slice(.04, .06)), "smooth attack");
assert.ok(rms(slice(.71, .72)) < rms(slice(.6, .61)), "smooth release");
assert.ok(audio.players[0].stopTime >= 1.7 && audio.players[0].stopTime < 1.85);
audio.players[0].onended();
assert.equal(audio.players[0].disconnected, true);

assert.equal(test.api.playAlert(), false, "bursty Realtime/attention calls cannot stack loud sounds");
assert.equal(await test.api.enableSound(), true, "a double click still leaves sound enabled");
assert.equal(audio.players.length, 1, "double-click preview cannot stack");
test.advance(2000);
assert.equal(test.api.playAlert(), true);
assert.equal(audio.players.length, 2);
assert.equal(audio.buffers.length, 1, "repeated alerts reuse the generated audio buffer");
assert.equal(audio.players[1].buffer, ring);
assert.deepEqual(test.vibrations, [[180, 80, 180]]);
test.advance(2000);
audio.state = "suspended";
assert.equal(test.api.playAlert(), false);
assert.equal(audio.players.length, 2, "suspended context schedules nothing");
audio.state = "running";
assert.equal(test.api.playAlert(), true, "suspended call does not consume a future alert window");
assert.equal(audio.players.length, 3);
audio.state = "closed";
assert.equal(test.api.playAlert(), false);
assert.equal(await test.api.enableSound(), true, "closed context can be recreated by user gesture");
assert.equal(test.contexts.length, 2);
assert.equal(test.contexts[1].players.length, 1, "recreated context resets busy window");
assert.equal(test.contexts[1].buffers.length, 1);
assert.notEqual(test.contexts[1].buffers[0], ring, "new audio context gets its own cached buffer");

const denied = fixture({ deniedStorage: true, webkit: true });
assert.equal(denied.api.soundPreferred(), false);
assert.equal(await denied.api.enableSound(), true, "storage denial and webkit fallback remain supported");
assert.equal(denied.contexts[0].players.length, 1);
const unsupported = fixture({ supported: false });
assert.equal(await unsupported.api.enableSound(), false);
assert.match(unsupported.stack.children[0].textContent, /이 브라우저에서는 알림음을 사용할 수 없습니다/);
const blocked = fixture({ canResume: false });
assert.equal(await blocked.api.enableSound(), false);
assert.equal(blocked.contexts[0].players.length, 0);
assert.equal(blocked.api.soundPreferred(), false);

// Vietnamese speech follows the tone, at maximum supported speech volume.
const spoken = fixture({ hasSpeech: true, voices: [{ lang: "ko-KR", name: "Korean" }, { lang: "en-US", name: "English" }, { lang: "vi-VN", name: "Vietnamese" }] });
assert.equal(await spoken.api.enableSound(), true);
assert.equal(spoken.speech.utterances.length, 0);
spoken.advance(1849);
assert.equal(spoken.speech.utterances.length, 0, "speech must wait until the chime has ended");
spoken.advance(1);
assert.equal(spoken.speech.utterances.length, 1);
const firstVoice = spoken.speech.utterances[0];
assert.equal(firstVoice.text, "Có đơn hàng mới. Vui lòng xác nhận.");
assert.equal(firstVoice.voice.name, "Vietnamese", "Vietnamese takes priority even when Korean is listed first");
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
assert.ok(preview.contexts[0].players.every(tone => tone.stopCalls >= 2), "stop also stops scheduled telephone rings");
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
assert.match(noVi.stack.children[0].textContent, /베트남어·한국어 음성을 사용할 수 없어 전화벨/);
noVi.speech.voices = [{ lang: "vi", name: "Newly installed Vietnamese" }];
assert.equal(noVi.api.playAlert(), true);
noVi.advance(1850);
assert.equal(noVi.speech.utterances.length, 1, "later alerts can use newly available voices");

for (const lang of ["ko-KR", "ko_KR", "KO", "ko"]) {
  const korean = fixture({ hasSpeech: true, voices: [{ lang: "en-US", name: "English" }, { lang, name: "Korean fallback" }] });
  await korean.api.enableSound();
  korean.advance(1850);
  const voice = korean.speech.utterances[0];
  assert.equal(voice.voice.name, "Korean fallback");
  assert.equal(voice.text, "새 주문이 들어왔습니다. 확인해 주세요.");
  assert.equal(voice.lang, "ko-KR");
  assert.equal(voice.volume, 1);
  assert.equal(korean.stack.children.length, 0, "successful Korean fallback needs no unsupported-voice warning");
}
const noVoices = fixture({ hasSpeech: true, voices: [] });
await noVoices.api.enableSound();
noVoices.advance(1850);
assert.equal(noVoices.speech.utterances.length, 0);
assert.equal(noVoices.contexts[0].players.length, 1, "no supported voices still plays telephone ring");

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
assert.equal(failing.contexts[0].players.length, 1);
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

assert.match(html, /assets\/qr-staff\.js\?v=20261105-phone-ring-1/);
assert.match(html, /assets\/order-inbox\.js\?v=20261105-voice-alert-1/);
assert.match(inbox, /function renderOrders\(\) \{\s*if \(!orders\.some\(\(order\) => order\.status === "submitted"\)\) ui\.stopAlert\?\.\(\)/);
assert.match(inbox, /addEventListener\("beforeunload", \(\) => \{\s*ui\.stopAlert\?\.\(\{ force: true \}\)/);
assert.match(inbox, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === "visible" && orders\.some\(\(order\) => order\.status === "submitted"\)\) \{\s*ui\.playAlert\(\);\s*\}\s*\}, 9000\)/);
assert.match(inbox, /soundBtn[\s\S]*?ui\.enableSound\(\)/);
console.log("QR telephone ring and Vietnamese/Korean voice alert regression checks passed.");
