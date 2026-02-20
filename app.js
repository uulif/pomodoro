// ==========================================
// 松村式ポモドーロタイマー v4
// ==========================================

// --- 定数 ---
const WORK_SEC = 25 * 60;
const SHORT_BREAK_SEC = 5 * 60 + 30;
const LONG_BREAK_SEC = 25 * 60;
const BAN_SEC = 3 * 60;
const PRE_NOTIFY_SEC = 60;
const CYCLES_PER_SET = 4;
const STORAGE_KEY = 'matsumura-pomodoro';
const THEME_KEY = 'matsumura-theme';
const PROGRESS_KEY = 'matsumura-progress';
const ABANDON_MS = 2 * 60 * 60 * 1000;
const BLOCK_COUNT = 40;

// --- 状態 ---
let state = 'idle';
let cycle = 1;
let currentSet = 1;
let totalSets = 1;
let remaining = 0;
let targetEndTime = 0;
let preNotified = false;
let catchingUp = false;
let currentPhaseDuration = 0;
let focusMode = false;
let currentTheme = 'clean';
let currentProgress = 'frame';
let focusInfoVisible = false;
let blockElements = [];

// トイレ
let savedState = null;
let savedRemaining = 0;

// 外的中断
let workElapsedAtInterrupt = 0;

// 確認ステップ
let stopPending = false;
let stopConfirmTimeout = null;
let violationPending = false;
let violationConfirmTimeout = null;

// セッション終了ダブルタップ確認
let sessionEndPending = false;
let sessionEndTimeout = null;
let activeSessionEndBtn = null;

// Worker / Audio / Wake Lock
let worker = null;
let audioCtx = null;
let wakeLock = null;
let lastTickTime = 0;
let watchdogId = null;
let workerRetryCount = 0;
let workerStableTimeout = null;
let fallbackId = null;
const MAX_WORKER_RETRIES = 3;

// ==========================================
// 初期化
// ==========================================

function init() {
  createWorker();
  loadTheme();
  loadProgressStyle();
  setupEventListeners();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('storage', handleStorageEvent);
  registerSW();

  if (loadState()) {
    restoreSession();
  }
}

function setupEventListeners() {
  // セット数
  document.querySelectorAll('.set-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.set-btn').forEach(function (b) {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
      totalSets = parseInt(btn.dataset.sets);
    });
  });

  // テーマ選択
  document.querySelectorAll('.theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.theme-btn').forEach(function (b) {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
      setTheme(btn.dataset.theme);
      updateSelectorHeading('.theme-selector .set-heading', 'デザイン', btn.textContent);
    });
  });

  // プログレス選択
  document.querySelectorAll('.progress-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.progress-btn').forEach(function (b) {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
      setProgressStyle(btn.dataset.progress);
      updateSelectorHeading('.progress-selector .set-heading', 'プログレス', btn.textContent);
    });
  });

  document.getElementById('btn-start').addEventListener('click', startSession);

  // 集中モード切替
  document.querySelector('#screen-timer .timer-content').addEventListener('click', function (e) {
    if (e.target.closest('button')) return;
    focusMode = !focusMode;
    document.getElementById('screen-timer').classList.toggle('focus-mode', focusMode);
  });

  // 集中モード情報トグル
  document.getElementById('btn-focus-info').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleFocusInfo();
  });

  document.getElementById('btn-timer-end').addEventListener('click', handleSessionEnd);
  document.getElementById('btn-toilet').addEventListener('click', handleToilet);
  document.getElementById('btn-interrupt').addEventListener('click', handleInterrupt);
  document.getElementById('btn-violation').addEventListener('click', handleViolation);
  document.getElementById('btn-stop').addEventListener('click', handleStop);

  document.getElementById('btn-resume').addEventListener('click', handleToiletResume);
  document.getElementById('btn-toilet-stop').addEventListener('click', handleSessionEnd);

  document.getElementById('btn-return').addEventListener('click', handleReturn);
  document.getElementById('btn-interrupt-stop').addEventListener('click', handleSessionEnd);

  document.getElementById('btn-ban-stop').addEventListener('click', handleSessionEnd);

  document.getElementById('btn-resume-work').addEventListener('click', handleResumeWork);
  document.getElementById('btn-resume-stop').addEventListener('click', handleSessionEnd);

  document.getElementById('btn-restart').addEventListener('click', handleRestart);
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }
}

