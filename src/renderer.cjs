const byId = (id) => document.getElementById(id);
let currentMode = 'message';
let running = false;
let recognition;
let micHeld = false;
let stopRequested = false;
let voiceError = '';
let baseText = '';
let finalTranscript = '';
let statusTimer;
let selectedSession = null;
let attachments = [];
let wakeWordEnabled = false;

function renderWakeOption() {
  byId('wake-label').textContent = `${wakeWordEnabled ? 'Desativar' : 'Ativar'} palavra de ativação: Claudete`;
}

function appendChatMessage(role, text) {
  const message = document.createElement('article');
  message.className = `chat-message ${role}`;
  message.textContent = text;
  byId('message-history').append(message);
  byId('conversation').scrollTop = byId('conversation').scrollHeight;
}

function setVoiceStatus(message, duration = 8000) {
  const status = byId('voice-status');
  status.textContent = message;
  status.hidden = !message;
  status.title = message;
  clearTimeout(statusTimer);
  if (duration > 0 && !micHeld) {
    statusTimer = setTimeout(() => {
      status.textContent = '';
      status.title = '';
      status.hidden = true;
      if (currentMode === 'message-status') setMode('message');
    }, duration);
  }
  if (currentMode === 'message' && message) setMode('message-status');
  else if (currentMode === 'message-status' && !message) setMode('message');
}

function receiveAssistantMessage(message) {
  if (typeof message !== 'string' || !message.trim()) return;
  appendChatMessage('assistant', message.trim());
  byId('message-history').hidden = false;
  byId('history-option').hidden = false;
  setMode('message-expanded');
}

function stopVoice({ quiet = false } = {}) {
  const wasListening = micHeld;
  micHeld = false;
  stopRequested = true;
  clearTimeout(statusTimer);
  byId('mic-button').classList.remove('listening');
  byId('mic-button').setAttribute('aria-pressed', 'false');
  byId('mic-button').setAttribute('aria-label', 'Iniciar gravação de voz');
  byId('mic-button').title = 'Clique para falar';
  if (quiet) {
    byId('voice-status').textContent = '';
    byId('voice-status').hidden = true;
  } else {
    setVoiceStatus(finalTranscript.trim()
      ? 'Transcrição pronta. Revise e toque na seta para enviar.'
      : 'Gravação encerrada. Não recebi fala; tente novamente.');
  }
  if (wasListening) {
    try { recognition?.stop(); } catch {}
  }
}

function setMode(mode, syncWindow = true) {
  const validModes = ['closed', 'message', 'message-status', 'message-expanded', 'actions', 'buttons', 'project-select'];
  if (!validModes.includes(mode)) return;
  if (mode === 'closed') stopVoice({ quiet: true });
  currentMode = mode;
  document.body.className = `mode-${mode}`;
  byId('conversation-heading').hidden = mode !== 'message-expanded';
  byId('conversation').hidden = mode !== 'message-expanded';
  byId('action-menu').hidden = mode !== 'actions';
  byId('button-list').hidden = mode !== 'buttons';
  byId('session-picker').hidden = mode !== 'project-select';
  byId('composer').hidden = mode === 'closed';
  byId('plus-button').setAttribute('aria-expanded', String(['actions', 'buttons', 'project-select'].includes(mode)));
  if (syncWindow) window.claudete.setPanelMode(mode);
}

