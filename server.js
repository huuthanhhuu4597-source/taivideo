const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { parseAnyVideo } = require('./downloader-core');

// Tối ưu kết nối mạng: Tái sử dụng socket TCP/TLS với Keep-Alive & High Buffer để tải video tốc độ tối đa
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 50,
  timeout: 120000,
  keepAliveMsecs: 30000
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 50,
  timeout: 120000,
  keepAliveMsecs: 30000
});

const app = express();
const PORT = process.env.PORT || 4000;

function getYtDlpPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'runtime', 'yt-dlp.exe');
  }
  const fs = require('fs');
  const localLinux = path.join(__dirname, 'runtime', 'yt-dlp');
  if (fs.existsSync(localLinux)) return localLinux;
  return 'yt-dlp';
}

const ytdlpPath = getYtDlpPath();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const fs = require('fs');
  const pPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(pPath)) return res.sendFile(pPath);
  return res.sendFile(path.join(__dirname, 'index.html'));
});

// API: Phân tích đường dẫn video đa nền tảng
app.post('/api/parse', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, message: 'Vui lòng cung cấp link video cần tải.' });
  }

  try {
    const result = await parseAnyVideo(url);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Lỗi khi phân tích video.' });
  }
});

// Proxy Stream Download: Hỗ trợ video dài, tự động Follow Redirect (302/301), sửa URL // và giữ Referer chống 403
app.get('/api/stream-download', (req, res) => {
  let targetUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!targetUrl) return res.status(400).send('Thiếu URL tải về');

  // Chuẩn hóa URL nếu thiếu giao thức (//v3-web... -> https://v3-web...)
  targetUrl = String(targetUrl).trim();
  if (targetUrl.startsWith('//')) {
    targetUrl = 'https:' + targetUrl;
  }

  // VÔ HIỆU HÓA TIMEOUT: Giữ kết nối mở liên tục cho đến khi tải hoàn toàn 100%
  req.setTimeout(0);
  res.setTimeout(0);

  let totalExpectedBytes = 0;
  let totalDownloadedBytes = 0;
  let currentTargetUrl = targetUrl;
  let isHeadersSent = false;
  let activeStream = null;
  let activeReq = null;

  req.on('close', () => {
    if (activeStream) { try { activeStream.destroy(); } catch (e) {} }
    if (activeReq) { try { activeReq.destroy(); } catch (e) {} }
  });

  function connectAndStream(urlToFetch, byteOffset = 0, retriesLeft = 10) {
    if (res.writableEnded || res.destroyed) return;
    currentTargetUrl = urlToFetch;

    try {
      let parsed = new URL(urlToFetch);
      const client = parsed.protocol === 'https:' ? https : http;

      let referer = parsed.origin;
      let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      if (parsed.hostname.includes('bilivideo') || parsed.hostname.includes('bilibili')) {
        referer = 'https://www.bilibili.com/';
      } else if (parsed.hostname.includes('snssdk.com') || parsed.hostname.includes('douyinvod.com') || parsed.hostname.includes('amemv.com') || parsed.hostname.includes('iesdouyin.com') || parsed.hostname.includes('douyin')) {
        referer = 'https://www.douyin.com/';
        userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
      } else if (parsed.hostname.includes('tiktok.com') || parsed.hostname.includes('tiktokcdn.com')) {
        referer = 'https://www.tiktok.com/';
      } else if (parsed.hostname.includes('fbcdn.net') || parsed.hostname.includes('facebook.com')) {
        referer = 'https://www.facebook.com/';
      }

      const headers = {
        'User-Agent': userAgent,
        'Referer': referer
      };

      if (byteOffset > 0) {
        headers['Range'] = "bytes=" + byteOffset + "-";
      } else if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }
      if (req.headers['if-range']) {
        headers['If-Range'] = req.headers['if-range'];
      }

      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

      activeReq = client.get(urlToFetch, { headers, agent, highWaterMark: 1024 * 1024 }, (stream) => {
        activeStream = stream;

        // Tự động theo dõi chuyển hướng 301/302 nếu chưa gửi headers
        if ([301, 302, 303, 307, 308].includes(stream.statusCode) && stream.headers.location && !isHeadersSent) {
          let nextUrl = stream.headers.location;
          if (nextUrl.startsWith('//')) nextUrl = 'https:' + nextUrl;
          else if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, urlToFetch).toString();
          return connectAndStream(nextUrl, byteOffset, retriesLeft);
        }

        if (!isHeadersSent) {
          isHeadersSent = true;
          res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Accept-Ranges', 'bytes');
          const stableHash = crypto.createHash('md5').update(filename + (targetUrl.split('?')[0])).digest('hex');
          res.setHeader('ETag', '"' + stableHash + '"');
          res.setHeader('Last-Modified', 'Sun, 01 Jan 2026 00:00:00 GMT');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          if (res.socket) res.socket.setNoDelay(true);

          res.status(stream.statusCode || 200);

          if (stream.headers['content-length']) {
            totalExpectedBytes = parseInt(stream.headers['content-length'], 10);
            res.setHeader('Content-Length', stream.headers['content-length']);
          }
          if (stream.headers['content-range']) {
            res.setHeader('Content-Range', stream.headers['content-range']);
            const match = stream.headers['content-range'].match(/\/(\d+)/);
            if (match) totalExpectedBytes = parseInt(match[1], 10);
          }
        }

        stream.on('data', (chunk) => {
          totalDownloadedBytes += chunk.length;
          res.write(chunk);
        });

        stream.on('end', () => {
          // CHỐNG RỚT MẠNG: Nếu chưa tải đủ 100% số byte, TỰ ĐỘNG NỐI TIẾP kết nối không ngắt Chrome!
          if (totalExpectedBytes > 0 && totalDownloadedBytes < totalExpectedBytes && retriesLeft > 0) {
            console.warn('[Auto-Resume] CDN bị ngắt ở ' + totalDownloadedBytes + '/' + totalExpectedBytes + ' bytes. Đang tự động kết nối lại nối tiếp...');
            setTimeout(() => {
              connectAndStream(currentTargetUrl, totalDownloadedBytes, retriesLeft - 1);
            }, 800);
          } else {
            // ĐÃ TẢI HOÀN TOÀN 100% -> LÚC NÀY MỚI NGẮT KẾT NỐI!
            if (!res.writableEnded) res.end();
          }
        });

        stream.on('error', (err) => {
          console.warn('[Stream Error]', err.message);
          if (totalExpectedBytes > 0 && totalDownloadedBytes < totalExpectedBytes && retriesLeft > 0) {
            console.warn('[Auto-Resume] Lỗi luồng CDN, đang tự động kết nối lại từ byte ' + totalDownloadedBytes + '...');
            setTimeout(() => {
              connectAndStream(currentTargetUrl, totalDownloadedBytes, retriesLeft - 1);
            }, 1000);
          } else {
            if (!res.writableEnded) res.end();
          }
        });
      });

      activeReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
      });

      activeReq.on('error', (err) => {
        console.warn('[StreamReq Error]', err.message);
        if (totalExpectedBytes > 0 && totalDownloadedBytes < totalExpectedBytes && retriesLeft > 0) {
          setTimeout(() => {
            connectAndStream(currentTargetUrl, totalDownloadedBytes, retriesLeft - 1);
          }, 1500);
        } else if (!res.headersSent) {
          res.status(502).send('Lỗi kết nối máy chủ CDN: ' + err.message);
        } else {
          if (!res.writableEnded) res.end();
        }
      });

    } catch (e) {
      if (!res.headersSent) res.status(400).send('URL không hợp lệ: ' + e.message);
      else if (!res.writableEnded) res.end();
    }
  }

  connectAndStream(targetUrl);
});