// ==========================================
// テーマ管理
// ==========================================

function updateSelectorHeading(selector, base, label) {
  var heading = document.querySelector(selector);
  if (heading) heading.textContent = base + '：' + label;
}

function setTheme(theme) {
  currentTheme = theme;
  var timerScreen = document.getElementById('screen-timer');
  var banScreen = document.getElementById('screen-ban');
  ['theme-clean', 'theme-digital', 'theme-neon', 'theme-bold', 'theme-gradient'].forEach(function (cls) {
    timerScreen.classList.remove(cls);
    banScreen.classList.remove(cls);
  });
  timerScreen.classList.add('theme-' + theme);
  banScreen.classList.add('theme-' + theme);
  localStorage.setItem(THEME_KEY, theme);
}

function loadTheme() {
  var saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    currentTheme = saved;
    document.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.classList.toggle('selected', btn.dataset.theme === saved);
    });
  }
  setTheme(currentTheme);
}

// ==========================================
// プログレススタイル管理
// ==========================================

function setProgressStyle(style) {
  currentProgress = style;
  var timerScreen = document.getElementById('screen-timer');
  ['progress-frame', 'progress-bar', 'progress-color', 'progress-blocks', 'progress-hourglass'].forEach(function (cls) {
    timerScreen.classList.remove(cls);
  });
  timerScreen.classList.add('progress-' + style);
  localStorage.setItem(PROGRESS_KEY, style);

  // カラーシフトでない場合、インラインスタイルをリセット
  if (style !== 'color') {
    resetColorShift();
  }

  // ブロック初期化
  if (style === 'blocks') {
    initBlocks();
  }
}

function loadProgressStyle() {
  var saved = localStorage.getItem(PROGRESS_KEY);
  if (saved) {
    currentProgress = saved;
    document.querySelectorAll('.progress-btn').forEach(function (btn) {
      btn.classList.toggle('selected', btn.dataset.progress === saved);
    });
  }
  setProgressStyle(currentProgress);
}

// ==========================================
// 状態永続化
// ==========================================

function saveState() {
  var data = {
    state: state,
    cycle: cycle,
    currentSet: currentSet,
    totalSets: totalSets,
    targetEndTime: targetEndTime,
    preNotified: preNotified,
    savedState: savedState,
    savedRemaining: savedRemaining,
    workElapsedAtInterrupt: workElapsedAtInterrupt,
    currentPhaseDuration: currentPhaseDuration
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadState() {
  var raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    var data = JSON.parse(raw);
    state = data.state || 'idle';
    cycle = data.cycle || 1;
    currentSet = data.currentSet || 1;
    totalSets = data.totalSets || 1;
    targetEndTime = data.targetEndTime || 0;
    preNotified = data.preNotified || false;
    savedState = data.savedState || null;
    savedRemaining = data.savedRemaining || 0;
    workElapsedAtInterrupt = data.workElapsedAtInterrupt || 0;
    currentPhaseDuration = data.currentPhaseDuration || 0;
    return state !== 'idle';
  } catch (e) {
    return false;
  }
}

function clearSavedState() {
  localStorage.removeItem(STORAGE_KEY);
}

// ==========================================
// 音声
// ==========================================

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function ensureAudio() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
    audioCtx.resume();
  }
}