async function speak(text) {
  if (!text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  let voices = window.speechSynthesis.getVoices();
  for (let attempt = 0; voices.length === 0 && attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    voices = window.speechSynthesis.getVoices();
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'pt-BR';
  utterance.rate = 0.92;
  utterance.pitch = 1.02;
  const portuguese = voices.filter((voice) => voice.lang.toLowerCase().startsWith('pt-br'));
  utterance.voice = portuguese.find((voice) => /natural|neural/i.test(voice.name))
    || portuguese.find((voice) => /maria/i.test(voice.name) && !/desktop/i.test(voice.name))
    || portuguese.find((voice) => /maria/i.test(voice.name)) || portuguese[0] || null;
  utterance.onstart = () => {
    document.body.classList.add('speaking');
    window.claudete.setMascotSpeaking(true);
  };
  const stopSpeaking = () => {
    document.body.classList.remove('speaking');
    window.claudete.setMascotSpeaking(false);
  };
  utterance.onend = stopSpeaking;
  utterance.onerror = stopSpeaking;
  window.speechSynthesis.speak(utterance);
}

function showNotice(message) {
  setVoiceStatus(message);
}

function applyState(state) {
  if (!state) return;
  wakeWordEnabled = Boolean(state.wakeWordEnabled);
  renderWakeOption();
  selectedSession = state.claudeSession || null;
  byId('project-label').textContent = selectedSession
    ? `${selectedSession.project} · ${selectedSession.title}` : 'Nenhum projeto selecionado';
  byId('button-list').querySelector('[data-action="dev"]').disabled = !state.projectInfo?.scripts?.includes('dev') || state.running;
  byId('button-list').querySelector('[data-action="test"]').disabled = !state.projectInfo?.scripts?.includes('test') || state.running;
  byId('button-list').querySelector('[data-action="site"]').disabled = !state.projectPath;
  byId('button-list').querySelector('[data-action="stop"]').disabled = !state.running;
  running = Boolean(state.running);
  window.claudete.setMascotRunning(running);
}

function startVoice() {
  if (micHeld) {
    stopVoice();
    return;
  }
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechApi) {
    setVoiceStatus('O reconhecimento de voz não está disponível nesta versão do navegador.');
    return;
  }
  if (!recognition) {
    recognition = new SpeechApi();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += `${phrase} `;
        else interim += phrase;
      }
      byId('prompt').value = `${baseText}${finalTranscript}${interim}`.trimStart();
    };
    recognition.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      micHeld = false;
      stopRequested = true;
      byId('mic-button').classList.remove('listening');
      byId('mic-button').setAttribute('aria-pressed', 'false');
      voiceError = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'O acesso ao microfone foi bloqueado. Confira a permissão de microfone do Windows.'
        : event.error === 'network' ? 'O serviço de reconhecimento de voz não respondeu. Confira a internet.'
          : `O reconhecimento de voz parou (${event.error}). Tente novamente.`;
      setVoiceStatus(voiceError);
    };
    recognition.onend = () => {
      if (currentMode === 'closed') return;
      if (micHeld && !stopRequested) {
        setTimeout(() => { if (micHeld && !stopRequested) { try { recognition.start(); } catch {} } }, 250);
        return;
      }
      byId('mic-button').classList.remove('listening');
      byId('mic-button').setAttribute('aria-pressed', 'false');
      byId('mic-button').setAttribute('aria-label', 'Iniciar gravação de voz');
      byId('mic-button').title = 'Clique para falar';
      setVoiceStatus(voiceError || (finalTranscript.trim()
        ? 'Transcrição pronta. Revise e toque na seta para enviar.'
        : 'Não consegui transcrever. Clique no microfone e tente novamente.'));
      voiceError = '';
    };
  }
  micHeld = true;
  stopRequested = false;
  voiceError = '';
  baseText = byId('prompt').value.trim() ? `${byId('prompt').value.trim()} ` : '';
  finalTranscript = '';
  byId('mic-button').classList.add('listening');
  byId('mic-button').setAttribute('aria-pressed', 'true');
  byId('mic-button').setAttribute('aria-label', 'Parar gravação de voz');
  byId('mic-button').title = 'Clique para terminar a gravação';
  setVoiceStatus('Ouvindo... clique no microfone novamente para terminar.', 0);
  try { recognition.start(); }
  catch {
    micHeld = false;
    byId('mic-button').classList.remove('listening');
    byId('mic-button').setAttribute('aria-pressed', 'false');
    byId('mic-button').setAttribute('aria-label', 'Iniciar gravação de voz');
    byId('mic-button').title = 'Clique para falar';
    setVoiceStatus('Não consegui iniciar o microfone. Confira as permissões e tente novamente.');
  }
}

async function showSessions() {
  setMode('project-select');
  const list = byId('session-list');
  const status = byId('picker-status');
  list.replaceChildren();
  status.textContent = 'Procurando conversas locais do Claude Code...';
  const sessions = await window.claudete.listClaudeSessions();
  if (!sessions.length) {
    status.textContent = 'Não encontrei conversas locais do Claude Code neste usuário do Windows.';
    return;
  }
  status.textContent = '';
  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = `session-option${selectedSession?.id === session.id ? ' selected' : ''}`;
    button.dataset.sessionId = session.id;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selectedSession?.id === session.id));
    const title = document.createElement('strong');
    title.textContent = session.title;
    const project = document.createElement('small');
    project.textContent = new Date(session.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ` · ${session.project}`;
    button.append(title, project);
    list.append(button);
  }
}

function renderAttachments() {
  const target = byId('attachment-list');
  target.hidden = attachments.length === 0;
  target.textContent = attachments.map((file) => file.split(/[\\/]/).filter(Boolean).at(-1)).join(' · ');
  target.title = attachments.join('\n');
}

