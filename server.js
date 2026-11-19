const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
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

  // Vô hiệu hóa mọi giới hạn thời gian (No Timeout)
  req.setTimeout(0);
  res.setTimeout(0);

  function pipeFromUrl(urlToFetch, redirectsLeft = 5) {
    if (redirectsLeft <= 0) {
      if (!res.headersSent) res.status(502).send('Quá nhiều chuyển hướng (Too many redirects)');
      return;
    }

    try {
      let parsed = new URL(urlToFetch);
      const client = parsed.protocol === 'https:' ? https : http;

      // Xử lý Referer & User-Agent chống chặn cho từng nền tảng (Bilibili, Douyin, TikTok, Facebook)
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

      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

      const streamReq = client.get(urlToFetch, { headers, agent, highWaterMark: 1024 * 1024 }, (stream) => {
        // TỰ ĐỘNG THEO DÕI CHUYỂN HƯỚNG 301/302 (Đặc biệt quan trọng cho Douyin aweme.snssdk.com -> CDN)
        if ([301, 302, 303, 307, 308].includes(stream.statusCode) && stream.headers.location) {
          let nextUrl = stream.headers.location;
          if (nextUrl.startsWith('//')) nextUrl = 'https:' + nextUrl;
          else if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, urlToFetch).toString();
          return pipeFromUrl(nextUrl, redirectsLeft - 1);
        }

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        if (res.socket) res.socket.setNoDelay(true);

        res.status(stream.statusCode || 200);

        if (stream.headers['content-length']) {
          res.setHeader('Content-Length', stream.headers['content-length']);
        }
        if (stream.headers['content-range']) {
          res.setHeader('Content-Range', stream.headers['content-range']);
        }

        stream.pipe(res);

        stream.on('error', (err) => {
          console.warn('[Stream Error]', err.message);
          if (!res.writableEnded) res.end();
        });
      });

      streamReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
      });

      streamReq.on('error', (err) => {
        console.warn('[StreamReq Error]', err.message);
        if (!res.headersSent) res.status(502).send('Lỗi kết nối máy chủ CDN: ' + err.message);
      });

    } catch (e) {
      if (!res.headersSent) res.status(400).send('URL không hợp lệ: ' + e.message);
    }
  }

  pipeFromUrl(targetUrl);
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

  let formatSelector = 'best[ext=mp4]/best';
  if (isAudio) {
    formatSelector = 'bestaudio/best';
  } else if (quality === '2160' || quality === '4k') {
    formatSelector = 'best[height<=2160][ext=mp4]/best[height<=2160]/best';
  } else if (quality === '1440' || quality === '2k') {
    formatSelector = 'best[height<=1440][ext=mp4]/best[height<=1440]/best';
  } else if (quality === '1080') {
    formatSelector = 'best[height<=1080][ext=mp4]/best[height<=1080]/best';
  } else if (quality === '720') {
    formatSelector = 'best[height<=720][ext=mp4]/best[height<=720]/best';
  } else if (quality === '360') {
    formatSelector = 'best[height<=360][ext=mp4]/best[height<=360]/best';
  }

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--concurrent-fragments', '5',
    '-f', formatSelector,
    '-o', '-',
    targetUrl
  ];

  const proc = spawn(ytdlpPath, args);
  proc.stdout.pipe(res);

  proc.stderr.on('data', (d) => {
    console.warn('[yt-dlp stream log]', d.toString().trim());
  });

  proc.on('error', (err) => {
    console.error('[yt-dlp spawn error]', err.message);
    if (!res.headersSent) res.status(500).send('Lỗi engine tải yt-dlp');
    else if (!res.writableEnded) res.end();
  });

  proc.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  req.on('close', () => {
    try { proc.kill(); } catch (e) {}
  });
});

