@echo off
chcp 65001 >nul
title Test Douyin APIs
cd /d "%~dp0"

echo ============================================
echo   KIEM TRA CAC API DOUYIN DANG HOAT DONG
echo ============================================
echo.

runtime\node.exe -e "
const https = require('https');
const http = require('http');

function req(url, opts) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts && opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        ...(opts && opts.headers || {})
      },
      timeout: 8000,
      rejectUnauthorized: false
    };
    const r = mod.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => res({ status: resp.statusCode, body: data, headers: resp.headers }));
    });
    r.on('error', rej);
    r.on('timeout', () => { r.destroy(); rej(new Error('TIMEOUT')); });
    if (opts && opts.body) r.write(opts.body);
    r.end();
  });
}

const VIDEO_ID = '7709333983179410698';
const VIDEO_URL = 'https://www.douyin.com/video/' + VIDEO_ID;

async function test() {
  const apis = [
    {
      name: 'TikWM POST (api.tikwm.com)',
      fn: async () => {
        const body = 'url=' + encodeURIComponent(VIDEO_URL) + '&hd=1';
        const r = await req('https://api.tikwm.com/api/', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }});
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'TikWM GET (www.tikwm.com)',
      fn: async () => {
        const r = await req('https://www.tikwm.com/api/?url=' + encodeURIComponent(VIDEO_URL) + '&hd=1');
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'Douyin.wtf',
      fn: async () => {
        const r = await req('https://api.douyin.wtf/api?url=' + encodeURIComponent(VIDEO_URL) + '&minimal=true');
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'TiklyDown',
      fn: async () => {
        const r = await req('https://api.tiklydown.eu.org/api/download/v3?url=' + encodeURIComponent(VIDEO_URL));
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'SnapAny (Hybridstuff)',
      fn: async () => {
        const r = await req('https://snaptik.app/api2.php?token=&url=' + encodeURIComponent(VIDEO_URL));
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'TikSave API',
      fn: async () => {
        const r = await req('https://tiksave.app/api?url=' + encodeURIComponent(VIDEO_URL));
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'SSSTik Douyin',
      fn: async () => {
        const r = await req('https://ssstik.io/abc', { method: 'POST', body: 'id=' + encodeURIComponent(VIDEO_URL) + '&locale=en&tt=xyz', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://ssstik.io/' }});
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'Cobalt.tools',
      fn: async () => {
        const body = JSON.stringify({ url: VIDEO_URL });
        const r = await req('https://co.wuk.sh/api/json', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }});
        return r.status + ' ' + r.body.substring(0, 200);
      }
    },
    {
      name: 'yt-dlp + cookies file',
      fn: async () => {
        const { execFile } = require('child_process');
        const path = require('path');
        return new Promise((resolve) => {
          const args = ['--no-playlist', '--get-url', '--cookies', path.join(__dirname, 'runtime', 'douyin_cookies.txt'), VIDEO_URL];
          execFile(path.join(__dirname, 'runtime', 'yt-dlp.exe'), args, { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) resolve('FAIL: ' + (stderr || err.message).substring(0, 200));
            else resolve('OK: ' + stdout.substring(0, 200));
          });
        });
      }
    }
  ];

  for (const api of apis) {
    process.stdout.write('[TEST] ' + api.name + '... ');
    try {
      const result = await api.fn();
      console.log('RESULT: ' + result);
    } catch (e) {
      console.log('ERROR: ' + e.message);
    }
  }
  console.log('\\n=== XONG ===');
}

test();
"

echo.
pause