function playTone(freq, duration, volume, delay) {
  ensureAudio();
  if (!audioCtx || audioCtx.state !== 'running') return;
  var startTime = audioCtx.currentTime + (delay || 0);
  var osc = audioCtx.createOscillator();
  var gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playPreSound() {
  playTone(523, 0.4, 0.2, 0);
}

function playCompleteSound() {
  playTone(880, 0.2, 0.4, 0);
  playTone(880, 0.2, 0.4, 0.3);
  playTone(880, 0.2, 0.4, 0.6);
}

// ==========================================
// バイブレーション
// ==========================================

function vibrateOnce() {
  if (navigator.vibrate) navigator.vibrate(200);
}

function vibrateThrice() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

// ==========================================
// 通知
// ==========================================

function preNotify() {
  if (catchingUp) return;
  playPreSound();
  vibrateOnce();
  showOSNotification('松村式ポモドーロ', getPreNotifyMessage());
}

function completeNotify() {
  if (catchingUp) return;
  playCompleteSound();
  vibrateThrice();
  showOSNotification('松村式ポモドーロ', getCompleteNotifyMessage());
}

function getPreNotifyMessage() {
  var labels = {
    working: '作業終了まであと1分',
    short_break: '休憩終了まであと1分',
    long_break: '長休憩終了まであと1分',
    interrupt_break: '休憩終了まであと1分',
    banned: '禁止終了まであと1分'
  };
  return labels[state] || 'あと1分';
}

function getCompleteNotifyMessage() {
  var messages = {
    working: '作業完了 — 休憩に入ります',
    short_break: '休憩完了 — 作業開始',
    long_break: '長休憩完了',
    interrupt_break: '休憩完了 — 作業やり直し',
    banned: '使用禁止終了'
  };
  return messages[state] || '';
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showOSNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body: body, icon: 'icon.svg', tag: 'pomodoro' });
  } catch (e) {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then(function (reg) {
        reg.showNotification(title, { body: body, icon: 'icon.svg', tag: 'pomodoro' });
      });
    }
  }
}

// ==========================================
// Wake Lock
// ==========================================

function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(function (lock) {
    wakeLock = lock;
    wakeLock.addEventListener('release', function () { wakeLock = null; });
  }).catch(function () {});
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// ==========================================
// 画面管理
// ==========================================

function showScreen(id) {
  ensureAudio();
  clearStopConfirm();
  clearViolationConfirm();
  clearSessionEndConfirm();
  document.querySelectorAll('.screen').forEach(function (s) {
    s.classList.remove('active');
  });
  document.getElementById(id).classList.add('active');
}

function clearStopConfirm() {
  if (stopConfirmTimeout) clearTimeout(stopConfirmTimeout);
  stopPending = false;
  var btn = document.getElementById('btn-stop');
  if (btn) {
    btn.textContent = '停止';
    btn.classList.remove('stop-confirm');
  }
}

function clearViolationConfirm() {
  if (violationConfirmTimeout) clearTimeout(violationConfirmTimeout);
  violationPending = false;
  var btn = document.getElementById('btn-violation');
  if (btn) {
    btn.textContent = '違反';
    btn.classList.remove('violation-confirm');
  }
}

function clearSessionEndConfirm() {
  if (sessionEndTimeout) clearTimeout(sessionEndTimeout);
  sessionEndPending = false;
  if (activeSessionEndBtn) {
    activeSessionEndBtn.textContent = 'セッションを終了';
    activeSessionEndBtn.classList.remove('stop-confirm');
    activeSessionEndBtn = null;
  }
}

// ==========================================
// 表示更新
// ==========================================