// ===========================================================================
// API TẢI BILIBILI: Luôn fetch link CDN mới ngay lúc bấm tải (không bị hết hạn)
// ===========================================================================
app.get('/api/bili-download', async (req, res) => {
  const { bvid, cid, part, filename } = req.query;
  if (!bvid || !cid) return res.status(400).send('Thiếu bvid hoặc cid');

  req.setTimeout(0);
  res.setTimeout(0);

  // Helper: thử parse JSON, trả về null nếu không phải JSON (HTML, v.v.)
  function tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Helper: gọi HTTPS đơn giản không qua fetchUrl
  function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
      const opts = new URL(url);
      require('https').get({
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers }
      }, (r) => {
        // follow redirect
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
    // 1. Lấy cookie buvid3/buvid4 — nếu thất bại thì bỏ qua (không có cookie vẫn hoạt động)
    let cookie = '';
    try {
      const spi = await httpsGet('https://api.bilibili.com/x/frontend/finger/spi', { 'Referer': 'https://www.bilibili.com/' });
      const spiJson = tryParseJson(spi.body);
      if (spiJson?.data?.b_3) cookie = `buvid3=${spiJson.data.b_3}; buvid4=${spiJson.data.b_4 || ''};`;
    } catch (e) { /* tiếp tục không có cookie */ }

    // 2. Thử lấy link CDN — thử nhiều qn (chất lượng): 64=720p, 32=480p, 16=360p
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

          // TỰ ĐỘNG ĐIỀU HƯỚNG CDN TỐC ĐỘ CAO (Bypass giới hạn băng thông PCDN Trung Quốc):
          // Bilibili mặc định gán node PCDN nội địa (chậm 150KB/s ở VN).
          // Ta ưu tiên chọn CDN Tencent Cloud (mirrorcos) hoặc Alibaba Cloud (mirrorali) quốc tế
          // để người dùng tải trực tiếp trên trình duyệt với tốc độ tối đa đường truyền (10-30 MB/s).
          const backupList = pJson.data.durl[0].backup_url || [];
          const fastBackup = backupList.find(u => /mirrorcos|mirrorali|mirrorhw/i.test(u));

          if (fastBackup) {
            freshCdnUrl = fastBackup;
          } else if (rawCdnUrl.includes('bilivideo.com') || rawCdnUrl.includes('bilivideo.cn')) {
            // Thay thế node chậm bằng Tencent Cloud CDN siêu tốc cho Đông Nam Á
            freshCdnUrl = rawCdnUrl.replace(/https?:\/\/[^\/]+/, 'https://upos-sz-mirrorcos.bilivideo.com');
          } else {
            freshCdnUrl = rawCdnUrl;
          }
          break;
        }

        // Nếu Bilibili trả về HTML (412 / WAF), thử không có cookie
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

    // 3. Đặt header trả về file
    const safeFilename = (filename || `${bvid}_part${part || 1}.mp4`)
      .replace(/[^\w.\-\u4E00-\u9FFF\u3040-\u30FF]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    if (totalBytes > 0) res.setHeader('Content-Length', totalBytes);
    res.setHeader('Accept-Ranges', 'bytes');
    if (res.socket) res.socket.setNoDelay(true);

    // 4. Forward Range header nếu client hỗ trợ resume / đa luồng
    const streamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    };
    if (req.headers.range) streamHeaders['Range'] = req.headers.range;

    // 5. Proxy stream với cơ chế tự động chuyển đổi Fallback nếu CDN lỗi
    function streamFromUrl(targetCdn, fallbackTarget) {
      const biliReq = https.get(targetCdn, { headers: streamHeaders, agent: httpsAgent, highWaterMark: 1024 * 1024 }, (stream) => {
        // Nếu CDN mirror trả về lỗi (403/404), tự động chuyển về link gốc Bilibili
        if (stream.statusCode >= 400 && fallbackTarget && targetCdn !== fallbackTarget) {
          console.warn(`[Bili Turbo CDN] Mirror ${targetCdn.slice(0, 45)}... lỗi ${stream.statusCode}, chuyển về CDN gốc`);
          return streamFromUrl(fallbackTarget, null);
        }

        res.status(stream.statusCode || 200);
        if (stream.headers['content-length']) res.setHeader('Content-Length', stream.headers['content-length']);
        if (stream.headers['content-range'])  res.setHeader('Content-Range',  stream.headers['content-range']);
        res.setHeader('Accept-Ranges', 'bytes');
        stream.pipe(res);

        stream.on('error', (e) => {
          console.warn('[Bili CDN pipe error]', e.message);
          if (!res.writableEnded) res.end();
        });
      });

      biliReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
      });

      biliReq.on('error', (err) => {
        console.warn(`[Bili CDN Connect Error]`, err.message);
        if (fallbackTarget && targetCdn !== fallbackTarget) {
          return streamFromUrl(fallbackTarget, null);
        }
        if (!res.headersSent) res.status(502).send('Không kết nối được CDN Bilibili: ' + err.message);
      });
    }

    streamFromUrl(freshCdnUrl, rawCdnUrl);

  } catch (err) {
    console.error('[/api/bili-download]', err.message);
    if (!res.headersSent) res.status(500).send('Lỗi máy chủ: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 WEB TẢI VIDEO ĐA NỀN TẢNG (1080P HD / KHÔNG LOGO)`);
  console.log(`🌐 Truy cập ngay: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
