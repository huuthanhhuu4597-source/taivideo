@echo off
chcp 65001 >nul
title Test Douyin - Full Diagnostic
cd /d "%~dp0"

echo ============================================
echo   KIEM TRA TOAN DIEN DOUYIN DOWNLOAD
echo ============================================
echo.

runtime\node.exe -e "
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// DNS-over-HTTPS resolver: bypass ISP DNS block
async function dohResolve(hostname) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '1.1.1.1',
      path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
      method: 'GET',
      headers: { 'Accept': 'application/dns-json' },
      timeout: 5000,
      rejectUnauthorized: false
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const a = json.Answer && json.Answer.find(r => r.type === 1);
          resolve(a ? a.data : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function reqWithDOH(url, opts = {}) {
  const u = new URL(url);
  
  // Thử resolve qua DoH trước
  let ip = null;
  try {
    ip = await dohResolve(u.hostname);
  } catch (e) {}
  
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: ip || u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Host': u.hostname,  // Quan trọng khi dùng IP thay hostname
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        ...(opts.headers || {})
      },
      rejectUnauthorized: false,
      timeout: 10000
    };
    
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers, ip }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('TIMEOUT')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const VIDEO_ID = '7709333983179410698';
const VIDEO_URL = 'https://www.douyin.com/video/' + VIDEO_ID;

async function main() {
  console.log('=== TEST 1: DoH DNS Resolver ===');
  const domains = ['1.1.1.1', 'tikwm.com', 'api.tikwm.com', 'www.tikwm.com', 'api.douyin.wtf', 'musicaldown.com'];
  for (const d of domains) {
    if (d === '1.1.1.1') {
      try {
        const r = await reqWithDOH('https://1.1.1.1/dns-query?name=tikwm.com&type=A');
        console.log('  Cloudflare DoH: ' + r.status + ' - ' + r.body.substring(0, 100));
      } catch(e) { console.log('  Cloudflare DoH: ERROR ' + e.message); }
    } else {
      const ip = await dohResolve(d);
      console.log('  DoH[' + d + ']: ' + (ip || 'NOT RESOLVED'));
    }
  }
  
  console.log('');
  console.log('=== TEST 2: TikWM POST via DoH ===');
  try {
    const body = 'url=' + encodeURIComponent(VIDEO_URL) + '&hd=1';
    const r = await reqWithDOH('https://api.tikwm.com/api/', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.tikwm.com/' }
    });
    console.log('  Status: ' + r.status + ' IP: ' + r.ip);
    console.log('  Body: ' + r.body.substring(0, 300));
  } catch(e) { console.log('  TikWM POST ERROR: ' + e.message); }
  
  console.log('');
  console.log('=== TEST 3: TikWM GET via DoH ===');
  try {
    const r = await reqWithDOH('https://www.tikwm.com/api/?url=' + encodeURIComponent(VIDEO_URL) + '&hd=1');
    console.log('  Status: ' + r.status + ' IP: ' + r.ip);
    console.log('  Body: ' + r.body.substring(0, 300));
  } catch(e) { console.log('  TikWM GET ERROR: ' + e.message); }
  
  console.log('');
  console.log('=== TEST 4: yt-dlp + cookie file ===');
  const cookieFile = path.join(__dirname, 'runtime', 'douyin_cookies.txt');
  if (fs.existsSync(cookieFile)) {
    console.log('  Cookie file ton tai: ' + fs.statSync(cookieFile).size + ' bytes');
    execFile(
      path.join(__dirname, 'runtime', 'yt-dlp.exe'),
      ['--no-playlist', '--get-url', '--cookies', cookieFile, '--no-warnings', VIDEO_URL],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          console.log('  yt-dlp ERROR: ' + (stderr || err.message).substring(0, 300));
        } else {
          console.log('  yt-dlp OK: ' + stdout.substring(0, 300));
        }
        console.log('');
        console.log('=== XONG ===');
      }
    );
  } else {
    console.log('  Khong co cookie file!');
    console.log('=== XONG ===');
  }
}

main().catch(e => console.error('FATAL:', e));
"

echo.
pause