function formatTime(sec) {
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateTimerDisplay() {
  document.getElementById('timer-display').textContent = formatTime(remaining);
}

function updateBanDisplay() {
  document.getElementById('ban-timer').textContent = formatTime(remaining);
}

function updateCycleDots() {
  var container = document.getElementById('cycle-dots');
  container.innerHTML = '';
  for (var i = 1; i <= CYCLES_PER_SET; i++) {
    var dot = document.createElement('span');
    if (i < cycle) {
      dot.className = 'dot completed';
    } else if (i === cycle && (state === 'short_break' || state === 'long_break')) {
      dot.className = 'dot completed';
    } else if (i === cycle) {
      dot.className = 'dot active';
    } else {
      dot.className = 'dot';
    }
    container.appendChild(dot);
  }
}

function updateUI() {
  var timerScreen = document.getElementById('screen-timer');

  var classes = Array.from(timerScreen.classList);
  classes.forEach(function (c) {
    if (c.indexOf('state-') === 0) timerScreen.classList.remove(c);
  });
  timerScreen.classList.add('state-' + state);

  var labels = {
    working: '作業中',
    short_break: '休憩中',
    long_break: '長休憩中',
    interrupt_break: '中断後の休憩'
  };
  document.getElementById('state-label').textContent = labels[state] || '';

  document.getElementById('cycle-label').textContent =
    'サイクル ' + cycle + ' / ' + CYCLES_PER_SET;

  if (totalSets === 0) {
    document.getElementById('set-label').textContent = 'セット ' + currentSet;
  } else {
    document.getElementById('set-label').textContent =
      'セット ' + currentSet + ' / ' + totalSets;
  }

  updateCycleDots();

  var isWorking = state === 'working';
  document.getElementById('btn-toilet').hidden = !isWorking;
  document.getElementById('btn-interrupt').hidden = !isWorking;
  document.getElementById('violation-row').hidden = !isWorking;
  document.getElementById('btn-stop').hidden = !isWorking;
  document.getElementById('btn-timer-end').hidden = isWorking;
  document.getElementById('break-reminder').hidden = isWorking;

  updateTimerDisplay();
  updateProgress();
  updateFocusInfo();
}

// ==========================================
// プログレス更新（統合ディスパッチャ）
// ==========================================

function updateProgress() {
  switch (currentProgress) {
    case 'frame': updateProgressFrame(); break;
    case 'bar': updateProgressBar(); break;
    case 'color': updateColorShift(); break;
    case 'blocks': updateBlockProgress(); break;
    case 'hourglass': updateHourglass(); break;
  }
}

// --- フレーム ---
function updateProgressFrame() {
  var frameEl = document.getElementById('timer-frame-progress');
  if (!frameEl) return;
  var progress = currentPhaseDuration > 0 ? remaining / currentPhaseDuration : 1;
  var offset = 100 * (1 - Math.max(0, Math.min(1, progress)));
  frameEl.style.strokeDasharray = '100';
  frameEl.style.strokeDashoffset = offset;
  if (remaining <= PRE_NOTIFY_SEC && remaining > 0) {
    frameEl.classList.add('last-minute');
  } else {
    frameEl.classList.remove('last-minute');
  }
}

// --- バー ---
function updateProgressBar() {
  var fill = document.getElementById('progress-bar-fill');
  if (!fill) return;
  var progress = currentPhaseDuration > 0 ? remaining / currentPhaseDuration : 1;
  fill.style.width = (Math.max(0, Math.min(1, progress)) * 100) + '%';
}

// --- カラーシフト ---
function updateColorShift() {
  var display = document.getElementById('timer-display');
  if (!display) return;
  var progress = currentPhaseDuration > 0 ? remaining / currentPhaseDuration : 1;
  var color = getShiftColor(progress);
  display.style.color = color;
  display.style.webkitTextFillColor = color;
  display.style.background = 'none';
}

function getShiftColor(progress) {
  progress = Math.max(0, Math.min(1, progress));
  var hue;
  if (progress > 0.3) {
    var t = (progress - 0.3) / 0.7;
    hue = 40 + t * 185;
  } else {
    var t = progress / 0.3;
    hue = t * 40;
  }
  return 'hsl(' + Math.round(hue) + ', 75%, 52%)';
}

function resetColorShift() {
  var display = document.getElementById('timer-display');
  if (!display) return;
  display.style.color = '';
  display.style.webkitTextFillColor = '';
  display.style.background = '';
}

// --- ブロック ---
function initBlocks() {
  var container = document.getElementById('progress-blocks');
  if (!container || container.children.length === BLOCK_COUNT) return;
  container.innerHTML = '';
  blockElements = [];
  for (var i = 0; i < BLOCK_COUNT; i++) {
    var block = document.createElement('span');
    block.className = 'progress-block';
    container.appendChild(block);
    blockElements.push(block);
  }
}

function updateBlockProgress() {
  if (blockElements.length === 0) initBlocks();
  var progress = currentPhaseDuration > 0 ? remaining / currentPhaseDuration : 1;
  var visible = Math.ceil(BLOCK_COUNT * Math.max(0, Math.min(1, progress)));
  for (var i = 0; i < BLOCK_COUNT; i++) {
    blockElements[i].classList.toggle('block-empty', i >= visible);
  }
}

// --- ネオン砂時計 ---
function updateHourglass() {
  var progress = currentPhaseDuration > 0 ? remaining / currentPhaseDuration : 1;
  progress = Math.max(0, Math.min(1, progress));

  var sandTop = document.getElementById('hg-sand-top');
  var sandBottom = document.getElementById('hg-sand-bottom');
  var stream = document.getElementById('hg-stream');

  if (!sandTop || !sandBottom) return;

  var topH = 47 * progress;
  sandTop.setAttribute('y', 5 + 47 - topH);
  sandTop.setAttribute('height', topH);

  var bottomH = 47 * (1 - progress);
  sandBottom.setAttribute('y', 115 - bottomH);
  sandBottom.setAttribute('height', bottomH);

  if (stream) {
    stream.style.opacity = (progress > 0.01 && progress < 0.99) ? '0.4' : '0';
  }
}

// --- BAN画面フレーム（常にフレーム使用） ---
function updateBanFrame() {
  var frameEl = document.getElementById('ban-frame-progress');
  if (!frameEl) return;
  var progress = BAN_SEC > 0 ? remaining / BAN_SEC : 1;
  var offset = 100 * (1 - Math.max(0, Math.min(1, progress)));
  frameEl.style.strokeDasharray = '100';
  frameEl.style.strokeDashoffset = offset;
  if (remaining <= PRE_NOTIFY_SEC && remaining > 0) {
    frameEl.classList.add('last-minute');
  } else {
    frameEl.classList.remove('last-minute');
  }
}

// ==========================================
// 集中モード情報トグル
// ==========================================

function toggleFocusInfo() {
  focusInfoVisible = !focusInfoVisible;
  updateFocusInfo();
}

function updateFocusInfo() {
  var btn = document.getElementById('btn-focus-info');
  if (!btn) return;
  if (focusInfoVisible) {
    var setText = totalSets === 0
      ? currentSet + 'セット目'
      : currentSet + '/' + totalSets + 'セット';
    btn.textContent = setText + ' ' + cycle + '/' + CYCLES_PER_SET + '周目';
  } else {
    btn.textContent = '\u2139';
  }
}

// ==========================================
// タイマー制御
// ==========================================

function startTimer(duration) {
  if (catchingUp) {
    targetEndTime = targetEndTime + duration * 1000;
  } else {
    targetEndTime = Date.now() + duration * 1000;
  }
  remaining = duration;
  preNotified = false;
  saveState();
  if (!catchingUp) {
    if (worker) {
      worker.postMessage({ action: 'start', duration: duration });
      startWatchdog();
    } else {
      startFallbackTimer();
    }
  }
}

function stopWorkerTimer() {
  if (worker) worker.postMessage({ action: 'stop' });
  clearWatchdog();
  clearFallbackTimer();
}

// ==========================================
// Worker メッセージ
// ==========================================

function onWorkerMessage(e) {
  var data = e.data;
  lastTickTime = Date.now();

  if (data.type === 'tick') {
    if (remaining === data.remaining) return;
    remaining = data.remaining;
    if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
      preNotified = true;
      preNotify();
      saveState();
    }
    if (state === 'banned') {
      updateBanDisplay();
      updateBanFrame();
    } else {
      updateTimerDisplay();
      updateProgress();
    }
  }

  if (data.type === 'complete') {
    completeNotify();
    onTimerComplete();
  }
}

