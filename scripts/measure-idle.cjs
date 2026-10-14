'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const baseline = process.argv.includes('--baseline');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-resource-measure-'));
app.setPath('userData', folder); process.argv.push('--hidden');
const accounts = ['claude', 'claude', 'codex'].map((providerId, i) => ({ id: `measure-${i}`, providerId, label: i === 1 ? '회사 계정' : '기본 계정', mode: 'manual', visible: true, recordedAt: new Date().toISOString(), manualWindows: [{ id: 'manual-0', label: '5시간', usedPercent: 57 + i, remainingPercent: 43 - i, resetsAt: new Date(Date.now() + 7200000).toISOString(), durationMinutes: 300 }, { id: 'manual-1', label: '주간', usedPercent: 30 + i, remainingPercent: 70 - i, resetsAt: new Date(Date.now() + 86400000).toISOString(), durationMinutes: 10080 }] }));
fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ settings: { accounts, startHidden: true, refreshSeconds: 300, notifications: false, resetNotifications: false }, mobileKey: 'a'.repeat(64) }));
require(baseline ? path.resolve('dist/win-unpacked/resources/app.asar/src/main.cjs') : '../src/main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function metrics() {
  const processes = app.getAppMetrics();
  return { processCount: processes.length, windowCount: BrowserWindow.getAllWindows().length, workingSetMB: Math.round(processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0) / 1024 * 10) / 10, privateMB: Math.round(processes.reduce((sum, p) => sum + (p.memory.privateBytes || 0), 0) / 1024 * 10) / 10, cpuPercentSum: processes.reduce((sum, p) => sum + p.cpu.percentCPUUsage, 0), processes: processes.map(p => ({ type: p.type, workingSetMB: Math.round(p.memory.workingSetSize / 1024) })) };
}
app.whenReady().then(async () => {
  await delay(2000); const hiddenStartup = metrics();
  app.emit('activate'); await delay(2000); const visible = metrics();
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  await delay(14000); metrics(); await delay(10000); const idle = metrics();
  const measuredVersion = baseline ? JSON.parse(require('@electron/asar').extractFile(path.resolve('dist/win-unpacked/resources/app.asar'), 'package.json')).version : require('../package.json').version;
  const result = { mode: baseline ? `baseline-${measuredVersion}` : `current-${measuredVersion}`, logicalProcessors: os.cpus().length, profile: '3 manual accounts, 2 windows per account; idle CPU sampled for 10 seconds, automatic polling excluded', hiddenStartup, visible, idle };
  fs.mkdirSync(path.resolve('artifacts'), { recursive: true }); fs.writeFileSync(path.resolve('artifacts', baseline ? 'performance-before.json' : 'performance-after.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
