(function initQrStaff(global) {
  "use strict";

  if (!global.DGV) throw new Error("DGV Supabase client must load before qr-staff.js.");

  const DGV = global.DGV;
  let audioContext = null;
  let audioEnabled = false;
  let alertBusyUntil = 0;
  let alertIsPreview = false;
  let voiceTimer = null;
  let voiceTimeout = null;
  let alertUtterance = null;
  let alertGeneration = 0;
  const alertTones = new Set();
  const SOUND_PREFERENCE_KEY = "dgv-qr-order-sound";
  const ORDER_VOICE_TEXT = "Có đơn hàng mới. Vui lòng xác nhận.";

  function byId(id) {
    return document.getElementById(id);
  }

  function formatVnd(value) {
    return `${Math.max(0, Math.round(Number(value) || 0)).toLocaleString("ko-KR")} VND`;
  }

  function formatUsd(value) {
    return `${Math.max(0, Math.round(Number(value) || 0)).toLocaleString("ko-KR")}$`;
  }

  function formatTime(value, options = {}) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...options
    });
  }

  function shortId(value) {
    const text = String(value || "");
    return text ? text.slice(0, 8).toUpperCase() : "—";
  }

  function messageOf(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message || /failed to fetch/i.test(message)) return fallback;
    if (/jwt|auth|permission|row-level security|not allowed/i.test(message)) {
      return "권한을 확인할 수 없습니다. 다시 로그인해 주세요.";
    }
    return fallback;
  }

  function toast(message, tone = "info", timeoutMs = 3600) {
    let stack = byId("qrToastStack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "qrToastStack";
      stack.className = "qr-toast-stack";
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    const item = document.createElement("div");
    item.className = "qr-toast";
    item.dataset.tone = tone;
    item.textContent = message;
    stack.appendChild(item);
    const remove = () => item.remove();
    const timer = global.setTimeout(remove, timeoutMs);
    item.addEventListener("click", () => {
      global.clearTimeout(timer);
      remove();
    });
  }

  function setBusy(button, busy, busyLabel = "처리 중…") {
    if (!button) return;
    if (busy) {
      button.dataset.idleText = button.textContent;
      button.textContent = busyLabel;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      return;
    }
    button.textContent = button.dataset.idleText || button.textContent;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }

  async function requireLogin(options = {}) {
    const roles = Array.isArray(options.roles) ? options.roles : [options.roles || "staff"];
    const preferredRole = options.preferredRole || roles[0];
    const identity = await DGV.getIdentity();
    if (identity.user && roles.includes(identity.role)) return identity;

    const modal = byId("loginModal");
    const input = byId("loginPassword");
    const confirm = byId("loginConfirm");
    const form = byId("loginForm");
    if (!modal || !input || !confirm || !form) throw new Error("Login modal is missing.");

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    input.value = "";
    global.setTimeout(() => input.focus(), 40);

    return new Promise((resolve) => {
      async function submit(event) {
        event.preventDefault();
        const roleSelect = byId("loginRole");
        const requestedRole = roleSelect?.value || preferredRole;
        if (!roles.includes(requestedRole)) {
          toast("이 페이지에서 사용할 수 없는 권한입니다.", "error");
          return;
        }
        const password = input.value.trim();
        if (!password) {
          toast("비밀번호를 입력해 주세요.", "error");
          input.focus();
          return;
        }
        setBusy(confirm, true, "로그인 중…");
        try {
          const loginRoles = roleSelect
            ? [requestedRole]
            : [preferredRole, ...roles.filter((role) => role !== preferredRole)];
          const result = await DGV.signInAsAny(loginRoles, password);
          if (!roles.includes(result.role)) throw new Error("허용되지 않은 역할입니다.");
          modal.hidden = true;
          document.body.style.overflow = "";
          form.removeEventListener("submit", submit);
          resolve(result);
        } catch (error) {
          console.error(error);
          const roleLabel = requestedRole === "admin"
            ? "관리자"
            : requestedRole === "manager"
              ? "매니저"
              : "직원";
          toast(roleSelect
            ? `${roleLabel} 비밀번호가 올바르지 않습니다.`
            : "사용 가능한 비밀번호가 올바르지 않습니다.", "error");
          input.select();
        } finally {
          setBusy(confirm, false);
        }
      }
      form.addEventListener("submit", submit);
    });
  }

  async function signOut() {
    stopAlert({ force: true });
    await DGV.signOut({ reload: false });
    global.location.reload();
  }

  async function enableSound() {
    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) {
      toast("이 브라우저에서는 알림음을 사용할 수 없습니다.", "error");
      return false;
    }
    if (!audioContext || audioContext.state === "closed") {
      stopAlert({ force: true });
      audioContext = new AudioCtx();
      alertBusyUntil = 0;
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    audioEnabled = audioContext.state === "running";
    if (audioEnabled) {
      try { global.localStorage.setItem(SOUND_PREFERENCE_KEY, "enabled"); } catch (_) { /* optional preference */ }
      // Some browsers load installed voices asynchronously after the first query.
      try { global.speechSynthesis?.getVoices(); } catch (_) { /* tones remain available */ }
      playAlert({ preview: true });
    }
    return audioEnabled;
  }

  function soundPreferred() {
    try { return global.localStorage.getItem(SOUND_PREFERENCE_KEY) === "enabled"; }
    catch (_) { return false; }
  }

  function playTone(frequency, start, duration, gainValue) {
    if (!audioContext || audioContext.state !== "running") return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + .02);
    // Keep the alert audible instead of fading immediately after the attack.
    gain.gain.setValueAtTime(gainValue, start + duration - .06);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.onended = () => {
      alertTones.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    alertTones.add(oscillator);
    oscillator.start(start);
    oscillator.stop(start + duration + .03);
  }

  function stopAlert(options = {}) {
    if (alertIsPreview && !options.force) return;
    alertGeneration += 1;
    global.clearTimeout(voiceTimer);
    global.clearTimeout(voiceTimeout);
    voiceTimer = null;
    voiceTimeout = null;
    const wasSpeaking = Boolean(alertUtterance);
    alertUtterance = null;
    if (wasSpeaking) {
      try { global.speechSynthesis?.cancel(); } catch (_) { /* optional speech */ }
    }
    alertTones.forEach((tone) => { try { tone.stop(); } catch (_) { /* already ended */ } });
    alertTones.clear();
    alertBusyUntil = 0;
    alertIsPreview = false;
  }

  function speakOrderAlert(preview, generation) {
    if (generation !== alertGeneration) return;
    voiceTimer = null;
    if (!audioEnabled || audioContext?.state !== "running") return;
    const speech = global.speechSynthesis;
    const fallback = () => {
      if (preview) toast("베트남어 음성을 사용할 수 없어 알림음만 재생합니다. 기기의 베트남어 음성 설정을 확인해 주세요.", "info", 6500);
    };
    if (!speech || !global.SpeechSynthesisUtterance) { fallback(); return; }
    try {
      const voice = speech.getVoices().find((item) => /^vi(?:[-_]|$)/i.test(item.lang));
      if (!voice) { fallback(); return; }
      // Do not add announcements to another speech queue or use a wrong-language voice.
      if (speech.speaking || speech.pending) return;
      const utterance = new global.SpeechSynthesisUtterance(ORDER_VOICE_TEXT);
      utterance.voice = voice;
      utterance.lang = "vi-VN";
      utterance.volume = 1;
      utterance.rate = 1;
      utterance.pitch = 1;
      alertUtterance = utterance;
      const finish = () => {
        if (alertUtterance !== utterance) return;
        global.clearTimeout(voiceTimeout);
        voiceTimeout = null;
        alertUtterance = null;
      };
      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (alertUtterance !== utterance) return;
        finish();
        if (!["canceled", "interrupted"].includes(event.error)) fallback();
      };
      // A stuck voice must not block the next 9-second order reminder.
      voiceTimeout = global.setTimeout(() => {
        if (alertUtterance !== utterance) return;
        finish();
        try { speech.cancel(); } catch (_) { /* optional speech */ }
      }, 6000);
      speech.speak(utterance);
    } catch (_) {
      global.clearTimeout(voiceTimeout);
      voiceTimeout = null;
      alertUtterance = null;
      fallback();
    }
  }

  function playAlert(options = {}) {
    if (!audioEnabled || !audioContext || audioContext.state !== "running") return false;
    const now = audioContext.currentTime + .02;
    // Coalesce simultaneous order events so loud alerts cannot stack and clip.
    if (now < alertBusyUntil || voiceTimer !== null || alertUtterance) return false;
    const generation = ++alertGeneration;
    alertIsPreview = Boolean(options.preview);
    alertBusyUntil = now + 1.8;
    for (const offset of [0, .95]) {
      playTone(659.25, now + offset, .30, .95);
      playTone(880, now + offset + .38, .42, .95);
    }
    voiceTimer = global.setTimeout(() => speakOrderAlert(Boolean(options.preview), generation), 1850);
    if (!options.preview && global.navigator?.vibrate) global.navigator.vibrate([180, 80, 180]);
    return true;
  }

  function connectionBadge(state, label) {
    const dot = byId("connectionDot");
    const text = byId("connectionText");
    if (dot) dot.className = `qr-dot is-${state}`;
    if (text) text.textContent = label;
  }

  function confirmAction(message, actionLabel = "확인") {
    return global.confirm(`${message}\n\n${actionLabel}하시겠습니까?`);
  }

  global.QRStaff = Object.freeze({
    byId,
    confirmAction,
    connectionBadge,
    enableSound,
    formatTime,
    formatUsd,
    formatVnd,
    messageOf,
    playAlert,
    requireLogin,
    setBusy,
    shortId,
    signOut,
    soundPreferred,
    stopAlert,
    toast
  });
})(window);
