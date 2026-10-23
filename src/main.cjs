const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } = require('electron');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = path.join(app.getPath('appData'), 'Claudete');
const settingsPath = path.join(dataDir, 'settings.json');
const mascotWindowSize = { width: 170, height: 208 };
const mascotSpriteHeight = 164;
const panelGap = 10;

function findClaudeDesktop() {
  const installDir = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude');
  const directPath = path.join(installDir, 'claude.exe');
  if (fs.existsSync(directPath)) return directPath;
  try {
    return fs.readdirSync(installDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^app-/i.test(entry.name))
      .map((entry) => path.join(installDir, entry.name, 'claude.exe'))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  } catch {
    return '';
  }
}

let mainWindow;
let panelWindow;
let tray;
let active = false;
let panelMode = 'closed';
let queuedNotice = '';
let queuedWake = null;
let projectProcess;
let settings = { projectPath: '', siteUrl: 'http://localhost:3000', claudeSessionId: '', claudeSessionTitle: '', claudeSessionCwd: '', wakeWordEnabled: false };
let panelAnchor = null;
let dragOffset;
let lastCursor;
let dragTimer;
let approvalServer;
let approvalEndpoint;

function readSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof value.projectPath === 'string') settings.projectPath = value.projectPath;
    if (typeof value.siteUrl === 'string') settings.siteUrl = value.siteUrl;
    if (typeof value.claudeSessionId === 'string') settings.claudeSessionId = value.claudeSessionId;
    if (typeof value.claudeSessionTitle === 'string') settings.claudeSessionTitle = value.claudeSessionTitle;
    if (typeof value.claudeSessionCwd === 'string') settings.claudeSessionCwd = value.claudeSessionCwd;
    if (typeof value.wakeWordEnabled === 'boolean') settings.wakeWordEnabled = value.wakeWordEnabled;
  } catch {}
}

function writeSettings() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function listClaudeSessions() {
  const root = path.join(process.env.USERPROFILE || '', '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const file of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!file.isFile() || !/^[0-9a-f-]{36}\.jsonl$/i.test(file.name)) continue;
      const transcriptPath = path.join(projectDir, file.name);
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.size > 100 * 1024 * 1024) continue;
        const fd = fs.openSync(transcriptPath, 'r');
        const buffer = Buffer.alloc(256 * 1024);
        let bytesRead;
        try { bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0); }
        finally { fs.closeSync(fd); }
        const head = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/, 300);
        let cwd = '';
        let title = '';
        for (const line of head) {
          try {
            const record = JSON.parse(line);
            if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
            if (record.type === 'custom-title' && typeof record.customTitle === 'string') title = record.customTitle;
          } catch {}
        }
        const id = path.basename(file.name, '.jsonl');
        const projectName = path.basename(cwd || project.name).replace(/[-_]+/g, ' ');
        sessions.push({ id, title: title || projectName, project: projectName, cwd, updatedAt: stat.mtimeMs, transcriptPath });
      } catch {}
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
}

function findClaudeCode() {
  const root = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const version of versions) {
      for (const build of fs.readdirSync(version, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        const executable = path.join(version, build.name, 'claude.exe');
        if (fs.existsSync(executable)) return executable;
      }
    }
  } catch {}
  return '';
}

function ensureApprovalServer() {
  if (approvalServer?.listening) return Promise.resolve(approvalEndpoint);
  const token = crypto.randomBytes(32).toString('hex');
  approvalServer = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256_000) request.destroy();
    });
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (typeof payload.toolName !== 'string' || !payload.input || typeof payload.input !== 'object') {
          response.writeHead(400).end();
          return;
        }
        const parent = panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible() ? panelWindow : mainWindow;
        const detail = JSON.stringify(payload.input, null, 2).slice(0, 6000);
        const result = await dialog.showMessageBox(parent, {
          type: 'warning',
          title: 'Claudete: confirmação necessária',
          message: `Claude Code quer usar a ferramenta: ${payload.toolName}`,
          detail: `Conversa: ${settings.claudeSessionTitle}\nProjeto: ${settings.claudeSessionCwd}\n\nDetalhes da ação:\n${detail}${detail.length >= 6000 ? '\n… (detalhes reduzidos)' : ''}`,
          buttons: ['Aprovar esta ação', 'Recusar'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        const decision = result.response === 0
          ? { behavior: 'allow', updatedInput: payload.input }
          : { behavior: 'deny', message: 'A pessoa usuária recusou esta ação.' };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision));
      } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    approvalServer.once('error', reject);
    approvalServer.listen(0, '127.0.0.1', () => {
      approvalServer.removeListener('error', reject);
      const { port } = approvalServer.address();
      approvalEndpoint = `http://127.0.0.1:${port}/${token}`;
      resolve(approvalEndpoint);
    });
  });
}

