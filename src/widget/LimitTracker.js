// Scriptable iPhone 홈 화면 위젯. PC에서 선택한 계정의 사용량만 읽습니다.
// 앱의 iPhone 연결 페이지에서 다운로드한 파일을 Scriptable로 가져오세요.
const SETUP_URL = /*SETUP_URL*/ null;
const keyName = 'LimitTrackerConnection';
const seedName = 'LimitTrackerSeed';
const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.documentsDirectory(), 'LimitTracker-last-usage-v2.json');
const english = !/^ko/i.test(String(typeof Device !== 'undefined' && Device.language ? Device.language() : 'ko'));
const T = english ? {
  setupTitle: 'Connect Limit Tracker', setupMessage: 'Paste the address copied from “View on iPhone” in the PC app. The PC app must be running on the same Wi-Fi.',
  connect: 'Connect', cancel: 'Cancel', offline: 'Offline', usage: 'Usage', used: 'used', old: 'old record', manual: 'manual',
  current: 'current limit', refresh: 'needs refresh', enter: 'needs entry', unsupported: 'not supported', connectNeeded: 'connect',
  turnOnPc: 'Turn on the PC app and join the same Wi-Fi.', runOnce: 'Run once in Scriptable to connect to the PC.',
  chooseAccounts: 'Choose accounts to show in the PC app.', newAddress: 'The connection address changed. Copy the new address from the PC app.',
  entered: 'entered', checked: 'checked', more: n => ` · +${n}`, retry: 'The PC did not answer. Enter a new address?', retryYes: 'Enter address', retryNo: 'Later',
} : {
  setupTitle: 'Limit Tracker 연결', setupMessage: 'PC 앱의 iPhone에서 보기에서 복사한 주소를 붙여 넣으세요. 같은 Wi-Fi에서 PC 앱이 실행 중이어야 합니다.',
  connect: '연결', cancel: '취소', offline: '오프라인', usage: '사용률', used: '사용', old: '이전 기록', manual: '직접 입력',
  current: '현재 한도', refresh: '갱신 필요', enter: '입력 필요', unsupported: '조회 미지원', connectNeeded: '연결 필요',
  turnOnPc: 'PC 앱을 켜고 같은 Wi-Fi에 연결해 주세요.', runOnce: 'Scriptable에서 한 번 실행해 PC와 연결하세요.',
  chooseAccounts: 'PC의 계정 관리에서 표시할 계정을 선택하세요.', newAddress: '연결 주소가 바뀌었습니다. PC 앱에서 새 주소를 복사해 다시 설정하세요.',
  entered: '입력', checked: '확인', more: n => ` · +${n}개`, retry: 'PC가 응답하지 않습니다. 새 주소를 입력할까요?', retryYes: '주소 입력', retryNo: '나중에',
};
function validAddress(value) {
  const match = typeof value === 'string' && value.match(/^http:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+):(\d+)\/\?key=[a-f0-9]{64}$/);
  return !!match && match[1].split('.').every(part => Number(part) <= 255) && Number(match[2]) > 0 && Number(match[2]) <= 65535;
}
async function askAddress(current) {
  const alert = new Alert();
  alert.title = T.setupTitle;
  alert.message = T.setupMessage;
  alert.addTextField('http://192.168…/?key=…', current || '');
  alert.addAction(T.connect); alert.addCancelAction(T.cancel);
  return await alert.presentAlert() === 0 ? alert.textFieldValue(0).trim() : null;
}
// A freshly downloaded script seeds the address once; an address entered in the
// setup alert wins afterwards, so a changed PC address can be fixed in place.
let stored = Keychain.contains(keyName) ? Keychain.get(keyName) : null;
if (SETUP_URL && (!Keychain.contains(seedName) || Keychain.get(seedName) !== SETUP_URL)) { Keychain.set(seedName, SETUP_URL); stored = SETUP_URL; Keychain.set(keyName, SETUP_URL); }
let endpoint = args.widgetParameter || stored || SETUP_URL;
if (!config.runsInWidget && (!endpoint || args.queryParameters.setup === '1')) {
  const entered = await askAddress(endpoint);
  if (entered) endpoint = entered;
}
let validEndpoint = validAddress(endpoint);
if (validEndpoint && !args.widgetParameter) Keychain.set(keyName, endpoint);
// Cache identity prevents another PC/account connection from showing this PC's old snapshot.
function fingerprint(text) { let a = 2166136261, b = 5381; for (const char of text) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); } return `${a >>> 0}-${b >>> 0}`; }
async function load(address) {
  const request = new Request(address.replace('/?key=', '/api/usage?key=')); request.timeoutInterval = 6;
  const body = await request.loadString();
  const status = request.response?.statusCode;
  if (status === 401 || status === 403) return { unauthorized: true };
  if (status && status !== 200) throw new Error('HTTP');
  const state = JSON.parse(body);
  if (!Array.isArray(state.providers)) throw new Error('Invalid data');
  return { state };
}
let state = null, offline = false, unauthorized = false;
if (validEndpoint) {
  let connection = fingerprint(endpoint);
  try {
    let result = await load(endpoint);
    if (result.unauthorized && !config.runsInWidget) {
      const entered = await askAddress(endpoint);
      if (entered && validAddress(entered)) { endpoint = entered; Keychain.set(keyName, endpoint); connection = fingerprint(endpoint); result = await load(endpoint); }
    }
    if (result.unauthorized) unauthorized = true;
    else { state = result.state; fm.writeString(cacheFile, JSON.stringify({ connection, state })); }
  } catch {
    offline = true;
    if (!config.runsInWidget) {
      const ask = new Alert(); ask.message = T.retry; ask.addAction(T.retryYes); ask.addCancelAction(T.retryNo);
      if (await ask.presentAlert() === 0) {
        const entered = await askAddress(endpoint);
        if (entered && validAddress(entered)) {
          try { endpoint = entered; Keychain.set(keyName, endpoint); connection = fingerprint(endpoint); const retried = await load(endpoint); if (retried.state) { state = retried.state; offline = false; fm.writeString(cacheFile, JSON.stringify({ connection, state })); } else unauthorized = true; } catch { /* Keep the offline view. */ }
        }
      }
    }
    if (!state && !unauthorized) {
      try { if (fm.fileExists(cacheFile)) { const cached = JSON.parse(fm.readString(cacheFile)); if (cached.connection === connection && Array.isArray(cached.state?.providers)) state = cached.state; } } catch {}
    }
  }
}
const widget = new ListWidget();
widget.backgroundColor = Color.dynamic(new Color('F4F5FB'), new Color('1B1E29'));
widget.setPadding(16, 16, 14, 16);
const ink = Color.dynamic(new Color('20283C'), new Color('F5F6FC'));
const muted = Color.dynamic(new Color('626C80'), new Color('AFB7C9'));
const header = widget.addStack(); header.centerAlignContent();
const title = header.addText('Limit Tracker'); title.font = Font.semiboldSystemFont(13); title.textColor = ink;
header.addSpacer();
if (config.widgetFamily !== 'small') { const live = header.addText(offline ? T.offline : T.usage); live.font = Font.systemFont(11); live.textColor = muted; }
widget.addSpacer(config.widgetFamily === 'large' ? 16 : 12);
function providerName(p) { return { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', grok: 'Grok' }[p.providerId || p.id] || p.name || 'AI'; }
function percent(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null; }
function used(window) {
  if (!window) return null;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (Number.isFinite(reset) && reset <= Date.now()) return null;
  const value = percent(window.usedPercent);
  if (value !== null) return value;
  const remaining = percent(window.remainingPercent);
  return remaining === null ? null : 100 - remaining;
}
function primaryWindow(p) {
  const windows = Array.isArray(p.windows) ? p.windows : [];
  return windows.find(w => w.durationMinutes > 0 && w.durationMinutes <= 1440)
    || windows.find(w => /^(primary|session|five_hour|5h|five-hour)$/i.test(w.id || '')) || windows[0] || null;
}
function color(p, value) {
  if (value === null) return muted;
  if (value >= 95) return Color.dynamic(new Color('BD534C'), new Color('F19B96'));
  if (value >= 80) return Color.dynamic(new Color('A86A13'), new Color('E5BB70'));
  const id = p.providerId || p.id;
  return id === 'claude' ? Color.dynamic(new Color('AB593D'), new Color('E6AF97')) : id === 'gemini' ? Color.dynamic(new Color('416DCD'), new Color('A0BBFF')) : ink;
}
function addLabel(stack, text, font, foreground = muted) { const item = stack.addText(text); item.font = font; item.textColor = foreground; item.lineLimit = 1; item.minimumScaleFactor = .8; return item; }
function addMeter(stack, value, foreground, width) {
  if (value === null) return;
  stack.addSpacer(4);
  const track = stack.addStack(); track.layoutHorizontally(); track.setPadding(0, 0, 0, 0);
  track.size = new Size(width, 5); track.cornerRadius = 2.5;
  track.backgroundColor = Color.dynamic(new Color('E3E6EE'), new Color('373D4C'));
  // A zero-sized stack expands automatically in Scriptable, so 0% has no fill stack.
  if (value > 0) {
    const fill = track.addStack(); fill.size = new Size(width * value / 100, 5);
    fill.backgroundColor = foreground; fill.cornerRadius = 2.5;
  }
  if (value < 100) track.addSpacer();
}
if (unauthorized) {
  const text = widget.addText(T.newAddress); text.font = Font.systemFont(13); text.textColor = muted;
} else if (!state) {
  const text = widget.addText(validEndpoint ? T.turnOnPc : T.runOnce);
  text.font = Font.systemFont(13); text.textColor = muted;
} else if (!state.providers.length) {
  const text = widget.addText(T.chooseAccounts); text.font = Font.systemFont(13); text.textColor = muted;
} else {
  const family = config.widgetFamily || 'medium';
  const limit = family === 'large' ? 4 : family === 'small' ? 1 : 2;
  const shown = state.providers.slice(0, limit);
  const row = widget.addStack(); family === 'large' ? row.layoutVertically() : row.layoutHorizontally();
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i]; const w = primaryWindow(p); const value = used(w); const ready = value !== null; const manual = p.manual || p.mode === 'manual';
    if (i) row.addSpacer(family === 'large' ? 14 : 22);
    const section = row.addStack(); family === 'large' ? section.layoutHorizontally() : section.layoutVertically();
    const labels = family === 'large' ? section.addStack() : section; if (family === 'large') labels.layoutVertically();
    addLabel(labels, providerName(p), Font.semiboldSystemFont(13), ink);
    if (p.accountLabel) { labels.addSpacer(2); addLabel(labels, p.accountLabel, Font.systemFont(11)); }
    if (family === 'large') section.addSpacer(); else section.addSpacer(4);
    const reading = family === 'large' ? section.addStack() : section;
    if (family === 'large') reading.layoutVertically();
    const quantity = reading.addStack(); quantity.centerAlignContent();
    const foreground = color(p, value);
    addLabel(quantity, ready ? `${Math.round(value)}%` : '—', Font.semiboldSystemFont(27), foreground);
    if (ready) { quantity.addSpacer(3); addLabel(quantity, T.used, Font.systemFont(11), foreground); }
    addMeter(reading, value, foreground, family === 'medium' ? 100 : 88);
    const provenance = [offline || p.stale ? T.old : '', manual ? T.manual : ''].filter(Boolean).join(' · ');
    const status = ready ? provenance || w.label || T.current : w ? T.refresh : manual ? T.enter : p.status === 'unsupported' ? T.unsupported : T.connectNeeded;
    reading.addSpacer(3);
    addLabel(reading, status, Font.systemFont(10));
    if (family === 'medium') {
      const secondary = (p.windows || []).find(window => window !== w);
      if (secondary) { reading.addSpacer(4); const secondaryUsed = used(secondary); addLabel(reading, `${secondary.label} ${secondaryUsed !== null ? Math.round(secondaryUsed) + '% ' + T.used : T.refresh}`, Font.systemFont(10)); }
    }
  }
  widget.addSpacer();
  const confirmations = shown.filter(p => p.windows?.length).map(p => new Date(p.lastSuccessAt || p.updatedAt).getTime()).filter(Number.isFinite);
  const confirmedAt = confirmations.length ? Math.min(...confirmations) : null;
  const time = confirmedAt ? new Date(confirmedAt).toLocaleTimeString(english ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
  const extra = state.providers.length > shown.length ? T.more(state.providers.length - shown.length) : '';
  addLabel(widget, `${offline ? T.offline : shown.every(p => p.manual || p.mode === 'manual') ? T.entered : T.checked} ${time}${extra}`, Font.systemFont(10));
}
if (validEndpoint) widget.url = endpoint;
widget.refreshAfterDate = new Date(Date.now() + 5 * 60000); // iOS가 실제 갱신 시점을 결정합니다.
Script.setWidget(widget);
if (!config.runsInWidget) await widget.presentMedium();
Script.complete();