// Tải trực tiếp qua yt-dlp core cho YouTube & các nền tảng phức tạp
app.get('/api/ytdlp-download', (req, res) => {
  const targetUrl = req.query.url;
  const quality = req.query.quality || '1080';
  const isAudio = req.query.audio === 'true';
  const filename = req.query.filename || (isAudio ? 'audio.mp3' : 'video.mp4');

  if (!targetUrl) return res.status(400).send('Thiếu URL video');

  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  if (res.socket) res.socket.setNoDelay(true);

  let formatSelector = '';
  if (isAudio) {
    formatSelector = 'bestaudio/best';
  } else {
    formatSelector = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
  }

  const ytdlpArgs = [
    '--no-playlist',
    '--format', formatSelector,
    '--output', '-',
    '--concurrent-fragments', '8',
    '--buffer-size', '64K'
  ];

  if (isAudio) {
    ytdlpArgs.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  const fs = require('fs');
  const cookiesPath = path.join(__dirname, 'runtime', 'douyin_cookies.txt');
  if (fs.existsSync(cookiesPath) && (targetUrl.includes('douyin') || targetUrl.includes('tiktok'))) {
    ytdlpArgs.push('--cookies', cookiesPath);
  }

  ytdlpArgs.push(targetUrl);

  const proc = spawn(ytdlpPath, ytdlpArgs);

  proc.stdout.pipe(res);

  proc.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('ERROR:')) console.error('[yt-dlp error]', msg.trim());
  });

  proc.on('error', (err) => {
    console.error('[yt-dlp spawn error]', err.message);
    if (!res.headersSent) res.status(500).send('Lỗi khi khởi chạy yt-dlp: ' + err.message);
  });

  req.on('close', () => {
    try { proc.kill('SIGKILL'); } catch (e) {}
  });
});