async function sendToClaudeSession(sessionId, prompt, attachments = []) {
  if (typeof sessionId !== 'string' || sessionId !== settings.claudeSessionId) {
    throw new Error('Selecione novamente a conversa do Claude Code antes de enviar.');
  }
  if (typeof prompt !== 'string' || (!prompt.trim() && !attachments.length)) {
    throw new Error('Escreva uma mensagem antes de enviar.');
  }
  const session = listClaudeSessions().find((item) => item.id === sessionId);
  if (!session || !validateProjectFolder(session.cwd)) {
    throw new Error('Não encontrei mais essa conversa local. Atualize a seleção do projeto.');
  }
  const executable = findClaudeCode();
  if (!executable) throw new Error('Não encontrei o Claude Code CLI neste computador.');
  try {
    const auth = execFileSync(executable, ['auth', 'status', '--text'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (/not logged in/i.test(auth)) throw new Error('not logged in');
  } catch (error) {
    if (error.status === 1 || /not logged in/i.test(`${error.stdout || ''}${error.stderr || ''}${error.message || ''}`)) {
      throw new Error('O Claude Code não está conectado. Abra + > Conectar Claude Code, conclua o login no navegador e tente novamente.');
    }
    throw new Error('Não consegui verificar o login do Claude Code. Confira a instalação e tente novamente.');
  }

  const endpoint = await ensureApprovalServer();
  const configPath = path.join(os.tmpdir(), `claudete-mcp-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {
    claudete_approval: {
      command: process.execPath,
      args: [path.join(__dirname, 'permission-server.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', CLAUDETE_APPROVAL_ENDPOINT: endpoint },
    },
  } }), { encoding: 'utf8', mode: 0o600 });
  const fileNotes = attachments.length
    ? `\n\nArquivos/pastas selecionados pelo usuário (caminhos locais):\n${attachments.map((item) => `- ${item}`).join('\n')}\nLeia esses caminhos se precisar deles.`
    : '';
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--print', '--resume', sessionId, '--permission-prompts', 'host',
      '--permission-prompt-tool', 'mcp__claudete_approval__approval_prompt',
      '--allowedTools', 'mcp__claudete_approval__approval_prompt',
      '--mcp-config', configPath, '--output-format', 'text', `${prompt.trim()}${fileNotes}`,
    ], { cwd: session.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 20_000) stderr += chunk; });
    child.once('error', () => {
      fs.rmSync(configPath, { force: true });
      reject(new Error('Não consegui iniciar o Claude Code.'));
    });
    child.once('close', (code) => {
      fs.rmSync(configPath, { force: true });
      if (code !== 0) {
        const detail = `${stderr}\n${stdout}`;
        reject(new Error(/not logged in|authentication/i.test(detail)
          ? 'O Claude Code não está conectado à sua conta. Conecte e tente novamente.'
          : `O Claude Code não conseguiu responder${detail.trim() ? `: ${detail.trim().slice(-700)}` : '.'}`));
        return;
      }
      resolve(stdout.trim() || 'O Claude Code terminou sem retornar texto.');
    });
  });
}

function isTrustedSender(event) {
  return event.senderFrame?.url?.startsWith('file://') === true;
}

function tellRenderer(channel, payload) {
  if (channel === 'app:notice') {
    queuedNotice = String(payload || '');
    if (!panelWindow || !panelWindow.isVisible()) setPanelMode('message');
  }
  for (const target of [mainWindow, panelWindow]) {
    if (target && !target.isDestroyed() && (target === mainWindow || target.isVisible())) {
      if (target.webContents.isLoading()) continue;
      target.webContents.send(channel, payload);
      if (channel === 'app:notice' && target === panelWindow) queuedNotice = '';
    }
  }
}

function setActive(next) {
  active = Boolean(next);
  if (!mainWindow) return;
  if (active) {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.webContents.send('app:active', true);
    mainWindow.webContents.send('app:wake-enabled', settings.wakeWordEnabled);
  } else {
    setPanelMode('closed');
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('app:active', false);
    mainWindow.hide();
    mainWindow.webContents.send('app:active', false);
    mainWindow.webContents.send('app:wake-enabled', false);
  }
  if (tray) {
    tray.setToolTip(`Claudete - ${active ? 'ativada' : 'desativada'}`);
    tray.setContextMenu(buildTrayMenu());
  }
}

function setWakeWordEnabled(enabled) {
  settings.wakeWordEnabled = Boolean(enabled);
  writeSettings();
  mainWindow?.webContents.send('app:wake-enabled', active && settings.wakeWordEnabled);
  tray?.setContextMenu(buildTrayMenu());
  return settings.wakeWordEnabled;
}

function toggleActive() {
  setActive(!active);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = mascotWindowSize;
  mainWindow = new BrowserWindow({
    x: area.x + area.width - width - 28,
    y: area.y + area.height - height - 48,
    width,
    height,
    minWidth: mascotWindowSize.width,
    minHeight: mascotWindowSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on('move', () => {
    if (panelMode !== 'closed' && panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
      positionPanelWindow(undefined, true);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'mascot.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('app:wake-enabled', active && settings.wakeWordEnabled);
  });
  setInterval(keepMascotVisible, 500);
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      setActive(false);
    }
  });
  mainWindow.on('hide', () => {
    if (!active || app.isQuitting) return;
    setTimeout(() => {
      if (!active || app.isQuitting || !mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
      mainWindow.setAlwaysOnTop(true, 'floating');
      mainWindow.showInactive();
    }, 120);
  });
  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (active && mainWindow && !mainWindow.isDestroyed() && !panelWindow?.isFocused()) {
        mainWindow.setAlwaysOnTop(true, 'floating');
        mainWindow.showInactive();
      }
    }, 120);
  });
  secureContents(mainWindow);
}

function secureContents(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) return;
  panelWindow = new BrowserWindow({
    parent: mainWindow,
    width: 390,
    height: 68,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    useContentSize: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWindow.loadFile(path.join(__dirname, 'index.html'));
  secureContents(panelWindow);
  panelWindow.webContents.once('did-finish-load', () => {
    panelWindow.webContents.send('window:mode', panelMode);
    if (queuedWake) {
      panelWindow.webContents.send('voice:wake-event', queuedWake);
      queuedWake = null;
    }
    if (queuedNotice) {
      panelWindow.webContents.send('app:notice', queuedNotice);
      queuedNotice = '';
    }
  });
  panelWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      setPanelMode('closed');
    }
  });
  panelWindow.on('closed', () => { panelWindow = null; });
}

function setPanelMode(mode) {
  if (!['closed', 'message', 'message-status', 'message-expanded', 'actions', 'buttons', 'project-select', 'notice'].includes(mode) || !mainWindow) return;
  panelMode = mode;
  if (mode === 'closed') {
    panelAnchor = null;
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send('window:mode', 'closed');
      panelWindow.hide();
    }
    mainWindow?.webContents.send('mascot:panel-state', false);
    return;
  }
  createPanelWindow();
  const size = panelSize(mode);
  positionPanelWindow(size);
  if (!panelWindow.isVisible()) mode === 'notice' ? panelWindow.showInactive() : panelWindow.show();
  panelWindow.setAlwaysOnTop(true, 'floating');
  panelWindow.webContents.send('window:mode', mode);
  mainWindow.webContents.send('mascot:panel-state', true);
}

function panelSize(mode = panelMode) {
  return mode === 'notice' ? { width: 286, height: 66 }
    : mode === 'message' ? { width: 390, height: 68 }
    : mode === 'message-status' ? { width: 390, height: 112 }
        : mode === 'actions' ? { width: 320, height: 230 }
          : mode === 'buttons' ? { width: 320, height: 300 }
            : mode === 'project-select' ? { width: 390, height: 390 }
              : { width: 390, height: 390 };
}

function positionPanelWindow(size = panelSize(), preserveAnchor = false) {
  if (!panelWindow || panelWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
  if (panelMode === 'closed') return;
  if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) size = panelSize();
  let base = mainWindow.getBounds();
  const area = screen.getDisplayMatching(base).workArea;
  const width = Math.min(size.width, area.width);
  const offsetY = Math.round((mascotWindowSize.height + mascotSpriteHeight) / 2) + panelGap;
  let height = Math.max(1, Math.min(size.height, area.height - offsetY));
  const availableBelow = area.y + area.height - (base.y + offsetY);
  const overflow = Math.max(0, height - availableBelow);
  if (overflow > 0) {
    const mascotY = Math.max(area.y, base.y - overflow);
    if (mascotY !== base.y) {
      mainWindow.setPosition(base.x, mascotY, false);
      base = mainWindow.getBounds();
    }
  }
  const centeredOffsetX = (mascotWindowSize.width - width) / 2;
  if (!preserveAnchor) {
    const minMascotX = area.x - centeredOffsetX;
    const maxMascotX = area.x + area.width - width - centeredOffsetX;
    const mascotX = Math.round(Math.min(maxMascotX, Math.max(minMascotX, base.x)));
    if (mascotX !== base.x) {
      mainWindow.setPosition(mascotX, base.y, false);
      base = mainWindow.getBounds();
    }
  }
  const nextX = preserveAnchor && panelAnchor
    ? base.x + panelAnchor.x
    : base.x + centeredOffsetX;
  const x = Math.round(nextX);
  const y = Math.round(base.y + (preserveAnchor && panelAnchor ? panelAnchor.y : offsetY));
  panelWindow.setMinimumSize(1, 1);
  panelWindow.setMaximumSize(10000, 10000);
  panelWindow.setMinimumSize(width, height);
  panelWindow.setMaximumSize(width, height);
  panelAnchor = { x: x - base.x, y: y - base.y, width, height };
  panelWindow.setBounds({ x, y, width, height }, false);
}

function beginWindowDrag() {
  const cursor = screen.getCursorScreenPoint();
  const bounds = mainWindow.getBounds();
  dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  lastCursor = cursor;
  clearInterval(dragTimer);
  dragTimer = setInterval(moveWindow, 16);
}

function moveWindow() {
  if (!dragOffset) return { dx: 0, dy: 0 };
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - lastCursor.x;
  const dy = cursor.y - lastCursor.y;
  const bounds = mainWindow.getBounds();
  const displays = screen.getAllDisplays().map((display) => display.bounds);
  const desktop = {
    left: Math.min(...displays.map((display) => display.x)),
    top: Math.min(...displays.map((display) => display.y)),
    right: Math.max(...displays.map((display) => display.x + display.width)),
    bottom: Math.max(...displays.map((display) => display.y + display.height)),
  };
  const visible = Math.min(48, Math.floor(bounds.width / 2), Math.floor(bounds.height / 2));
  let minX = desktop.left - bounds.width + visible;
  let maxX = desktop.right - visible;
  let minY = desktop.top - bounds.height + visible;
  let maxY = desktop.bottom - visible;
  if (panelAnchor && panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    minX = Math.max(minX, desktop.left - panelAnchor.x);
    maxX = Math.min(maxX, desktop.right - panelAnchor.width - panelAnchor.x);
    minY = Math.max(minY, desktop.top - panelAnchor.y);
    maxY = Math.min(maxY, desktop.bottom - panelAnchor.height - panelAnchor.y);
  }
  if (minX > maxX) { minX = desktop.left - bounds.width + visible; maxX = desktop.right - visible; }
  if (minY > maxY) { minY = desktop.top - bounds.height + visible; maxY = desktop.bottom - visible; }
  const x = Math.min(maxX, Math.max(minX, cursor.x - dragOffset.x));
  const y = Math.min(maxY, Math.max(minY, cursor.y - dragOffset.y));
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  if (nextX !== bounds.x || nextY !== bounds.y) {
    mainWindow.setPosition(nextX, nextY, false);
  }
  if (dx !== 0) mainWindow.webContents.send('mascot:direction', dx < 0 ? 'left' : 'right');
  lastCursor = cursor;
  return { dx, dy };
}

function endWindowDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;
  lastCursor = null;
}

function keepMascotVisible() {
  if (!active || app.isQuitting) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.showInactive();
  }
  if (panelMode !== 'closed' && panelWindow && !panelWindow.isDestroyed() && !panelWindow.isVisible()) {
    panelWindow.setAlwaysOnTop(true, 'floating');
    panelWindow.showInactive();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: active ? 'Desativar Claudete' : 'Ativar Claudete', click: toggleActive },
    { label: settings.wakeWordEnabled ? 'Desativar palavra de ativação: Claudete' : 'Ativar palavra de ativação: Claudete', click: () => setWakeWordEnabled(!settings.wakeWordEnabled) },
    { label: 'Abrir Claudete', click: () => setActive(true) },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const sprite = nativeImage.createFromPath(path.join(__dirname, 'assets', 'claudete-walk.png'));
  const icon = sprite.crop({ x: 0, y: 0, width: 123, height: 195 }).resize({ height: 32, quality: 'best' });
  tray = new Tray(icon);
  tray.setToolTip('Claudete - desativada');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleActive);
}

function validateProjectFolder(folder) {
  return typeof folder === 'string' && path.isAbsolute(folder) && fs.existsSync(folder) && fs.statSync(folder).isDirectory();
}

function packageInfo(folder) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    const packageManager = typeof packageJson.packageManager === 'string' ? packageJson.packageManager.split('@')[0] : 'npm';
    const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
    const runner = ['pnpm', 'yarn', 'bun'].includes(packageManager) ? packageManager : 'npm';
    return { runner, scripts: Object.keys(scripts) };
  } catch {
    return { runner: 'npm', scripts: [] };
  }
}

function commandFor(action, folder) {
  const info = packageInfo(folder);
  if (!info.scripts.includes(action)) return null;
  return info.runner === 'npm' ? `npm run ${action}` : `${info.runner} run ${action}`;
}

async function confirmCommand(title, command) {
  const parent = panelWindow && panelWindow.isVisible() ? panelWindow : mainWindow;
  const result = await dialog.showMessageBox(parent, {
    type: 'warning',
    title,
    message: title,
    detail: `Projeto:\n${settings.projectPath}\n\nComando que sera executado:\n${command}\n\nScripts de projeto podem executar codigo. Continue apenas se reconhece esta pasta e este comando.`,
    buttons: ['Executar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function runProjectScript(action) {
  if (!validateProjectFolder(settings.projectPath)) {
    tellRenderer('app:notice', 'Escolha uma pasta de projeto valida primeiro.');
    return;
  }
  if (projectProcess) {
    tellRenderer('app:notice', 'Ja existe um processo iniciado pela Claudete. Pare-o antes de iniciar outro.');
    return;
  }
  const command = commandFor(action, settings.projectPath);
  if (!command) {
    tellRenderer('app:notice', `Nao encontrei um comando '${action}' no package.json desta pasta.`);
    return;
  }
  if (!(await confirmCommand(action === 'dev' ? 'Iniciar projeto' : 'Rodar testes', command))) return;

  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: settings.projectPath,
    windowsHide: true,
    stdio: 'ignore',
  });
  projectProcess = child;
  tellRenderer('app:process', { running: true, pid: child.pid, action });
  child.once('error', () => {
    projectProcess = null;
    tellRenderer('app:process', { running: false });
    tellRenderer('app:notice', 'Nao consegui iniciar o comando. Confira se o gerenciador do projeto esta instalado.');
  });
  child.once('exit', (code) => {
    projectProcess = null;
    tellRenderer('app:process', { running: false });
    tellRenderer('app:notice', code === 0 ? 'O comando terminou.' : `O comando encerrou com codigo ${code ?? 'desconhecido'}.`);
  });
}

async function stopProjectScript() {
  if (!projectProcess?.pid) {
    tellRenderer('app:notice', 'Nenhum processo iniciado pela Claudete esta rodando.');
    return;
  }
  const result = await dialog.showMessageBox(panelWindow && panelWindow.isVisible() ? panelWindow : mainWindow, {
    type: 'warning',
    title: 'Parar tarefa',
    message: 'Parar o processo iniciado pela Claudete e seus processos filhos?',
    detail: `PID ${projectProcess.pid} - esta acao nao apaga arquivos.`,
    buttons: ['Parar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0) return;
  const pid = projectProcess.pid;
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  projectProcess = null;
  tellRenderer('app:process', { running: false });
  tellRenderer('app:notice', 'Processo parado.');
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function openClaude() {
  const desktopClaude = findClaudeDesktop();
  if (desktopClaude) {
    const child = spawn(desktopClaude, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', () => tellRenderer('app:notice', 'Nao consegui abrir o Claude Desktop. Tente inicia-lo pelo menu Iniciar do Windows.'));
    child.unref();
  } else {
    tellRenderer('app:notice', 'Nao encontrei o aplicativo Claude neste computador.');
  }
}

function startClaudeLogin() {
  const executable = findClaudeCode();
  if (!executable) {
    tellRenderer('app:notice', 'Nao encontrei o Claude Code CLI neste computador.');
    return;
  }
  const child = spawn(executable, ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.once('error', () => tellRenderer('app:notice', 'Nao consegui abrir o login do Claude Code.'));
  child.unref();
  tellRenderer('app:notice', 'Abri o login oficial do Claude Code. Conclua a autenticacao no navegador e tente enviar novamente.');
}

function registerIpc() {
  ipcMain.handle('project:choose', async (event) => {
    if (!isTrustedSender(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    settings.projectPath = result.filePaths[0];
    writeSettings();
    return { projectPath: settings.projectPath, info: packageInfo(settings.projectPath) };
  });

  ipcMain.handle('claude:list-sessions', (event) => {
    if (!isTrustedSender(event)) return [];
    return listClaudeSessions().map(({ id, title, project, updatedAt }) => ({ id, title, project, updatedAt }));
  });

  ipcMain.handle('claude:login', (event) => {
    if (!isTrustedSender(event)) return false;
    startClaudeLogin();
    return true;
  });

  ipcMain.handle('claude:select-session', (event, id) => {
    if (!isTrustedSender(event) || typeof id !== 'string') return null;
    const selected = listClaudeSessions().find((item) => item.id === id);
    if (!selected) return null;
    settings.claudeSessionId = selected.id;
    settings.claudeSessionTitle = selected.title;
    settings.claudeSessionCwd = selected.cwd;
    writeSettings();
    return { id: selected.id, title: selected.title, project: selected.project };
  });

  ipcMain.handle('claude:send-message', async (event, payload) => {
    if (!isTrustedSender(event) || !payload || !Array.isArray(payload.attachments)
      || payload.attachments.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) return null;
    try {
      return { ok: true, text: await sendToClaudeSession(payload.sessionId, payload.prompt, payload.attachments) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('conversation:add-attachment', async (event) => {
    if (!isTrustedSender(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(parent, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return result.canceled ? null : result.filePaths;
  });

  ipcMain.handle('voice:wake-toggle', (event) => {
    if (!isTrustedSender(event)) return false;
    return setWakeWordEnabled(!settings.wakeWordEnabled);
  });

  ipcMain.handle('voice:wake-event', (event, payload) => {
    if (!isTrustedSender(event) || !active || !settings.wakeWordEnabled || !payload
      || !['start', 'update', 'complete', 'error'].includes(payload.type)
      || typeof payload.text !== 'string' || payload.text.length > 4000) return false;
    if (event.sender !== mainWindow?.webContents) return false;
    if (payload.type === 'start' || payload.type === 'error') setPanelMode('message');
    if (!panelWindow || panelWindow.isDestroyed()) return false;
    if (panelWindow.webContents.isLoading()) queuedWake = payload;
    else panelWindow.webContents.send('voice:wake-event', payload);
    return true;
  });

  ipcMain.handle('app:state', (event) => {
    if (!isTrustedSender(event)) return null;
    return { active, projectPath: settings.projectPath, projectInfo: settings.projectPath ? packageInfo(settings.projectPath) : { runner: '', scripts: [] }, running: Boolean(projectProcess), siteUrl: settings.siteUrl, panelMode, wakeWordEnabled: settings.wakeWordEnabled, claudeSession: settings.claudeSessionId ? { id: settings.claudeSessionId, title: settings.claudeSessionTitle, project: path.basename(settings.claudeSessionCwd).replace(/[-_]+/g, ' ') } : null };
  });

  ipcMain.handle('project:run', async (event, action) => {
    if (!isTrustedSender(event) || !['dev', 'test'].includes(action)) return;
    await runProjectScript(action);
  });

  ipcMain.handle('project:stop', async (event) => {
    if (!isTrustedSender(event)) return;
    try {
      await stopProjectScript();
    } catch {
      tellRenderer('app:notice', 'Nao consegui parar a tarefa automaticamente. Feche-a pelo terminal que a iniciou.');
    }
  });

  ipcMain.handle('project:open-site', async (event) => {
    if (!isTrustedSender(event)) return;
    if (!isLocalUrl(settings.siteUrl)) {
      tellRenderer('app:notice', 'O endereco salvo nao e um site local seguro.');
      return;
    }
    await shell.openExternal(settings.siteUrl);
  });

  ipcMain.handle('claude:open', async (event) => {
    if (!isTrustedSender(event)) return;
    await openClaude();
  });

  ipcMain.handle('window:panel', (event, mode) => {
    if (!isTrustedSender(event) || !['closed', 'message', 'message-status', 'message-expanded', 'actions', 'buttons', 'project-select', 'notice'].includes(mode)) return;
    setPanelMode(mode);
  });

  ipcMain.handle('window:dragging', (event, dragging) => {
    if (!isTrustedSender(event) || typeof dragging !== 'boolean') return;
    if (dragging) beginWindowDrag();
    else endWindowDrag();
  });
  ipcMain.handle('window:mouse-passthrough', (event, ignore) => {
    if (!isTrustedSender(event) || BrowserWindow.fromWebContents(event.sender) !== mainWindow || typeof ignore !== 'boolean' || !mainWindow || mainWindow.isDestroyed()) return;
    if (dragOffset && ignore) return;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle('mascot:toggle-panel', (event) => {
    if (!isTrustedSender(event)) return;
    setPanelMode(panelMode === 'closed' ? 'message' : 'closed');
  });

  ipcMain.handle('mascot:running', (event, running) => {
    if (!isTrustedSender(event) || typeof running !== 'boolean') return;
    mainWindow.webContents.send('app:process', { running });
  });

  ipcMain.handle('mascot:speaking', (event, speaking) => {
    if (!isTrustedSender(event) || typeof speaking !== 'boolean') return;
    mainWindow?.webContents.send('mascot:speaking', speaking);
  });

  ipcMain.handle('app:deactivate', (event) => {
    if (!isTrustedSender(event)) return;
    setActive(false);
  });

  ipcMain.handle('settings:set-site-url', (event, value) => {
    if (!isTrustedSender(event) || typeof value !== 'string' || !isLocalUrl(value)) return false;
    settings.siteUrl = value;
    writeSettings();
    return true;
  });
}

fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('com.claudete.desktop');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => setActive(true));
  app.whenReady().then(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    readSettings();
    session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'media' && contents.getURL().startsWith('file://'));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const audioOnly = permission === 'media' && details.mediaTypes?.includes('audio') && !details.mediaTypes?.includes('video');
      callback(audioOnly && contents.getURL().startsWith('file://'));
    });
    registerIpc();
    createWindow();
    createTray();
    setActive(true);
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  approvalServer?.close();
});
