// ==========================================
// 松村式ポモドーロタイマー v2
// ==========================================

// --- 定数 ---
const WORK_SEC = 25 * 60;
const SHORT_BREAK_SEC = 5 * 60 + 30;
const LONG_BREAK_SEC = 25 * 60;
const BAN_SEC = 3 * 60;
const PRE_NOTIFY_SEC = 60;
const CYCLES_PER_SET = 4;
const STORAGE_KEY = 'matsumura-pomodoro';
const ABANDON_MS = 2 * 60 * 60 * 1000; // 2時間以上放置で破棄

// --- 状態 ---
let state = 'idle';
let cycle = 1;
let currentSet = 1;
let totalSets = 1;
let remaining = 0;
let targetEndTime = 0;
let preNotified = false;
let catchingUp = false;

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

// セッション終了ダブルタップ確認（サブ画面共通）
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
const MAX_WORKER_RETRIES = 3;

// ==========================================
// 初期化
// ==========================================

function init() {
  createWorker();
  setupEventListeners();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('storage', handleStorageEvent);
  registerSW();

  if (loadState()) {
    restoreSession();
  }
}

function setupEventListeners() {
  // セットアップ画面
  document.querySelectorAll('.set-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.set-btn').forEach(function (b) {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
      totalSets = parseInt(btn.dataset.sets);
    });
  });

  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-test-notify').addEventListener('click', testNotification);

  // タイマー画面
  document.getElementById('btn-toilet').addEventListener('click', handleToilet);
  document.getElementById('btn-interrupt').addEventListener('click', handleInterrupt);
  document.getElementById('btn-violation').addEventListener('click', handleViolation);
  document.getElementById('btn-stop').addEventListener('click', handleStop);

  // トイレ画面
  document.getElementById('btn-resume').addEventListener('click', handleToiletResume);
  document.getElementById('btn-toilet-stop').addEventListener('click', handleSessionEnd);

  // 中断画面
  document.getElementById('btn-return').addEventListener('click', handleReturn);
  document.getElementById('btn-interrupt-stop').addEventListener('click', handleSessionEnd);

  // BAN画面
  document.getElementById('btn-ban-stop').addEventListener('click', handleSessionEnd);

  // 再開画面
  document.getElementById('btn-resume-work').addEventListener('click', handleResumeWork);
  document.getElementById('btn-resume-stop').addEventListener('click', handleSessionEnd);

  // 完了画面
  document.getElementById('btn-restart').addEventListener('click', handleRestart);
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }
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
    workElapsedAtInterrupt: workElapsedAtInterrupt
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

// 予告音：柔らかい単音
function playPreSound() {
  playTone(523, 0.4, 0.2, 0);
}

// 到達音：3回ビープ（バイブと同期）
function playCompleteSound() {
  playTone(880, 0.2, 0.4, 0);
  playTone(880, 0.2, 0.4, 0.3);
  playTone(880, 0.2, 0.4, 0.6);
}

function testNotification() {
  initAudio();
  requestNotificationPermission();
  var btn = document.getElementById('btn-test-notify');
  btn.textContent = '予告通知...';
  btn.disabled = true;
  playPreSound();
  vibrateOnce();
  setTimeout(function () {
    btn.textContent = '到達通知...';
    playCompleteSound();
    vibrateThrice();
    setTimeout(function () {
      btn.textContent = '通知テスト';
      btn.disabled = false;
    }, 1200);
  }, 1500);
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
// 通知（2段階）
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
  }).catch(function () { /* not available */ });
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

  // state-* クラスの差し替え
  var classes = Array.from(timerScreen.classList);
  classes.forEach(function (c) {
    if (c.indexOf('state-') === 0) timerScreen.classList.remove(c);
  });
  timerScreen.classList.add('state-' + state);

  // 状態ラベル
  var labels = {
    working: '作業中',
    short_break: '休憩中',
    long_break: '長休憩中',
    interrupt_break: '中断後の休憩'
  };
  document.getElementById('state-label').textContent = labels[state] || '';

  // サイクル
  document.getElementById('cycle-label').textContent =
    'サイクル ' + cycle + ' / ' + CYCLES_PER_SET;

  // セット
  if (totalSets === 0) {
    document.getElementById('set-label').textContent = 'セット ' + currentSet;
  } else {
    document.getElementById('set-label').textContent =
      'セット ' + currentSet + ' / ' + totalSets;
  }

  // ドット
  updateCycleDots();

  // ボタン表示（休憩中は全て非表示 = 強制・解除不可）
  var isWorking = state === 'working';
  document.getElementById('btn-toilet').hidden = !isWorking;
  document.getElementById('btn-interrupt').hidden = !isWorking;
  document.getElementById('violation-row').hidden = !isWorking;
  document.getElementById('btn-stop').hidden = !isWorking;
  document.getElementById('break-reminder').hidden = isWorking;

  updateTimerDisplay();
}