// ==========================================
// タイマー完了
// ==========================================

function onTimerComplete() {
  switch (state) {
    case 'working':
      if (cycle < CYCLES_PER_SET) {
        startShortBreak();
      } else {
        startLongBreak();
      }
      break;

    case 'short_break':
      cycle++;
      startWork();
      break;

    case 'interrupt_break':
      startWork();
      break;

    case 'long_break':
      if (totalSets === 0 || currentSet < totalSets) {
        currentSet++;
        cycle = 1;
        startWork();
      } else {
        state = 'completed';
        targetEndTime = 0;
        saveState();
        if (!catchingUp) {
          showScreen('screen-complete');
          releaseWakeLock();
        }
      }
      break;

    case 'banned':
      state = 'ready';
      targetEndTime = 0;
      saveState();
      if (!catchingUp) {
        document.getElementById('resume-info').textContent =
          'セット ' + currentSet + ' - サイクル ' + cycle;
        showScreen('screen-resume');
      }
      break;
  }
}

// ==========================================
// セッション開始
// ==========================================

function startSession() {
  initAudio();
  requestWakeLock();
  requestNotificationPermission();
  cycle = 1;
  currentSet = 1;
  startWork();
}

function startWork() {
  state = 'working';
  remaining = WORK_SEC;
  currentPhaseDuration = WORK_SEC;
  if (!catchingUp) {
    showScreen('screen-timer');
    updateUI();
  }
  startTimer(WORK_SEC);
}

function startShortBreak() {
  state = 'short_break';
  remaining = SHORT_BREAK_SEC;
  currentPhaseDuration = SHORT_BREAK_SEC;
  if (!catchingUp) updateUI();
  startTimer(SHORT_BREAK_SEC);
}

