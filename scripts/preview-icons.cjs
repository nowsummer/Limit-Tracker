const { app, BrowserWindow } = require('electron'); const fs = require('node:fs');
const { iconPng, trayGaugePng } = require('../src/icons.cjs');
// The preview must show actual source pixels rather than inherit desktop DPI.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({width:1080,height:650,show:false,webPreferences:{sandbox:true}});
  let html = '<body style="margin:0;font:14px Segoe UI;background:#f2f3f6"><header style="padding:20px;font-weight:600">Limit Tracker · 원형 트레이 · 실제 렌더 크기 16 / 20 / 24 / 32 / 48px</header>';
  for(const dark of [true,false]) {
    html += `<section style="padding:20px;background:${dark?'#20232e':'#fff'};color:${dark?'#ddd':'#222'};display:flex;gap:16px;align-items:end">`;
    for(const value of [0,7,57,95,100,null]) {
      html += '<div style="text-align:center"><div style="display:flex;gap:4px;align-items:center;margin-bottom:12px">';
      for(const size of [16,20,24,32,48]) html += `<img width="${size}" height="${size}" src="data:image/png;base64,${trayGaugePng(size,value,{dark}).toString('base64')}">`;
      html += `</div><small>${value===null?'미확인':value+'% 사용'}</small></div>`;
    }
    html += '</section>';
  }
  html += '<header style="padding:20px;font-weight:600">16px 원본 픽셀을 4배 확대 · 숫자와 링 사이 간격 검수</header><section style="padding:20px;background:#20232e;display:flex;gap:28px">';
  for (const value of [0,7,57,95,100,null]) html += `<img style="image-rendering:pixelated" width="64" height="64" src="data:image/png;base64,${trayGaugePng(16,value,{dark:true}).toString('base64')}">`;
  html += '</section>';
  html += `<div style="padding:20px;display:flex;gap:20px;align-items:center"><img width="32" src="data:image/png;base64,${iconPng(64).toString('base64')}"><img width="64" src="data:image/png;base64,${iconPng(128).toString('base64')}">프로그램 · 창 · 작업표시줄 공통 아이콘</div></body>`;
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  win.show(); await new Promise(resolve => setTimeout(resolve, 1000));
  fs.writeFileSync('artifacts/icons-v4.png',(await win.webContents.capturePage()).toPNG()); app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