// ==========================================
// タイマー制御
// ==========================================

function startTimer(duration) {
  if (catchingUp) {
    // キャッチアップ中は前回の終了時刻から連鎖
    targetEndTime = targetEndTime + duration * 1000;
  } else {
    targetEndTime = Date.now() + duration * 1000;
  }
  remaining = duration;
  preNotified = false;
  saveState();
  if (!catchingUp && worker) {
    worker.postMessage({ action: 'start', duration: duration });
    startWatchdog();
  }
}

function stopWorkerTimer() {
  if (worker) worker.postMessage({ action: 'stop' });
  clearWatchdog();
}

// ==========================================
// Worker メッセージ
// ==========================================

function onWorkerMessage(e) {
  var data = e.data;
  lastTickTime = Date.now();

  if (data.type === 'tick') {
    remaining = data.remaining;
    if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
      preNotified = true;
      preNotify();
      saveState();
    }
    if (state === 'banned') {
      updateBanDisplay();
    } else {
      updateTimerDisplay();
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
  if (!catchingUp) {
    showScreen('screen-timer');
    updateUI();
  }
  startTimer(WORK_SEC);
}

function startShortBreak() {
  state = 'short_break';
  remaining = SHORT_BREAK_SEC;
  if (!catchingUp) updateUI();
  startTimer(SHORT_BREAK_SEC);
}

function startLongBreak() {
  state = 'long_break';
  remaining = LONG_BREAK_SEC;
  if (!catchingUp) updateUI();
  startTimer(LONG_BREAK_SEC);
}

function startBan() {
  state = 'banned';
  remaining = BAN_SEC;
  if (!catchingUp) {
    showScreen('screen-ban');
    updateBanDisplay();
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
// 外的中断（緊急中断）
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
    // 作業は実質完了扱い
    state = 'working';
    onTimerComplete();
  } else if (elapsed <= 5 * 60) {
    startWork();
  } else if (elapsed <= 20 * 60) {
    state = 'interrupt_break';
    remaining = SHORT_BREAK_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(SHORT_BREAK_SEC);
  } else {
    state = 'working';
    var rem = WORK_SEC - elapsed;
    remaining = rem;
    preNotified = rem <= PRE_NOTIFY_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(rem);
  }
}

// ==========================================
// 内的中断（違反） ダブルタップ確認
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
// 停止（ダブルタップ確認）
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
    // BAN画面はタイマー動作中なので停止が必要
    if (btn.id === 'btn-ban-stop') stopWorkerTimer();
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
  workerRetryCount = 0;
  clearSavedState();
  clearWatchdog();
  releaseWakeLock();
  clearStopConfirm();
  clearViolationConfirm();
  clearSessionEndConfirm();
  showScreen('screen-setup');
}

// ==========================================
// 再スタート・再開
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
  if (document.visibilityState !== 'visible') return;
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

  // 2時間以上放置はセッション破棄
  if (missedMs > ABANDON_MS) {
    resetToIdle();
    return;
  }

  if (missedMs > 0) {
    // タイマー完了をキャッチアップ
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

    // まだタイマーが動くべき状態ならremainingを更新してからUI表示
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

    // 復帰通知（状態遷移が発生した場合のみ）
    if (transitioned && state !== 'idle' && state !== 'completed') {
      playCompleteSound();
      vibrateThrice();
    }
  } else {
    // タイマーはまだ進行中
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
      break;
    default:
      showScreen('screen-timer');
      updateUI();
      break;
  }
}

// ==========================================
// セッション復元（ページリロード時）
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
  try { if (worker) worker.terminate(); } catch (e) { /* ignore */ }
  try {
    worker = new Worker('timer-worker.js');
    worker.onmessage = function (e) {
      workerRetryCount = 0;
      onWorkerMessage(e);
    };
    worker.onerror = function () {
      workerRetryCount++;
      if (workerRetryCount <= MAX_WORKER_RETRIES) {
        createWorker();
        restartActiveTimer();
      } else {
        worker = null;
      }
    };
  } catch (e) {
    worker = null;
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
      createWorker();
      restartActiveTimer();
    }
  }, 5000);
}

function clearWatchdog() {
  if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
}

// ==========================================
// 複数タブ検出
// ==========================================

function handleStorageEvent(e) {
  if (e.key === STORAGE_KEY && state !== 'idle') {
    // 別タブがセッション状態を変更した — 自タブのみ停止、localStorageは触らない
    try { stopWorkerTimer(); } catch (err) { /* ignore */ }
    clearWatchdog();
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