function startLongBreak() {
  state = 'long_break';
  remaining = LONG_BREAK_SEC;
  currentPhaseDuration = LONG_BREAK_SEC;
  if (!catchingUp) updateUI();
  startTimer(LONG_BREAK_SEC);
}

function startBan() {
  state = 'banned';
  remaining = BAN_SEC;
  currentPhaseDuration = BAN_SEC;
  if (!catchingUp) {
    showScreen('screen-ban');
    updateBanDisplay();
    updateBanFrame();
  }
  startTimer(BAN_SEC);
}

// ==========================================
// トイレ中断
// ==========================================

function handleToilet() {
  if (state !== 'working') return;
  savedState = state;
  savedRemaining = remaining;
  state = 'toilet';
  targetEndTime = 0;
  stopWorkerTimer();
  saveState();
  showScreen('screen-toilet');
}

function handleToiletResume() {
  var rem = savedRemaining;
  state = savedState;
  preNotified = rem <= PRE_NOTIFY_SEC;
  savedState = null;
  savedRemaining = 0;
  remaining = rem;
  showScreen('screen-timer');
  updateUI();
  startTimer(rem);
}

// ==========================================
// 外的中断
// ==========================================

function handleInterrupt() {
  if (state !== 'working') return;
  workElapsedAtInterrupt = WORK_SEC - remaining;
  state = 'interrupted';
  targetEndTime = 0;
  stopWorkerTimer();
  saveState();
  showScreen('screen-interrupt');
  document.getElementById('interrupt-elapsed').textContent =
    '作業経過: ' + formatTime(workElapsedAtInterrupt);
  updateInterruptActionText();
}

function updateInterruptActionText() {
  var actionText;
  if (workElapsedAtInterrupt <= 5 * 60) {
    actionText = '戻ると: 休憩なしでやり直し';
  } else if (workElapsedAtInterrupt <= 20 * 60) {
    actionText = '戻ると: 5:30の休憩後、やり直し';
  } else {
    actionText = '戻ると: 続きから再開';
  }
  document.getElementById('interrupt-action').textContent = actionText;
}

function handleReturn() {
  var elapsed = workElapsedAtInterrupt;
  workElapsedAtInterrupt = 0;

  if (elapsed >= WORK_SEC) {
    state = 'working';
    onTimerComplete();
  } else if (elapsed <= 5 * 60) {
    startWork();
  } else if (elapsed <= 20 * 60) {
    state = 'interrupt_break';
    remaining = SHORT_BREAK_SEC;
    currentPhaseDuration = SHORT_BREAK_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(SHORT_BREAK_SEC);
  } else {
    state = 'working';
    var rem = WORK_SEC - elapsed;
    remaining = rem;
    currentPhaseDuration = WORK_SEC;
    preNotified = rem <= PRE_NOTIFY_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(rem);
  }
}

// ==========================================
// 違反
// ==========================================

function handleViolation() {
  if (state !== 'working') return;
  var btn = document.getElementById('btn-violation');
  if (violationPending) {
    clearTimeout(violationConfirmTimeout);
    violationPending = false;
    btn.textContent = '違反';
    btn.classList.remove('violation-confirm');
    stopWorkerTimer();
    startBan();
  } else {
    violationPending = true;
    btn.textContent = '本当に違反？';
    btn.classList.add('violation-confirm');
    violationConfirmTimeout = setTimeout(function () {
      violationPending = false;
      btn.textContent = '違反';
      btn.classList.remove('violation-confirm');
    }, 3000);
  }
}

// ==========================================
// 停止
// ==========================================

function handleStop() {
  if (state === 'short_break' || state === 'long_break' || state === 'interrupt_break') return;
  var btn = document.getElementById('btn-stop');
  if (stopPending) {
    clearTimeout(stopConfirmTimeout);
    stopPending = false;
    stopWorkerTimer();
    resetToIdle();
  } else {
    stopPending = true;
    btn.textContent = 'もう一度タップで停止';
    btn.classList.add('stop-confirm');
    stopConfirmTimeout = setTimeout(function () {
      stopPending = false;
      btn.textContent = '停止';
      btn.classList.remove('stop-confirm');
    }, 3000);
  }
}