byId('plus-button').addEventListener('click', () => setMode(currentMode === 'actions' ? 'message' : 'actions'));
byId('action-menu').addEventListener('click', async (event) => {
  const mode = event.target.closest('[data-menu]')?.dataset.menu;
  if (mode === 'buttons') setMode('buttons');
  if (mode === 'project-select') await showSessions();
  if (mode === 'history') setMode('message-expanded');
  if (mode === 'claude-login') await window.claudete.startClaudeLogin();
  if (mode === 'wake') {
    wakeWordEnabled = await window.claudete.toggleWakeWord();
    renderWakeOption();
  }
});
byId('close-picker').addEventListener('click', () => setMode('actions'));
byId('close-panel').addEventListener('click', () => setMode('closed'));
byId('session-list').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-session-id]')?.dataset.sessionId;
  if (!id) return;
  const selected = await window.claudete.selectClaudeSession(id);
  if (!selected) {
    byId('picker-status').textContent = 'Essa conversa mudou ou não está mais disponível. Atualize a lista.';
    return;
  }
  selectedSession = selected;
  byId('project-label').textContent = `${selected.project} · ${selected.title}`;
  setMode('message');
  setVoiceStatus(`Conversa selecionada: ${selected.title}. As mensagens serão encaminhadas pelo Claude Code.`);
});
byId('attachment-button').addEventListener('click', async () => {
  const files = await window.claudete.addAttachment();
  if (files?.length) {
    attachments = [...new Set([...attachments, ...files])];
    renderAttachments();
    setMode('message');
    setVoiceStatus(`${files.length} item(ns) selecionado(s). O anexo só será enviado quando a conversa estiver conectada.`);
  }
});
byId('button-list').addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'folder') await window.claudete.chooseProject();
  else if (action === 'dev' || action === 'test') await window.claudete.run(action);
  else if (action === 'site') await window.claudete.openSite();
  else if (action === 'stop') await window.claudete.stop();
  else if (action === 'claude') await window.claudete.openClaude();
});
byId('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = byId('prompt').value.trim();
  if (!prompt && !attachments.length) return;
  if (!selectedSession) {
    setVoiceStatus('Clique em + e selecione uma conversa do Claude Code antes de enviar.');
    return;
  }
  const sendButton = byId('composer').querySelector('[type="submit"]');
  sendButton.disabled = true;
  setVoiceStatus(`Enviando para ${selectedSession.title} pelo Claude Code...`, 0);
  try {
    const result = await window.claudete.sendClaudeMessage({
      sessionId: selectedSession.id,
      prompt,
      attachments: [...attachments],
    });
    if (!result?.ok) {
      setVoiceStatus(result?.error || 'Não consegui enviar. Seu texto continua no campo.', 0);
      return;
    }
    if (prompt) appendChatMessage('user', prompt);
    if (attachments.length) appendChatMessage('user', `Anexos enviados como caminhos locais: ${attachments.map((file) => file.split(/[\\/]/).filter(Boolean).at(-1)).join(', ')}`);
    appendChatMessage('assistant', result.text);
    byId('message-history').hidden = false;
    byId('history-option').hidden = false;
    byId('prompt').value = '';
    attachments = [];
    renderAttachments();
    setMode('message-expanded');
    setVoiceStatus('Resposta recebida do Claude Code.', 5000);
  } catch {
    setVoiceStatus('Não consegui enviar. Seu texto continua no campo.', 0);
  } finally {
    sendButton.disabled = false;
  }
});
byId('mic-button').addEventListener('click', startVoice);
window.claudete.onNotice(showNotice);
window.claudete.onProcess((state) => {
  running = Boolean(state.running);
  window.claudete.getState().then(applyState);
});
window.claudete.onMode((mode) => setMode(mode, false));
window.claudete.onActive((active) => { if (!active) stopVoice(); });
window.claudete.onWakeEnabled((enabled) => {
  wakeWordEnabled = Boolean(enabled);
  renderWakeOption();
});
window.claudete.onWakeEvent(({ type, text }) => {
  if (type === 'start') {
    setMode('message');
    byId('prompt').value = text;
    setVoiceStatus(text ? 'Ouvindo o restante do comando...' : 'Ouvindo seu comando... diga o que precisa. ', 0);
  } else if (type === 'update') {
    byId('prompt').value = text;
  } else if (type === 'complete') {
    byId('prompt').value = text;
    byId('prompt').focus();
    setVoiceStatus(text ? 'Transcrição pronta. Revise e toque na seta para enviar.' : 'Não ouvi o comando. Diga “Claudete” e depois o que precisa.');
  } else if (type === 'error') {
    setVoiceStatus(text || 'Não consegui ativar o reconhecimento de voz.');
  }
});
window.addEventListener('DOMContentLoaded', async () => {
  const state = await window.claudete.getState();
  applyState(state);
  setMode(state?.panelMode || 'message');
});