// ===========================================================================
// Route chuyên dụng: TẢI TRỰC TIẾP VIDEO BILIBILI 1080P/720P FULL AUDIO
// ===========================================================================
app.get('/api/bili-download', async (req, res) => {
  const { bvid, cid, part, filename } = req.query;
  if (!bvid || !cid) return res.status(400).send('Thiếu bvid hoặc cid');

  req.setTimeout(0);
  res.setTimeout(0);

  function tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
      const opts = new URL(url);
      require('https').get({
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers }
      }, (r) => {
        if ([301,302,303,307,308].includes(r.statusCode) && r.headers.location) {
          return resolve(httpsGet(r.headers.location, headers));
        }
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, body: d, headers: r.headers }));
      }).on('error', reject);
    });
  }

  try {
    let cookie = '';
    try {
      const spi = await httpsGet('https://api.bilibili.com/x/frontend/finger/spi', { 'Referer': 'https://www.bilibili.com/' });
      const spiJson = tryParseJson(spi.body);
      if (spiJson?.data?.b_3) cookie = `buvid3=${spiJson.data.b_3}; buvid4=${spiJson.data.b_4 || ''};`;
    } catch (e) { }

    let freshCdnUrl = null;
    let rawCdnUrl = null;
    let totalBytes = 0;

    for (const qn of [64, 80, 32, 16]) {
      try {
        const playApiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&type=mp4&platform=html5`;
        const reqHeaders = { 'Referer': `https://www.bilibili.com/video/${bvid}` };
        if (cookie) reqHeaders['Cookie'] = cookie;

        const pRes = await httpsGet(playApiUrl, reqHeaders);
        const pJson = tryParseJson(pRes.body);

        if (pJson && pJson.code === 0 && pJson.data?.durl?.[0]?.url) {
          rawCdnUrl = pJson.data.durl[0].url;
          totalBytes = pJson.data.durl[0].size || 0;

          const backupList = pJson.data.durl[0].backup_url || [];
          const fastBackup = backupList.find(u => /mirrorcos|mirrorali|mirrorhw/i.test(u));

          if (fastBackup) {
            freshCdnUrl = fastBackup;
          } else if (rawCdnUrl.includes('bilivideo.com') || rawCdnUrl.includes('bilivideo.cn')) {
            freshCdnUrl = rawCdnUrl.replace(/https?:\/\/[^\/]+/, 'https://upos-sz-mirrorcos.bilivideo.com');
          } else {
            freshCdnUrl = rawCdnUrl;
          }
          break;
        }

        if (pRes.status === 412 && cookie) {
          cookie = '';
          continue;
        }
      } catch (e) { continue; }
    }

    if (!freshCdnUrl) {
      return res.status(502).send(
        'Bilibili đang chặn tải trực tiếp từ server này (IP bị giới hạn). ' +
        'Vui lòng thử lại sau vài giây.'
      );
    }

    const safeFilename = (filename || `${bvid}_part${part || 1}.mp4`)
      .replace(/[^\w.\-\u4E00-\u9FFF\u3040-\u30FF]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    const biliHash = crypto.createHash('md5').update(safeFilename + bvid + cid).digest('hex');
    res.setHeader('ETag', '"' + biliHash + '"');
    res.setHeader('Last-Modified', 'Sun, 01 Jan 2026 00:00:00 GMT');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (!req.headers.range && totalBytes > 0) res.setHeader('Content-Length', totalBytes);
    if (res.socket) res.socket.setNoDelay(true);

    const streamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (req.headers.range) streamHeaders['Range'] = req.headers.range;
    if (req.headers['if-range']) streamHeaders['If-Range'] = req.headers['if-range'];

    // 5. Proxy stream với cơ chế tự động Auto-Resume nối tiếp đến khi tải đủ 100%
    let biliDownloadedBytes = 0;
    let biliExpectedBytes = totalBytes;
    let isBiliHeadersSent = false;

    function streamFromUrl(targetCdn, fallbackTarget, retriesLeft = 10) {
      if (res.writableEnded || res.destroyed) return;

      const currentHeaders = { ...streamHeaders };
      if (biliDownloadedBytes > 0) {
        currentHeaders['Range'] = "bytes=" + biliDownloadedBytes + "-";
      }

      const biliReq = https.get(targetCdn, { headers: currentHeaders, agent: httpsAgent, highWaterMark: 1024 * 1024 }, (stream) => {
        if (stream.statusCode >= 400 && fallbackTarget && targetCdn !== fallbackTarget && !isBiliHeadersSent) {
          console.warn("[Bili Turbo CDN] Mirror lỗi, chuyển về CDN gốc");
          return streamFromUrl(fallbackTarget, null, retriesLeft);
        }

        if (!isBiliHeadersSent) {
          isBiliHeadersSent = true;
          res.status(stream.statusCode || 200);
          if (stream.headers['content-length']) {
            biliExpectedBytes = parseInt(stream.headers['content-length'], 10);
            res.setHeader('Content-Length', stream.headers['content-length']);
          }
          if (stream.headers['content-range']) {
            res.setHeader('Content-Range', stream.headers['content-range']);
            const m = stream.headers['content-range'].match(/\/(\d+)/);
            if (m) biliExpectedBytes = parseInt(m[1], 10);
          }
        }

        stream.on('data', (chunk) => {
          biliDownloadedBytes += chunk.length;
          res.write(chunk);
        });

        stream.on('end', () => {
          if (biliExpectedBytes > 0 && biliDownloadedBytes < biliExpectedBytes && retriesLeft > 0) {
            console.warn('[Bili Auto-Resume] Bilibili bị ngắt ở ' + biliDownloadedBytes + '/' + biliExpectedBytes + '. Đang tự động kết nối lại nối tiếp...');
            setTimeout(() => {
              streamFromUrl(targetCdn, fallbackTarget, retriesLeft - 1);
            }, 800);
          } else {
            if (!res.writableEnded) res.end();
          }
        });

        stream.on('error', (e) => {
          console.warn('[Bili CDN stream error]', e.message);
          if (biliExpectedBytes > 0 && biliDownloadedBytes < biliExpectedBytes && retriesLeft > 0) {
            setTimeout(() => {
              streamFromUrl(fallbackTarget || targetCdn, null, retriesLeft - 1);
            }, 1000);
          } else {
            if (!res.writableEnded) res.end();
          }
        });
      });

      biliReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
      });

      biliReq.on('error', (err) => {
        console.warn("[Bili CDN Connect Error]", err.message);
        if (fallbackTarget && targetCdn !== fallbackTarget && !isBiliHeadersSent) {
          return streamFromUrl(fallbackTarget, null, retriesLeft);
        }
        if (biliExpectedBytes > 0 && biliDownloadedBytes < biliExpectedBytes && retriesLeft > 0) {
          setTimeout(() => {
            streamFromUrl(fallbackTarget || targetCdn, null, retriesLeft - 1);
          }, 1500);
        } else if (!res.headersSent) {
          res.status(502).send('Không kết nối được CDN Bilibili: ' + err.message);
        } else {
          if (!res.writableEnded) res.end();
        }
      });
    }

    streamFromUrl(freshCdnUrl, rawCdnUrl);
  } catch (err) {
    console.error('[/api/bili-download]', err.message);
    if (!res.headersSent) res.status(500).send('Lỗi máy chủ: ' + err.message);
  }
});

const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 WEB TẢI VIDEO ĐA NỀN TẢNG (1080P HD / KHÔNG LOGO)`);
  console.log(`🌐 Truy cập ngay: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
server.timeout = 0;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
