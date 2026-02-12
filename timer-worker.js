// 松村式ポモドーロ - タイマー Web Worker
// メインスレッドから独立して正確な時間計測を行う

let intervalId = null;
let targetTime = null;

self.onmessage = function (e) {
  const { action, duration, remaining } = e.data;

  switch (action) {
    case 'start':
      clearInterval(intervalId);
      targetTime = Date.now() + duration * 1000;
      intervalId = setInterval(() => {
        const rem = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
        self.postMessage({ type: 'tick', remaining: rem });
        if (rem <= 0) {
          clearInterval(intervalId);
          intervalId = null;
          self.postMessage({ type: 'complete' });
        }
      }, 100);
      break;

    case 'stop':
      clearInterval(intervalId);
      intervalId = null;
      break;

    case 'resume':
      clearInterval(intervalId);
      targetTime = Date.now() + remaining * 1000;
      intervalId = setInterval(() => {
        const rem = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
        self.postMessage({ type: 'tick', remaining: rem });
        if (rem <= 0) {
          clearInterval(intervalId);
          intervalId = null;
          self.postMessage({ type: 'complete' });
        }
      }, 100);
      break;
  }
};