function handleSessionEnd(e) {
  var btn = e.currentTarget;
  if (sessionEndPending && activeSessionEndBtn === btn) {
    clearSessionEndConfirm();
    if (btn.id === 'btn-ban-stop' || btn.id === 'btn-timer-end') stopWorkerTimer();
    resetToIdle();
  } else {
    clearSessionEndConfirm();
    sessionEndPending = true;
    activeSessionEndBtn = btn;
    btn.textContent = 'もう一度タップで終了';
    btn.classList.add('stop-confirm');
    sessionEndTimeout = setTimeout(function () {
      clearSessionEndConfirm();
    }, 3000);
  }
}

function resetToIdle() {
  state = 'idle';
  cycle = 1;
  currentSet = 1;
  remaining = 0;
  targetEndTime = 0;
  preNotified = false;
  savedState = null;
  savedRemaining = 0;
  workElapsedAtInterrupt = 0;
  stopPending = false;
  violationPending = false;
  sessionEndPending = false;
  catchingUp = false;
  currentPhaseDuration = 0;
  focusMode = false;
  focusInfoVisible = false;
  document.getElementById('screen-timer').classList.remove('focus-mode');
  resetColorShift();
  workerRetryCount = 0;
  if (workerStableTimeout) { clearTimeout(workerStableTimeout); workerStableTimeout = null; }
  clearSavedState();
  clearWatchdog();
  clearFallbackTimer();
  releaseWakeLock();
  clearStopConfirm();
  clearViolationConfirm();
  clearSessionEndConfirm();
  showScreen('screen-setup');
}

// ==========================================
// 再スタート
// ==========================================

function handleRestart() {
  resetToIdle();
}

function handleResumeWork() {
  initAudio();
  requestWakeLock();
  startWork();
}

// ==========================================
// バックグラウンド復帰
// ==========================================

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    if (state !== 'idle') saveState();
    return;
  }
  ensureAudio();
  if (state === 'idle' || state === 'completed') return;
  requestWakeLock();
  if (state === 'toilet' || state === 'interrupted' || state === 'ready') return;
  if (!targetEndTime) return;
  stopWorkerTimer();
  recoverTimerState();
}

function recoverTimerState() {
  if (!targetEndTime) {
    resetToIdle();
    return;
  }

  var missedMs = Date.now() - targetEndTime;

  if (missedMs > ABANDON_MS) {
    resetToIdle();
    return;
  }

  if (missedMs > 0) {
    var stateBeforeCatchUp = state;
    var cycleBeforeCatchUp = cycle;
    catchingUp = true;
    try {
      var safety = 0;
      while (targetEndTime && Date.now() >= targetEndTime && safety < 20) {
        onTimerComplete();
        if (state === 'idle' || state === 'completed' || state === 'ready') break;
        safety++;
      }
    } finally {
      catchingUp = false;
    }

    var transitioned = (state !== stateBeforeCatchUp || cycle !== cycleBeforeCatchUp);

    if (targetEndTime && Date.now() < targetEndTime) {
      remaining = Math.max(1, Math.ceil((targetEndTime - Date.now()) / 1000));
      if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
        preNotified = true;
        preNotify();
      }
      showCurrentScreen();
      if (worker) worker.postMessage({ action: 'start', duration: remaining });
      startWatchdog();
    } else {
      showCurrentScreen();
    }

    if (transitioned && state !== 'idle' && state !== 'completed') {
      playCompleteSound();
      vibrateThrice();
    }
  } else {
    remaining = Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
    if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
      preNotified = true;
      preNotify();
    }
    showCurrentScreen();
    if (worker) worker.postMessage({ action: 'start', duration: remaining });
    startWatchdog();
  }
}

function showCurrentScreen() {
  switch (state) {
    case 'idle':
      showScreen('screen-setup');
      break;
    case 'completed':
      showScreen('screen-complete');
      releaseWakeLock();
      break;
    case 'ready':
      document.getElementById('resume-info').textContent =
        'セット ' + currentSet + ' - サイクル ' + cycle;
      showScreen('screen-resume');
      break;
    case 'banned':
      showScreen('screen-ban');
      updateBanDisplay();
      updateBanFrame();
      break;
    default:
      showScreen('screen-timer');
      updateUI();
      break;
  }
}

// ==========================================
// セッション復元
// ==========================================

