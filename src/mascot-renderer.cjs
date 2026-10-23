const mascot = document.getElementById('mascot');
let dragStart;
let dragMoved = false;
let busy = false;
let panelOpen = false;
let idleTimer;
let gestureTimer;
let idleAnimationIndex = 0;
let wakeEnabled = false;
let wakeRecognition;
let wakeRestartTimer;
let wakeCommandTimer;
let wakeBlocked = false;
let wakePaused = false;
let awaitingWakeCommand = false;
let wakeTranscript = '';

function setNormal() {
  document.body.classList.remove('idle-animation', 'idle-walk', 'idle-think', 'idle-talk', 'thinking', 'speaking', 'walking');
  if (!busy) document.body.classList.add('normal');
}

function scheduleIdleAnimation() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (busy || panelOpen || dragStart) return;
    const animations = ['idle-walk', 'idle-think', 'idle-talk'];
    document.body.classList.remove('normal', 'idle-animation', ...animations);
    document.body.classList.add('idle-animation', animations[idleAnimationIndex % animations.length]);
    idleAnimationIndex += 1;
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(setNormal, 2200);
  }, 30000);
}

function sendWakeEvent(type, text = '') {
  window.claudete.sendWakeEvent({ type, text }).catch(() => {});
}

function armWakeCommandTimer(delay = 1800) {
  clearTimeout(wakeCommandTimer);
  wakeCommandTimer = setTimeout(() => {
    if (!awaitingWakeCommand) return;
    sendWakeEvent('complete', wakeTranscript.trim());
    awaitingWakeCommand = false;
    wakeTranscript = '';
  }, delay);
}

function handleWakePhrase(phrase) {
  if (awaitingWakeCommand) {
    wakeTranscript = `${wakeTranscript} ${phrase}`.trim();
    sendWakeEvent('update', wakeTranscript);
    armWakeCommandTimer();
    return;
  }
  const match = phrase.match(/\bclaudete\b[,;:.]?\s*(.*)$/i);
  if (!match) return;
  awaitingWakeCommand = true;
  wakeTranscript = match[1].trim();
  sendWakeEvent('start', wakeTranscript);
  armWakeCommandTimer(wakeTranscript ? 1800 : 6000);
}

function startWakeListener() {
  if (!wakeEnabled || wakeBlocked || wakePaused || wakeRecognition) return;
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechApi) {
    wakeBlocked = true;
    sendWakeEvent('error', 'Este reconhecimento de voz não está disponível nesta instalação do Chromium.');
    return;
  }
  wakeRecognition = new SpeechApi();
  wakeRecognition.lang = 'pt-BR';
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = false;
  wakeRecognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (event.results[index].isFinal) handleWakePhrase(event.results[index][0].transcript.trim());
    }
  };
  wakeRecognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      wakeBlocked = true;
      sendWakeEvent('error', 'O microfone foi bloqueado. Libere o acesso ao microfone para a Claudete no Windows.');
    } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
      sendWakeEvent('error', 'O reconhecimento por voz parou. Confira a conexão e tente reativar a palavra de ativação.');
    }
  };
  wakeRecognition.onend = () => {
    wakeRecognition = null;
    if (wakeEnabled && !wakeBlocked && !wakePaused) {
      clearTimeout(wakeRestartTimer);
      wakeRestartTimer = setTimeout(startWakeListener, 700);
    }
  };
  try { wakeRecognition.start(); }
  catch {
    wakeRecognition = null;
    clearTimeout(wakeRestartTimer);
    wakeRestartTimer = setTimeout(startWakeListener, 1200);
  }
}

function setWakeListenerEnabled(enabled) {
  wakeEnabled = Boolean(enabled);
  wakeBlocked = false;
  clearTimeout(wakeRestartTimer);
  if (wakeEnabled) {
    startWakeListener();
    return;
  }
  clearTimeout(wakeCommandTimer);
  awaitingWakeCommand = false;
  wakeTranscript = '';
  const current = wakeRecognition;
  wakeRecognition = null;
  try { current?.stop(); } catch {}
}

mascot.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  setNormal();
  dragStart = { x: event.screenX, y: event.screenY, lastX: event.screenX, lastY: event.screenY };
  dragMoved = false;
  mascot.setPointerCapture(event.pointerId);
  window.claudete.setDragging(true);
});

mascot.addEventListener('pointerenter', () => {
  window.claudete.setMousePassthrough(false);
});

mascot.addEventListener('pointerleave', () => {
  if (!dragStart) window.claudete.setMousePassthrough(true);
});

mascot.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  if (Math.abs(event.screenX - dragStart.x) + Math.abs(event.screenY - dragStart.y) > 3) dragMoved = true;
  if (!dragMoved) return;
  document.body.classList.remove('normal', 'idle-animation');
  document.body.classList.add('walking');
  dragStart.lastX = event.screenX;
  dragStart.lastY = event.screenY;
});

function finishDrag() {
  if (!dragStart) return;
  const wasDragged = dragMoved;
  dragStart = null;
  window.claudete.setDragging(false);
  window.claudete.setMousePassthrough(false);
  setNormal();
  if (!wasDragged) window.claudete.togglePanel();
}
mascot.addEventListener('pointerup', finishDrag);
mascot.addEventListener('pointercancel', finishDrag);

window.claudete.onPanelState((open) => {
  panelOpen = open;
  if (open) setNormal();
});
window.claudete.onProcess((state) => {
  busy = Boolean(state.running);
  document.body.classList.toggle('working', busy);
  if (busy) document.body.classList.remove('normal', 'idle-animation', 'idle-walk', 'idle-think', 'idle-talk', 'walking');
  else setNormal();
});
window.claudete.onActive((active) => {
  if (!active) setNormal();
});
window.claudete.onDirection((direction) => {
  document.body.classList.toggle('facing-left', direction === 'left');
});
window.claudete.onSpeaking((speaking) => {
  document.body.classList.toggle('speaking', speaking);
  if (speaking) document.body.classList.remove('normal', 'idle-animation', 'idle-walk', 'idle-think', 'idle-talk');
  else setNormal();
  wakePaused = Boolean(speaking);
  if (wakePaused && wakeRecognition) {
    const current = wakeRecognition;
    wakeRecognition = null;
    try { current.stop(); } catch {}
  } else if (!wakePaused) startWakeListener();
});
window.claudete.onWakeEnabled(setWakeListenerEnabled);
document.body.classList.add('normal');
scheduleIdleAnimation();
