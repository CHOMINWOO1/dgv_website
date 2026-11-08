/* HANA Karaoke: buildless, isolated room capabilities; no shared DGV auth/session. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ROOM_PATTERN = /^\d{6}$/;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
  const VIDEO_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const MIN_REFRESH_MS = 5000;
  const FALLBACK_MS = 60000;
  const RECONCILE_MS = 300000;
  const STORAGE_PREFIX = 'hana-karaoke:room:';
  const dict = {
    ko: {
      welcome: '우리집 노래방', intro: 'TV에서 새 방을 만들고 휴대폰으로 접속하세요.',
      tagline: 'TV와 휴대폰으로 즐기는 우리집 노래방', create: 'TV에서 방 만들기', publicCreate: '로그인이나 비밀번호 없이 방을 만들 수 있습니다.',
      join: '휴대폰 연결', joinLabel: '초대 링크 또는 저장된 방 코드', joinPlaceholder: '초대 링크 또는 저장된 6자리 코드',
      joinHint: '처음 연결하는 휴대폰은 TV의 QR을 스캔하거나 초대 링크를 열어 주세요. 방 코드만으로는 새 기기를 연결할 수 없습니다.',
      leave: '나가기', room: '연결 코드', tv: 'TV 화면', phone: '휴대폰 리모컨', connectPhone: '휴대폰을 리모컨으로',
      qrHint: '휴대폰 카메라로 QR을 스캔하세요.', invitePrivacy: '초대 링크를 가진 사람은 예약과 재생을 제어할 수 있습니다. 함께 노래할 사람에게만 공유하세요.',
      copyInvite: '초대 링크 복사', inviteLink: '초대 링크', copied: '초대 링크를 복사했습니다.', copyManual: '아래 링크를 길게 눌러 복사해 주세요.',
      now: '현재 재생', waiting: '첫 번째 노래를 예약해 주세요.', autoplay: 'TV에서 첫 재생 버튼을 눌러야 할 수 있습니다. 일부 TV 브라우저나 영상은 유튜브 재생을 제한합니다.',
      next: '다음 곡', play: '재생', pause: '일시정지', startTV: 'TV에서 재생 시작', queue: '예약 목록', addSong: '노래 예약',
      searchHint: '유튜브에서 노래방 영상을 찾아 공유 링크를 복사해 넣으세요.', search: '유튜브 노래 검색 ↗', titleLabel: '노래 제목 (선택)',
      titlePlaceholder: '노래 제목 (선택)', urlLabel: 'YouTube 링크 또는 영상 ID', add: '예약 추가', controlHint: 'TV에서 직접 재생을 시작해야 할 수 있습니다.',
      empty: '예약된 곡이 없습니다.', refresh: '새로고침', close: '방 종료', closeConfirm: '이 방을 종료할까요? 모든 휴대폰의 연결과 예약이 종료됩니다.',
      leaveConfirm: 'TV 화면을 나가면 재생이 중단됩니다. 방을 유지한 채 나갈까요?', closed: '종료되었거나 만료된 방입니다. 새 방을 만들어 주세요.',
      connected: '실시간 연결됨', connecting: '연결 중…', degraded: '실시간 연결 재시도 중 · 필요하면 새로고침', offline: '인터넷 연결을 확인해 주세요.',
      error: '연결에 문제가 있습니다. 잠시 후 다시 시도해 주세요.', invalidResponse: '서버 응답을 확인할 수 없습니다.', configError: '노래방 서비스 설정을 확인해 주세요.',
      uncertain: '요청 결과를 확인하지 못했습니다. 새로고침으로 예약 목록을 확인한 뒤 다시 시도해 주세요. 같은 요청을 다시 누르면 중복 실행 없이 재확인합니다.',
      urlError: '올바른 YouTube 링크 또는 11자리 영상 ID를 입력하세요.', inviteError: '이 기기에서는 QR 또는 전체 초대 링크가 필요합니다.',
      invalidInvite: '올바른 초대 링크 또는 6자리 방 코드를 입력하세요.', unauthorized: '초대 링크가 유효하지 않습니다. TV의 QR을 다시 스캔해 주세요.',
      staffRequired: '현재 방 만들기는 직원 인증이 필요합니다. 관리자에게 문의해 주세요.', rateLimit: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
      queueFull: '예약 목록이 가득 찼습니다. 일부 곡을 재생하거나 삭제해 주세요.', added: '예약 목록에 추가했습니다.', moved: '예약 목록을 변경했습니다.',
      up: '위로 이동', down: '아래로 이동', remove: '예약 삭제', fallbackTitle: 'YouTube 노래방', expires: '방 만료',
      manualStart: '자동 재생이 차단되면 아래 ‘TV에서 재생 시작’ 또는 영상의 재생 버튼을 눌러 주세요.',
      playerError: '이 영상을 재생할 수 없습니다. TV의 인터넷 연결을 확인하거나 다음 곡을 선택하세요.',
      playerUnavailable: 'YouTube 플레이어를 불러오지 못했습니다. 네트워크를 확인하고 페이지를 새로고침해 주세요.',
      storageWarning: '이 브라우저는 세션 저장을 허용하지 않습니다. 새로고침하면 방 연결을 복구하지 못할 수 있습니다.',
      footer: '개인용 노래방 · YouTube 이용약관이 적용됩니다.'
    },
    vi: {
      welcome: 'Karaoke tại nhà', intro: 'Tạo phòng trên TV, sau đó kết nối điện thoại.', tagline: 'Karaoke với TV và điện thoại',
      create: 'Tạo phòng trên TV', publicCreate: 'Tạo phòng không cần đăng nhập hoặc mật khẩu.', join: 'Kết nối điện thoại',
      joinLabel: 'Liên kết mời hoặc mã phòng đã lưu', joinPlaceholder: 'Liên kết mời hoặc mã 6 số đã lưu',
      joinHint: 'Điện thoại mới cần quét mã QR trên TV hoặc mở liên kết mời. Chỉ mã phòng không đủ để kết nối thiết bị mới.',
      leave: 'Thoát', room: 'Mã phòng', tv: 'Màn hình TV', phone: 'Điều khiển điện thoại', connectPhone: 'Điện thoại là điều khiển',
      qrHint: 'Quét mã QR bằng điện thoại.', invitePrivacy: 'Người có liên kết mời có thể thêm bài và điều khiển phát. Chỉ chia sẻ với người cùng hát.',
      copyInvite: 'Sao chép liên kết mời', inviteLink: 'Liên kết mời', copied: 'Đã sao chép liên kết mời.', copyManual: 'Nhấn giữ liên kết bên dưới để sao chép.',
      now: 'Đang phát', waiting: 'Hãy thêm bài hát đầu tiên.', autoplay: 'Có thể cần nhấn phát trên TV. Một số trình duyệt TV hoặc video hạn chế phát YouTube.',
      next: 'Bài tiếp theo', play: 'Phát', pause: 'Tạm dừng', startTV: 'Bắt đầu phát trên TV', queue: 'Danh sách chờ', addSong: 'Thêm bài hát',
      searchHint: 'Tìm video karaoke trên YouTube, sao chép liên kết và dán vào đây.', search: 'Tìm trên YouTube ↗', titleLabel: 'Tên bài hát (tùy chọn)',
      titlePlaceholder: 'Tên bài hát (tùy chọn)', urlLabel: 'Liên kết hoặc ID video YouTube', add: 'Thêm vào hàng chờ', controlHint: 'Có thể cần bắt đầu phát trực tiếp trên TV.',
      empty: 'Chưa có bài hát.', refresh: 'Làm mới', close: 'Đóng phòng', closeConfirm: 'Đóng phòng? Mọi điện thoại và danh sách chờ sẽ bị ngắt kết nối.',
      leaveConfirm: 'Thoát màn hình TV sẽ dừng phát. Giữ phòng và thoát?', closed: 'Phòng đã đóng hoặc hết hạn. Hãy tạo phòng mới.',
      connected: 'Đã kết nối trực tiếp', connecting: 'Đang kết nối…', degraded: 'Đang kết nối lại · Có thể nhấn Làm mới', offline: 'Vui lòng kiểm tra kết nối internet.',
      error: 'Lỗi kết nối. Vui lòng thử lại sau.', invalidResponse: 'Không đọc được phản hồi máy chủ.', configError: 'Vui lòng kiểm tra cấu hình dịch vụ karaoke.',
      uncertain: 'Chưa xác nhận được kết quả. Hãy làm mới danh sách trước khi thử lại. Gửi lại cùng yêu cầu sẽ không thực hiện trùng lặp.',
      urlError: 'Nhập liên kết YouTube hợp lệ hoặc ID video 11 ký tự.', inviteError: 'Thiết bị này cần mã QR hoặc liên kết mời đầy đủ.',
      invalidInvite: 'Nhập liên kết mời hợp lệ hoặc mã phòng 6 số.', unauthorized: 'Liên kết mời không hợp lệ. Hãy quét lại mã QR trên TV.',
      staffRequired: 'Hiện cần xác thực nhân viên để tạo phòng. Hãy liên hệ quản trị viên.', rateLimit: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
      queueFull: 'Danh sách chờ đã đầy. Hãy phát hoặc xóa một số bài.', added: 'Đã thêm vào hàng chờ.', moved: 'Đã cập nhật danh sách chờ.',
      up: 'Chuyển lên', down: 'Chuyển xuống', remove: 'Xóa bài', fallbackTitle: 'YouTube karaoke', expires: 'Phòng hết hạn',
      manualStart: 'Nếu tự động phát bị chặn, nhấn “Bắt đầu phát trên TV” hoặc nút phát trong video.',
      playerError: 'Không phát được video này. Kiểm tra mạng trên TV hoặc chọn bài tiếp theo.',
      playerUnavailable: 'Không tải được YouTube. Kiểm tra mạng rồi tải lại trang.', storageWarning: 'Trình duyệt không lưu phiên. Có thể mất kết nối phòng khi tải lại trang.',
      footer: 'Karaoke cá nhân · Áp dụng điều khoản YouTube.'
    },
    en: {
      welcome: 'Karaoke at home', intro: 'Create a room on TV, then connect your phone.', tagline: 'Karaoke with your TV and phone',
      create: 'Create TV room', publicCreate: 'Create a room without a login or password.', join: 'Connect phone', joinLabel: 'Invitation link or saved room code',
      joinPlaceholder: 'Invitation link or saved 6-digit code', joinHint: 'A new phone must scan the TV’s QR code or open its invitation link. A room code alone cannot connect a new device.',
      leave: 'Leave', room: 'Room code', tv: 'TV screen', phone: 'Phone remote', connectPhone: 'Your phone is the remote', qrHint: 'Scan the QR code with your phone.',
      invitePrivacy: 'Anyone with the invitation link can add songs and control playback. Share it only with your singing group.',
      copyInvite: 'Copy invitation link', inviteLink: 'Invitation link', copied: 'Invitation link copied.', copyManual: 'Press and hold the link below to copy it.',
      now: 'Now playing', waiting: 'Add your first song to get started.', autoplay: 'You may need to start playback on TV. Some TV browsers or videos restrict YouTube playback.',
      next: 'Next song', play: 'Play', pause: 'Pause', startTV: 'Start playback on TV', queue: 'Queue', addSong: 'Add a song',
      searchHint: 'Find a karaoke video on YouTube, copy its share link and paste it here.', search: 'Search YouTube ↗', titleLabel: 'Song title (optional)',
      titlePlaceholder: 'Song title (optional)', urlLabel: 'YouTube link or video ID', add: 'Add to queue', controlHint: 'Playback may need to be started directly on TV.',
      empty: 'No songs queued.', refresh: 'Refresh', close: 'Close room', closeConfirm: 'Close this room? All phones and queued songs will be disconnected.',
      leaveConfirm: 'Leaving the TV screen stops playback. Leave and keep the room open?', closed: 'This room is closed or expired. Please create a new room.',
      connected: 'Live connection', connecting: 'Connecting…', degraded: 'Reconnecting live updates · Refresh if needed', offline: 'Please check your internet connection.',
      error: 'Connection problem. Please try again shortly.', invalidResponse: 'Could not read the server response.', configError: 'Please check the karaoke service configuration.',
      uncertain: 'The result could not be confirmed. Refresh the queue before trying again. Repeating the same request safely checks it without applying it twice.',
      urlError: 'Enter a valid YouTube link or 11-character video ID.', inviteError: 'This device needs the QR code or complete invitation link.',
      invalidInvite: 'Enter a valid invitation link or 6-digit room code.', unauthorized: 'This invitation is invalid. Please scan the TV’s QR code again.',
      staffRequired: 'Creating rooms currently requires staff authentication. Please contact the administrator.', rateLimit: 'Too many requests. Please try again shortly.',
      queueFull: 'The queue is full. Play or remove some songs first.', added: 'Added to the queue.', moved: 'Queue updated.',
      up: 'Move up', down: 'Move down', remove: 'Remove song', fallbackTitle: 'YouTube karaoke', expires: 'Room expires',
      manualStart: 'If autoplay is blocked, press “Start playback on TV” below or the video’s own play button.',
      playerError: 'This video cannot be played. Check the TV’s internet connection or choose the next song.',
      playerUnavailable: 'YouTube could not load. Check your connection and reload this page.', storageWarning: 'This browser cannot save the session. Reloading may lose your room connection.',
      footer: 'Personal home use · YouTube terms apply.'
    }
  };

  let lang = 'ko';
  try { const saved = localStorage.getItem('hanaLang'); if (Object.hasOwn(dict, saved)) lang = saved; } catch (_) { /* Optional preference. */ }
  const t = (key) => dict[lang][key] || dict.en[key] || key;
  let room = '', mode = '', credentials = null, state = null, generation = 0;
  let busy = false, realtime = null, channel = null, channelTopic = '', healthy = false;
  let refreshPromise = null, refreshTimer = null, fallbackTimer = null, lastRefreshAt = 0;
  let refreshAfterPending = false;
  let player = null, playerReady = false, playerPromise = null, loadedEntryId = '', commandedPlaying = null;
  let hasPlayedEntry = false, endedEntryId = '', pendingEndedId = '', playbackMessage = '', connectionKey = 'connecting';
  let pendingPlayback = null;
  let noticeKey = '', noticeIsError = false, suspended = false, storageAvailable = true;
  const inFlight = new Set();
  const uncertainRequests = new Map();

  function showNotice(key, isError = false) {
    noticeKey = key;
    noticeIsError = isError;
    $('notice').textContent = key ? t(key) : '';
    $('notice').hidden = !key;
    $('notice').classList.toggle('error', isError);
  }

  function showPlayback(key) {
    playbackMessage = key;
    $('playbackNotice').textContent = key ? t(key) : '';
    $('playbackNotice').hidden = !key;
  }

  function setConnection(key) {
    connectionKey = key;
    $('connection').textContent = t(key);
    $('connection').classList.toggle('connected', key === 'connected');
  }

  function savedSession(code) {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + code) || 'null');
      if (!value || typeof value !== 'object') return null;
      return {
        hostToken: TOKEN_PATTERN.test(value.hostToken || '') ? value.hostToken : '',
        joinToken: TOKEN_PATTERN.test(value.joinToken || '') ? value.joinToken : '',
        mode: value.mode === 'tv' ? 'tv' : 'phone'
      };
    } catch (_) { return null; }
  }

  function saveSession(code, value) {
    try { sessionStorage.setItem(STORAGE_PREFIX + code, JSON.stringify(value)); }
    catch (_) { storageAvailable = false; showNotice('storageWarning'); }
  }

  function forgetSession(code) {
    try { sessionStorage.removeItem(STORAGE_PREFIX + code); } catch (_) { /* No storage. */ }
  }

  function pageUrl() {
    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/\/hana_karaoke\.html$/, '/hana_karaoke');
    url.search = '';
    url.hash = '';
    return url;
  }

  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function apiError(code, httpStatus) {
    const normalized = String(code || '').toUpperCase();
    if (normalized.includes('CREATE_REQUIRES_AUTH') || normalized.includes('STAFF_REQUIRED')) return 'staffRequired';
    if (httpStatus === 429 || normalized.includes('RATE_LIMIT')) return 'rateLimit';
    if (normalized.includes('QUEUE_FULL')) return 'queueFull';
    if (httpStatus === 404 || httpStatus === 410 || /ROOM_(CLOSED|EXPIRED|NOT_FOUND)/.test(normalized)) return 'closed';
    if (httpStatus === 401 || httpStatus === 403 || /INVALID_TOKEN|UNAUTHORIZED|FORBIDDEN/.test(normalized)) return 'unauthorized';
    return 'error';
  }

  async function api(action, extra = {}) {
    const config = window.DGV_SUPABASE_CONFIG;
    if (!config || !/^https:\/\//.test(config.url || '') || !config.publishableKey) throw new Error('configError');
    const payload = { action, ...extra };
    if (action !== 'create') {
      payload.room = room;
      payload.token = mode === 'tv' ? credentials?.hostToken : credentials?.joinToken;
      if (!payload.token) throw new Error('inviteError');
    }
    const signature = JSON.stringify(payload);
    payload.requestId = uncertainRequests.get(signature) || requestId();
    const expectedGeneration = generation;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      inFlight.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(config.url.replace(/\/$/, '') + '/functions/v1/hana-karaoke', {
          method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
        });
        let data;
        try { data = await response.json(); } catch (_) { throw new Error('Uncertain response'); }
        if (!response.ok || data?.error) {
          if (response.status >= 500) throw new Error('Uncertain response');
          uncertainRequests.delete(signature);
          throw new Error(apiError(data?.code || data?.error?.code || data?.error, response.status));
        }
        uncertainRequests.delete(signature);
        return data;
      } catch (error) {
        if (Object.hasOwn(dict.en, error.message)) throw error;
        if (action !== 'state') uncertainRequests.set(signature, payload.requestId);
        // Lost responses retry the same idempotency key, including a later manual retry.
        if (attempt === 0 && expectedGeneration === generation && !suspended && navigator.onLine !== false) continue;
        throw new Error(action !== 'state' ? 'uncertain' : navigator.onLine === false ? 'offline' : 'error');
      } finally {
        clearTimeout(timeout);
        inFlight.delete(controller);
      }
    }
  }

  function validSong(song) {
    return song && typeof song.id === 'string' && song.id.length > 0 && song.id.length <= 128 &&
      VIDEO_PATTERN.test(song.videoId) && typeof song.title === 'string' && song.title.length <= 500;
  }

  function acceptState(incoming) {
    if (!incoming || incoming.room !== room || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0 ||
        !Array.isArray(incoming.queue) || incoming.queue.length > 500 || !incoming.queue.every(validSong) ||
        (incoming.current !== null && !validSong(incoming.current)) || typeof incoming.playing !== 'boolean' ||
        typeof incoming.closed !== 'boolean' || typeof incoming.topic !== 'string' || incoming.topic.length > 256) {
      throw new Error('invalidResponse');
    }
    // Delayed API responses must never roll back the queue or restart an older song.
    if (state && (incoming.revision < state.revision || (state.closed && !incoming.closed))) return;
    state = incoming;
    renderState();
    if (state.closed) {
      forgetSession(room);
      disconnectRealtime();
      showNotice('closed', true);
    } else if (!suspended && channelTopic !== state.topic) {
      connectRealtime();
    }
  }

  function updateControls() {
    const active = Boolean(room && state && !state.closed);
    $('create').disabled = busy;
    $('join').disabled = busy;
    $('leave').disabled = busy;
    $('refresh').disabled = busy || !room || Boolean(state?.closed);
    $('add').disabled = busy || !active;
    $('close').disabled = busy || !active;
    ['pause', 'pauseTV'].forEach((id) => { $(id).disabled = busy || !active || !state.current; });
    ['play', 'startTV'].forEach((id) => { $(id).disabled = busy || !active || (!state.current && !state.queue.length); });
    ['next', 'nextTV'].forEach((id) => { $(id).disabled = busy || !active || (!state.current && !state.queue.length); });
    document.querySelectorAll('#queue button').forEach((button) => { button.disabled = busy || !active || button.dataset.edge === 'true'; });
    $('session').setAttribute('aria-busy', String(busy));
    $('home').setAttribute('aria-busy', String(busy));
  }

  function renderState() {
    if (!state) return;
    $('queue').replaceChildren();
    $('emptyQueue').hidden = state.queue.length > 0;
    $('queueCount').textContent = String(state.queue.length);
    state.queue.forEach((song, index) => {
      const row = document.createElement('li'); row.className = 'song';
      const number = document.createElement('span'); number.className = 'song-number'; number.textContent = String(index + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'song-title'; name.textContent = song.title || t('fallbackTitle');
      const controls = document.createElement('div'); controls.className = 'song-tools';
      [['↑', 'up'], ['↓', 'down'], ['×', 'remove']].forEach(([label, operation]) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
        button.setAttribute('aria-label', `${t(operation)}: ${song.title}`);
        button.dataset.edge = String((operation === 'up' && index === 0) || (operation === 'down' && index === state.queue.length - 1));
        button.addEventListener('click', () => mutate(operation, { itemId: song.id }, 'moved'));
        controls.append(button);
      });
      row.append(number, name, controls); $('queue').append(row);
    });
    const currentTitle = state.current ? state.current.title || t('fallbackTitle') : t('waiting');
    $('currentTV').textContent = currentTitle;
    $('currentPhone').textContent = currentTitle;
    $('playerEmpty').hidden = Boolean(state.current && !state.closed);
    const expiration = new Date(state.expiresAt);
    $('expires').textContent = Number.isNaN(expiration.getTime()) ? '' : `${t('expires')}: ${expiration.toLocaleString(lang)}`;
    syncPlayer();
    updateControls();
  }

  function translate() {
    document.documentElement.lang = lang;
    $('lang').value = lang;
    document.querySelectorAll('[data-i]').forEach((element) => { element.textContent = t(element.dataset.i); });
    document.querySelectorAll('[data-i-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.iPlaceholder); });
    $('tagline').textContent = t('tagline');
    $('mode').textContent = mode ? t(mode) : '';
    $('share').setAttribute('aria-label', t('inviteLink'));
    $('qr').setAttribute('aria-label', t('inviteLink'));
    showNotice(noticeKey, noticeIsError);
    showPlayback(playbackMessage);
    setConnection(connectionKey);
    renderState();
  }

  async function refreshState() {
    if (!room || suspended || state?.closed) return;
    if (refreshPromise) return refreshPromise;
    const expectedGeneration = generation;
    lastRefreshAt = Date.now();
    const promise = (async () => {
      try {
        const response = await api('state');
        if (expectedGeneration === generation) acceptState(response.state || response);
      } catch (error) {
        if (expectedGeneration === generation) {
          setConnection(navigator.onLine === false ? 'offline' : 'degraded');
          showNotice(error.message, true);
          if (error.message === 'closed' || error.message === 'unauthorized') {
            forgetSession(room);
            disconnectRealtime();
            if (state) { state = { ...state, closed: true, playing: false }; renderState(); }
          }
        }
        throw error;
      } finally {
        if (refreshPromise === promise) refreshPromise = null;
      }
    })();
    refreshPromise = promise;
    return promise;
  }

  function scheduleRefresh(immediate = false) {
    if (!room || suspended || state?.closed || document.hidden || refreshAfterPending) return;
    if (refreshTimer) {
      if (!immediate) return;
      clearTimeout(refreshTimer); refreshTimer = null;
    }
    // Public broadcasts are untrusted invalidations only. Never apply their payload.
    const delay = immediate ? 0 : Math.max(0, MIN_REFRESH_MS - (Date.now() - lastRefreshAt));
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (document.hidden) return;
      // A notification received during a slow read might describe a later commit.
      if (refreshPromise) {
        refreshAfterPending = true;
        const expectedGeneration = generation;
        refreshPromise.finally(() => {
          if (expectedGeneration !== generation) return;
          refreshAfterPending = false;
          scheduleRefresh(immediate);
        }).catch(() => {});
      } else refreshState().catch(() => {});
    }, delay);
  }

  function disconnectRealtime() {
    const previous = channel;
    channel = null; channelTopic = ''; healthy = false;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (fallbackTimer) clearInterval(fallbackTimer);
    fallbackTimer = null;
    if (previous && realtime) Promise.resolve(realtime.removeChannel(previous)).catch(() => {});
  }

  function connectRealtime() {
    if (!state || state.closed || !state.topic || suspended) return;
    disconnectRealtime();
    const expectedGeneration = generation;
    setConnection('connecting');
    fallbackTimer = setInterval(() => {
      const interval = healthy ? RECONCILE_MS : FALLBACK_MS;
      if (!document.hidden && !suspended && room && Date.now() - lastRefreshAt >= interval) refreshState().catch(() => {});
    }, FALLBACK_MS);
    try {
      if (!window.supabase?.createClient) throw new Error('Realtime unavailable');
      if (!realtime) {
        const config = window.DGV_SUPABASE_CONFIG;
        realtime = window.supabase.createClient(config.url, config.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'hana-karaoke-realtime-auth' },
          realtime: { params: { eventsPerSecond: 2 } }
        });
      }
      channelTopic = state.topic;
      const nextChannel = realtime.channel(channelTopic, { config: { private: false, broadcast: { self: false, ack: false } } });
      channel = nextChannel;
      nextChannel.on('broadcast', { event: 'changed' }, () => {
        if (channel === nextChannel && generation === expectedGeneration) scheduleRefresh();
      }).subscribe((status) => {
        if (channel !== nextChannel || generation !== expectedGeneration) return;
        healthy = status === 'SUBSCRIBED';
        setConnection(healthy ? 'connected' : navigator.onLine === false ? 'offline' : 'degraded');
        if (healthy) scheduleRefresh(true);
      });
    } catch (_) {
      healthy = false;
      setConnection('degraded');
    }
  }

  function showInvite() {
    $('invitePanel').hidden = mode !== 'tv' || !credentials?.joinToken;
    $('share').hidden = true;
    $('qr').replaceChildren();
    if (mode !== 'tv' || !credentials?.joinToken) return;
    const invitation = pageUrl();
    invitation.searchParams.set('room', room);
    invitation.hash = 'join=' + credentials.joinToken;
    // Only the join capability is shared. The host capability never enters a URL.
    $('share').value = invitation.href;
    if (typeof window.QRCode === 'function') {
      try {
        new window.QRCode($('qr'), { text: invitation.href, width: 150, height: 150, colorDark: '#0a2431', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
        $('qr').removeAttribute('title');
      } catch (_) { $('qr').textContent = t('copyInvite'); }
    } else { $('qr').textContent = t('copyInvite'); }
  }

  async function enter(code, desiredMode, saved, initialState) {
    cleanup();
    room = code; mode = desiredMode; credentials = saved; state = null; suspended = false;
    saveSession(room, { ...credentials, mode });
    const address = pageUrl(); address.searchParams.set(mode === 'tv' ? 'tv' : 'room', room);
    history.replaceState(null, '', address.pathname + address.search);
    $('home').hidden = true; $('session').hidden = false;
    $('tvPanel').hidden = mode !== 'tv'; $('phoneControls').hidden = mode === 'tv';
    $('close').hidden = mode !== 'tv'; $('mode').textContent = t(mode); $('roomCode').textContent = room;
    document.body.classList.toggle('tv-mode', mode === 'tv');
    showNotice(storageAvailable ? '' : 'storageWarning');
    showInvite();
    updateControls();
    if (initialState) acceptState(initialState);
    else await refreshState();
    if (mode === 'tv') ensurePlayer().catch(() => showPlayback('playerUnavailable'));
  }

  function cleanup() {
    generation += 1;
    disconnectRealtime();
    inFlight.forEach((controller) => controller.abort());
    inFlight.clear();
    refreshPromise = null; refreshAfterPending = false; lastRefreshAt = 0;
    uncertainRequests.clear();
    if (player) { try { player.destroy(); } catch (_) { /* Removed iframe. */ } }
    player = null; playerReady = false; loadedEntryId = ''; commandedPlaying = null; hasPlayedEntry = false; endedEntryId = ''; pendingEndedId = '';
    pendingPlayback = null;
    const mount = document.createElement('div'); mount.id = 'player';
    const oldMount = $('player'); if (oldMount) oldMount.replaceWith(mount); else $('playerFrame').prepend(mount);
    showPlayback('');
  }

  function leave() {
    if (mode === 'tv' && state?.current && !state.closed && !window.confirm(t('leaveConfirm'))) return;
    cleanup();
    room = ''; mode = ''; credentials = null; state = null;
    $('home').hidden = false; $('session').hidden = true; $('code').value = '';
    $('share').value = ''; $('qr').replaceChildren();
    document.body.classList.remove('tv-mode');
    const address = pageUrl(); history.replaceState(null, '', address.pathname);
    showNotice(''); updateControls();
  }

  async function mutate(action, extra = {}, successKey = '') {
    if (busy || !room || !state || state.closed) return false;
    busy = true; updateControls(); showNotice('');
    const expectedGeneration = generation;
    try {
      const response = await api(action, extra);
      if (expectedGeneration !== generation) return false;
      if (!response.state) throw new Error('invalidResponse');
      acceptState(response.state);
      if (action === 'close') {
        forgetSession(room);
        if (state && !state.closed) { state = { ...state, closed: true, playing: false }; renderState(); }
        disconnectRealtime(); showNotice('closed'); return true;
      }
      // Always read once after our own action, even if an older read is in flight.
      if (refreshPromise) await refreshPromise.catch(() => {});
      if (expectedGeneration !== generation) return false;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      try { await refreshState(); }
      catch (_) {
        // The write already succeeded with an authoritative snapshot. A failed
        // follow-up read must not keep Add populated or turn it into a new write.
        return true;
      }
      if (successKey) showNotice(successKey);
      return true;
    } catch (error) {
      if (expectedGeneration === generation) {
        showNotice(error.message, true);
        if (error.message === 'closed' || error.message === 'unauthorized') {
          forgetSession(room); disconnectRealtime();
          if (state) { state = { ...state, closed: true, playing: false }; renderState(); }
        }
      }
      return false;
    } finally {
      if (expectedGeneration === generation) {
        busy = false; updateControls();
        if (pendingEndedId) {
          const pending = pendingEndedId; pendingEndedId = '';
          if (state?.current?.id === pending && !state.closed) reportEnded(pending);
        }
        if (pendingPlayback && !busy) {
          const pending = pendingPlayback; pendingPlayback = null;
          if (state?.current?.id === pending.id && !state.closed) reportPlayback(pending.playing);
        }
      }
    }
  }

  function parseVideoId(input) {
    const text = input.trim();
    if (VIDEO_PATTERN.test(text)) return text;
    let url;
    try { url = new URL(text); } catch (_) { return ''; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase();
    let candidate = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') candidate = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'watch') candidate = url.searchParams.get('v');
      else if (['embed', 'shorts', 'live'].includes(parts[0])) candidate = parts[1];
    }
    return VIDEO_PATTERN.test(candidate || '') ? candidate : '';
  }

  function parseInvitation(text) {
    const input = text.trim();
    if (ROOM_PATTERN.test(input)) return { code: input, joinToken: '' };
    let url;
    try { url = new URL(input); } catch (_) { return null; }
    if (url.origin !== location.origin || !/\/hana_karaoke(?:\.html)?\/?$/.test(url.pathname)) return null;
    const code = url.searchParams.get('room') || '';
    const joinToken = new URLSearchParams(url.hash.slice(1)).get('join') || '';
    return ROOM_PATTERN.test(code) && TOKEN_PATTERN.test(joinToken) ? { code, joinToken } : null;
  }

  function reportEnded(endedId) {
    if (mode !== 'tv' || endedEntryId === endedId || state?.current?.id !== endedId || state.closed) return;
    if (busy) { pendingEndedId = endedId; return; }
    const expectedGeneration = generation;
    endedEntryId = endedId;
    mutate('ended', { expectedCurrentId: endedId }).then((success) => {
      if (!success && generation === expectedGeneration && loadedEntryId === endedId) endedEntryId = '';
    });
  }

  function reportPlayback(playing) {
    if (mode !== 'tv' || !state?.current || state.closed || loadedEntryId !== state.current.id || state.playing === playing) return;
    if (busy) { pendingPlayback = { id: loadedEntryId, playing }; return; }
    // Keep native YouTube controls and phone controls consistent without toggles.
    mutate(playing ? 'play' : 'pause');
  }

  async function ensurePlayer() {
    if (mode !== 'tv' || player || !room) return;
    const expectedGeneration = generation;
    if (!window.YT?.Player) {
      if (!playerPromise) {
        playerPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('playerUnavailable')), 15000);
          window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); resolve(); };
          const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
          script.onerror = () => { clearTimeout(timeout); reject(new Error('playerUnavailable')); };
          document.head.append(script);
        });
      }
      await playerPromise;
    }
    if (expectedGeneration !== generation || mode !== 'tv' || player) return;
    player = new window.YT.Player('player', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, origin: location.origin, controls: 1, rel: 0 },
      events: {
        onReady: (event) => {
          if (generation !== expectedGeneration) return;
          playerReady = true;
          const iframe = event.target.getIframe();
          iframe.setAttribute('title', 'YouTube karaoke player');
          iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
          iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          syncPlayer();
        },
        onStateChange: (event) => {
          if (generation !== expectedGeneration || mode !== 'tv' || !state?.current || state.closed || loadedEntryId !== state.current.id) return;
          const videoId = event.target.getVideoData?.().video_id;
          if (videoId !== state.current.videoId) return;
          if (event.data === window.YT.PlayerState.PLAYING) { hasPlayedEntry = true; showPlayback(''); reportPlayback(true); }
          if (event.data === window.YT.PlayerState.PAUSED && hasPlayedEntry) reportPlayback(false);
          if (event.data === window.YT.PlayerState.ENDED && hasPlayedEntry && endedEntryId !== loadedEntryId) {
            reportEnded(loadedEntryId);
          }
        },
        onAutoplayBlocked: () => { if (generation === expectedGeneration) showPlayback('manualStart'); },
        onError: () => { if (generation === expectedGeneration) showPlayback('playerError'); }
      }
    });
  }

  function syncPlayer() {
    if (mode !== 'tv' || !playerReady || !player || !state) return;
    try {
      if (!state.current || state.closed) {
        player.stopVideo(); loadedEntryId = ''; commandedPlaying = null; hasPlayedEntry = false; showPlayback(''); return;
      }
      if (loadedEntryId !== state.current.id) {
        // Compare queue entry IDs, not video IDs: the same video can be queued twice.
        loadedEntryId = state.current.id; commandedPlaying = state.playing; hasPlayedEntry = false; endedEntryId = '';
        showPlayback(state.playing ? 'manualStart' : '');
        const video = { videoId: state.current.videoId, startSeconds: 0 };
        if (state.playing) player.loadVideoById(video); else player.cueVideoById(video);
      } else if (commandedPlaying !== state.playing) {
        commandedPlaying = state.playing;
        if (state.playing) { player.playVideo(); showPlayback('manualStart'); } else player.pauseVideo();
      }
    } catch (_) { showPlayback('playerError'); }
  }

  $('lang').addEventListener('change', (event) => {
    if (!Object.hasOwn(dict, event.target.value)) return;
    lang = event.target.value;
    try { localStorage.setItem('hanaLang', lang); } catch (_) { /* Optional preference. */ }
    translate();
  });

  $('create').addEventListener('click', async () => {
    if (busy) return;
    busy = true; updateControls(); showNotice('');
    try {
      const response = await api('create');
      if (!ROOM_PATTERN.test(response.room) || !TOKEN_PATTERN.test(response.hostToken || '') || !TOKEN_PATTERN.test(response.joinToken || '') || !response.state) throw new Error('invalidResponse');
      await enter(response.room, 'tv', { hostToken: response.hostToken, joinToken: response.joinToken, mode: 'tv' }, response.state);
    } catch (error) { showNotice(error.message, true); }
    finally { busy = false; updateControls(); }
  });

  $('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const invitation = parseInvitation($('code').value);
    if (!invitation) return showNotice('invalidInvite', true);
    const saved = savedSession(invitation.code) || {};
    const joinToken = invitation.joinToken || saved.joinToken;
    if (!joinToken) return showNotice('inviteError', true);
    busy = true; updateControls();
    try { await enter(invitation.code, 'phone', { ...saved, joinToken, mode: 'phone' }); }
    catch (error) { showNotice(error.message, true); }
    finally { busy = false; updateControls(); }
  });

  $('songForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const videoId = parseVideoId($('songUrl').value);
    if (!videoId) return showNotice('urlError', true);
    const title = Array.from($('songTitle').value.trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 100).join('') || t('fallbackTitle');
    if (await mutate('add', { videoId, title }, 'added')) {
      $('songUrl').value = ''; $('songTitle').value = ''; $('songUrl').focus();
    }
  });

  $('search').addEventListener('click', () => {
    const query = ($('songTitle').value.trim() || 'karaoke') + ' karaoke';
    window.open('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), '_blank', 'noopener,noreferrer');
  });
  $('leave').addEventListener('click', leave);
  $('close').addEventListener('click', () => { if (mode === 'tv' && window.confirm(t('closeConfirm'))) mutate('close'); });
  $('refresh').addEventListener('click', () => { showNotice(''); refreshState().catch(() => {}); });
  ['next', 'nextTV'].forEach((id) => $(id).addEventListener('click', () => mutate('next', { expectedCurrentId: state?.current?.id || null })));
  $('play').addEventListener('click', () => mutate('play'));
  ['pause', 'pauseTV'].forEach((id) => $(id).addEventListener('click', () => mutate('pause')));
  $('startTV').addEventListener('click', () => {
    // Run immediately inside the user gesture, before awaiting the network.
    if (playerReady && player && state?.current) {
      try { player.playVideo(); } catch (_) { showPlayback('playerError'); }
    } else if (!playerReady) { showPlayback('playerUnavailable'); }
    mutate('play');
  });
  $('copyInvite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('share').value); showNotice('copied'); }
    catch (_) { $('share').hidden = false; $('share').focus(); $('share').select(); showNotice('copyManual'); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && room && !suspended) scheduleRefresh(true); });
  window.addEventListener('online', () => {
    if (room && state && !state.closed) { if (!channel) connectRealtime(); scheduleRefresh(true); }
  });
  window.addEventListener('offline', () => { healthy = false; if (room) setConnection('offline'); });
  window.addEventListener('pagehide', () => {
    suspended = true; disconnectRealtime();
    inFlight.forEach((controller) => controller.abort());
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && room) { suspended = false; connectRealtime(); scheduleRefresh(true); }
  });

  async function boot() {
    translate(); updateControls();
    const query = new URLSearchParams(location.search);
    const code = query.get('tv') || query.get('room') || '';
    const fragment = new URLSearchParams(location.hash.slice(1));
    const joinToken = fragment.get('join') || '';
    let saved = ROOM_PATTERN.test(code) ? savedSession(code) : null;
    if (ROOM_PATTERN.test(code) && TOKEN_PATTERN.test(joinToken)) {
      saved = { ...(saved || {}), joinToken, mode: 'phone' };
      saveSession(code, saved);
    }
    // Strip capabilities before loading YouTube or starting network requests.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!code) return;
    if (!ROOM_PATTERN.test(code)) return showNotice('invalidInvite', true);
    const requestedMode = query.has('tv') ? 'tv' : 'phone';
    if (!saved || !(requestedMode === 'tv' ? saved.hostToken : saved.joinToken)) {
      $('code').value = code; showNotice('inviteError', true); return;
    }
    busy = true; updateControls();
    try { await enter(code, requestedMode, saved); }
    catch (error) { showNotice(error.message, true); }
    finally { busy = false; updateControls(); }
  }
  boot().catch(() => showNotice('error', true));
})();
