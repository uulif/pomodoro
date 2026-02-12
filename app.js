// ==========================================
// 松村式ポモドーロタイマー
// ==========================================

// --- 定数 ---
const WORK_SEC = 25 * 60;
const SHORT_BREAK_SEC = 5 * 60 + 30;
const LONG_BREAK_SEC = 25 * 60;
const BAN_SEC = 3 * 60;
const PRE_NOTIFY_SEC = 60;
const CYCLES_PER_SET = 4;

// --- 状態 ---
let state = 'idle';
let cycle = 1;
let currentSet = 1;
let totalSets = 1;
let remaining = 0;
let preNotified = false;

// トイレ一時停止用
let savedState = null;
let savedRemaining = 0;

// 外的中断用
let workElapsedAtInterrupt = 0;

// 停止確認用
let stopPending = false;
let stopConfirmTimeout = null;

// --- Worker ---
let worker = null;

// --- Audio ---
let audioCtx = null;

// --- Wake Lock ---
let wakeLock = null;

// ==========================================
// 初期化
// ==========================================

function init() {
  worker = new Worker('timer-worker.js');
  worker.onmessage = onWorkerMessage;

  // セット選択ボタン
  document.querySelectorAll('.set-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.set-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      totalSets = parseInt(btn.dataset.sets);
    });
  });

  // メインボタン
  document.getElementById('btn-start').addEventListener('click', startSession);
  document.getElementById('btn-toilet').addEventListener('click', handleToilet);
  document.getElementById('btn-toilet-break').addEventListener('click', handleToilet);
  document.getElementById('btn-interrupt').addEventListener('click', handleInterrupt);
  document.getElementById('btn-violation').addEventListener('click', handleViolation);
  document.getElementById('btn-stop').addEventListener('click', handleStop);
  document.getElementById('btn-resume').addEventListener('click', handleToiletResume);
  document.getElementById('btn-return').addEventListener('click', handleReturn);
  document.getElementById('btn-resume-work').addEventListener('click', handleResumeWork);
  document.getElementById('btn-restart').addEventListener('click', handleRestart);

  // Service Worker 登録
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }
}

// ==========================================
// 音声
// ==========================================

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playTone(freq, duration, volume, delay) {
  if (!audioCtx) return;
  const startTime = audioCtx.currentTime + (delay || 0);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
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
  playTone(523, 0.4, 0.15, 0);
}

function playCompleteSound() {
  playTone(659, 0.2, 0.3, 0);
  playTone(784, 0.2, 0.3, 0.25);
  playTone(1047, 0.35, 0.35, 0.5);
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
  playPreSound();
  vibrateOnce();
}

function completeNotify() {
  playCompleteSound();
  vibrateThrice();
}

// ==========================================
// Wake Lock
// ==========================================

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* Wake Lock not available */ }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// 画面復帰時にWake Lockを再取得
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== 'idle' && state !== 'completed') {
    requestWakeLock();
  }
});

// ==========================================
// 画面切替
// ==========================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ==========================================
// 表示更新
// ==========================================

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateTimerDisplay() {
  document.getElementById('timer-display').textContent = formatTime(remaining);
}

function updateBanDisplay() {
  document.getElementById('ban-timer').textContent = formatTime(remaining);
}