function restoreSession() {
  initAudio();
  requestWakeLock();
  switch (state) {
    case 'toilet':
      showScreen('screen-toilet');
      break;
    case 'interrupted':
      showScreen('screen-interrupt');
      document.getElementById('interrupt-elapsed').textContent =
        '作業経過: ' + formatTime(workElapsedAtInterrupt);
      updateInterruptActionText();
      break;
    case 'ready':
      document.getElementById('resume-info').textContent =
        'セット ' + currentSet + ' - サイクル ' + cycle;
      showScreen('screen-resume');
      break;
    case 'completed':
      showScreen('screen-complete');
      break;
    default:
      recoverTimerState();
      break;
  }
}

// ==========================================
// Worker管理
// ==========================================

function createWorker() {
  try { if (worker) worker.terminate(); } catch (e) {}
  try {
    worker = new Worker('timer-worker.js');
    worker.onmessage = function (e) {
      if (workerRetryCount > 0 && !workerStableTimeout) {
        workerStableTimeout = setTimeout(function () {
          workerRetryCount = 0;
          workerStableTimeout = null;
        }, 30000);
      }
      onWorkerMessage(e);
    };
    worker.onerror = function () {
      if (workerStableTimeout) { clearTimeout(workerStableTimeout); workerStableTimeout = null; }
      workerRetryCount++;
      if (workerRetryCount <= MAX_WORKER_RETRIES) {
        createWorker();
        restartActiveTimer();
      } else {
        worker = null;
        startFallbackTimer();
      }
    };
  } catch (e) {
    worker = null;
    startFallbackTimer();
  }
}

function restartActiveTimer() {
  if (!worker) return;
  if (targetEndTime && Date.now() < targetEndTime) {
    var rem = Math.max(1, Math.ceil((targetEndTime - Date.now()) / 1000));
    remaining = rem;
    worker.postMessage({ action: 'start', duration: rem });
    startWatchdog();
  }
}

function startWatchdog() {
  clearWatchdog();
  lastTickTime = Date.now();
  watchdogId = setInterval(function () {
    if (targetEndTime && Date.now() < targetEndTime && Date.now() - lastTickTime > 5000) {
      if (workerRetryCount >= MAX_WORKER_RETRIES) {
        clearWatchdog();
        startFallbackTimer();
      } else {
        createWorker();
        restartActiveTimer();
      }
    }
  }, 5000);
}

function clearWatchdog() {
  if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
}

// ==========================================
// フォールバックタイマー
// ==========================================

function startFallbackTimer() {
  clearFallbackTimer();
  if (!targetEndTime || Date.now() >= targetEndTime) return;
  fallbackId = setInterval(function () {
    if (!targetEndTime) { clearFallbackTimer(); return; }
    var rem = Math.max(0, Math.ceil((targetEndTime - Date.now()) / 1000));
    remaining = rem;
    lastTickTime = Date.now();
    if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
      preNotified = true;
      preNotify();
      saveState();
    }
    if (state === 'banned') { updateBanDisplay(); updateBanFrame(); }
    else { updateTimerDisplay(); updateProgress(); }
    if (rem <= 0) {
      clearFallbackTimer();
      completeNotify();
      onTimerComplete();
    }
  }, 1000);
}

function clearFallbackTimer() {
  if (fallbackId) { clearInterval(fallbackId); fallbackId = null; }
}

// ==========================================
// 複数タブ検出
// ==========================================

function handleStorageEvent(e) {
  if (e.key === STORAGE_KEY && state !== 'idle') {
    try { stopWorkerTimer(); } catch (err) {}
    clearWatchdog();
    clearFallbackTimer();
    state = 'idle';
    cycle = 1;
    currentSet = 1;
    remaining = 0;
    targetEndTime = 0;
    preNotified = false;
    savedState = null;
    savedRemaining = 0;
    workElapsedAtInterrupt = 0;
    stopPending = false;
    violationPending = false;
    sessionEndPending = false;
    catchingUp = false;
    currentPhaseDuration = 0;
    focusMode = false;
    focusInfoVisible = false;
    workerRetryCount = 0;
    document.getElementById('screen-timer').classList.remove('focus-mode');
    resetColorShift();
    releaseWakeLock();
    clearStopConfirm();
    clearViolationConfirm();
    clearSessionEndConfirm();
    showScreen('screen-setup');
  }
}

// ==========================================
// 起動
// ==========================================

document.addEventListener('DOMContentLoaded', init);