function updateCycleDots() {
  const container = document.getElementById('cycle-dots');
  container.innerHTML = '';
  for (let i = 1; i <= CYCLES_PER_SET; i++) {
    const dot = document.createElement('span');
    if (i < cycle) {
      dot.className = 'dot completed';
    } else if (i === cycle && state !== 'working') {
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
  const timerScreen = document.getElementById('screen-timer');
  timerScreen.className = 'screen active state-' + state;

  // 状態ラベル
  const labels = {
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

  // ボタン表示制御
  const workActions = document.getElementById('work-actions');
  const breakActions = document.getElementById('break-actions');
  const breakReminder = document.getElementById('break-reminder');

  if (state === 'working') {
    workActions.hidden = false;
    breakActions.hidden = true;
    breakReminder.hidden = true;
  } else {
    workActions.hidden = true;
    breakActions.hidden = false;
    breakReminder.hidden = false;
  }

  updateTimerDisplay();
}

// ==========================================
// タイマー制御
// ==========================================

function startTimer(duration) {
  worker.postMessage({ action: 'start', duration: duration });
}

function stopWorkerTimer() {
  worker.postMessage({ action: 'stop' });
}

// ==========================================
// Worker メッセージ処理
// ==========================================

function onWorkerMessage(e) {
  const data = e.data;

  if (data.type === 'tick') {
    remaining = data.remaining;

    if (remaining <= PRE_NOTIFY_SEC && !preNotified) {
      preNotified = true;
      preNotify();
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
// タイマー完了ハンドラ
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
        showScreen('screen-complete');
        releaseWakeLock();
      }
      break;

    case 'banned':
      state = 'ready';
      document.getElementById('resume-info').textContent =
        'セット ' + currentSet + ' - サイクル ' + cycle;
      showScreen('screen-resume');
      break;
  }
}

// ==========================================
// セッション開始
// ==========================================

function startSession() {
  initAudio();
  requestWakeLock();
  cycle = 1;
  currentSet = 1;
  startWork();
}

function startWork() {
  state = 'working';
  preNotified = false;
  remaining = WORK_SEC;
  showScreen('screen-timer');
  updateUI();
  startTimer(WORK_SEC);
}

function startShortBreak() {
  state = 'short_break';
  preNotified = false;
  remaining = SHORT_BREAK_SEC;
  updateUI();
  startTimer(SHORT_BREAK_SEC);
}

function startLongBreak() {
  state = 'long_break';
  preNotified = false;
  remaining = LONG_BREAK_SEC;
  updateUI();
  startTimer(LONG_BREAK_SEC);
}

function startBan() {
  state = 'banned';
  preNotified = false;
  remaining = BAN_SEC;
  showScreen('screen-ban');
  updateBanDisplay();
  startTimer(BAN_SEC);
}

// ==========================================
// トイレ中断
// ==========================================

function handleToilet() {
  savedState = state;
  savedRemaining = remaining;
  stopWorkerTimer();
  showScreen('screen-toilet');
}

function handleToiletResume() {
  state = savedState;
  preNotified = savedRemaining <= PRE_NOTIFY_SEC;
  showScreen('screen-timer');
  updateUI();
  startTimer(savedRemaining);
}

// ==========================================
// 外的中断
// ==========================================

function handleInterrupt() {
  workElapsedAtInterrupt = WORK_SEC - remaining;
  stopWorkerTimer();
  showScreen('screen-interrupt');

  // 経過時間表示
  document.getElementById('interrupt-elapsed').textContent =
    '作業経過: ' + formatTime(workElapsedAtInterrupt);

  // 戻った時の処理を表示
  let actionText;
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
  const elapsed = workElapsedAtInterrupt;

  if (elapsed <= 5 * 60) {
    // 0-5分: 休憩なしでやり直し
    startWork();
  } else if (elapsed <= 20 * 60) {
    // 5-20分: 5:30休憩 → やり直し
    state = 'interrupt_break';
    preNotified = false;
    remaining = SHORT_BREAK_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(SHORT_BREAK_SEC);
  } else {
    // 20分以降: 続きから
    state = 'working';
    remaining = WORK_SEC - elapsed;
    preNotified = remaining <= PRE_NOTIFY_SEC;
    showScreen('screen-timer');
    updateUI();
    startTimer(remaining);
  }
}

// ==========================================
// 内的中断（違反）
// ==========================================

function handleViolation() {
  stopWorkerTimer();
  startBan();
}

// ==========================================
// バン後の再開
// ==========================================

function handleResumeWork() {
  startWork();
}

// ==========================================
// 停止（ダブルタップ確認）
// ==========================================

function handleStop() {
  const btn = document.getElementById('btn-stop');

  if (stopPending) {
    clearTimeout(stopConfirmTimeout);
    stopPending = false;
    stopWorkerTimer();
    resetToIdle();
  } else {
    stopPending = true;
    btn.textContent = 'もう一度タップで停止';
    btn.classList.add('stop-confirm');
    stopConfirmTimeout = setTimeout(() => {
      stopPending = false;
      btn.textContent = '停止';
      btn.classList.remove('stop-confirm');
    }, 3000);
  }
}

function resetToIdle() {
  state = 'idle';
  cycle = 1;
  currentSet = 1;
  remaining = 0;
  preNotified = false;
  releaseWakeLock();
  const btn = document.getElementById('btn-stop');
  btn.textContent = '停止';
  btn.classList.remove('stop-confirm');
  showScreen('screen-setup');
}

// ==========================================
// 完了後の再スタート
// ==========================================

function handleRestart() {
  resetToIdle();
}

// ==========================================
// 起動
// ==========================================

document.addEventListener('DOMContentLoaded', init);
