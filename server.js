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

/**
 * BỘ ĐIỀU PHỐI LUỒNG TẢI SIÊU TỐC & HỖ TRỢ RESUME TỨC THÌ (INSTANT CHROME RESUME ENGINE)
 * - Tự động loại bỏ If-Range để máy chủ CDN Trung Quốc lập tức chấp nhận và trả về HTTP 206
 * - Truyền dữ liệu trực tiếp bằng pipe() để dữ liệu đổ về Chrome ngay lập tức (0.1 giây)
 * - Khóa ETag cố định để Chrome nhớ trọn vẹn phần đã tải (không bao giờ quay về 0%)
 */
function streamToClientWithRange(req, res, targetUrl, filename, customHeaders = {}, totalKnownSize = 0) {
  req.setTimeout(0);
  res.setTimeout(0);

  // 1. Phân tích yêu cầu Range từ Chrome (Ví dụ: bytes=2254857830-)
  const rangeHeader = req.headers.range;
  let clientStart = null;
  let clientEnd = null;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
    if (match) {
      clientStart = parseInt(match[1], 10);
      if (match[2]) clientEnd = parseInt(match[2], 10);
    }
  }

  const isRangeRequest = (clientStart !== null);

  // 2. Tạo ETag và Last-Modified cố định (BẮT BUỘC để Chrome cho phép nối tiếp)
  const cleanUrl = String(targetUrl).split('?')[0];
  const etag = '"' + crypto.createHash('md5').update(filename + cleanUrl).digest('hex') + '"';
  const lastModified = 'Sun, 01 Jan 2026 00:00:00 GMT';

  let isHeadersSent = false;
  let currentActiveReq = null;
  let currentActiveStream = null;

  req.on('close', () => {
    if (currentActiveStream) { try { currentActiveStream.destroy(); } catch (e) {} }
    if (currentActiveReq) { try { currentActiveReq.destroy(); } catch (e) {} }
  });

  function connect(currentFetchUrl, byteOffset = 0, redirectsLeft = 5, retriesLeft = 10) {
    if (res.writableEnded || res.destroyed) return;
    if (redirectsLeft <= 0) {
      if (!res.headersSent) res.status(502).send('Quá nhiều chuyển hướng');
      return;
    }

    try {
      const parsed = new URL(currentFetchUrl);
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
        'Referer': referer,
        'Accept-Encoding': 'identity',
        ...customHeaders
      };

      // Xác định byte bắt đầu cần kéo từ máy chủ CDN
      const upstreamStart = (byteOffset > 0) ? byteOffset : (clientStart !== null ? clientStart : 0);
      if (upstreamStart > 0) {
        headers['Range'] = "bytes=" + upstreamStart + "-";
      }

      // TUYỆT ĐỐI KHÔNG gửi If-Range của client lên CDN để tránh CDN từ chối Range và trả về 200
      const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

      currentActiveReq = client.get(currentFetchUrl, { headers, agent, highWaterMark: 2 * 1024 * 1024 }, (stream) => {
        currentActiveStream = stream;

        // Xử lý chuyển hướng 301/302
        if ([301, 302, 303, 307, 308].includes(stream.statusCode) && stream.headers.location && !isHeadersSent) {
          let nextUrl = stream.headers.location;
          if (nextUrl.startsWith('//')) nextUrl = 'https:' + nextUrl;
          else if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, currentFetchUrl).toString();
          return connect(nextUrl, byteOffset, redirectsLeft - 1, retriesLeft);
        }

        const upstreamStatusCode = stream.statusCode;
        const upstreamIs206 = (upstreamStatusCode === 206);

        // Xác định tổng kích thước file
        let fullFileSize = totalKnownSize;
        if (stream.headers['content-range']) {
          const m = stream.headers['content-range'].match(/\/(\d+)/);
          if (m) fullFileSize = parseInt(m[1], 10);
        }
        if (!fullFileSize && stream.headers['content-length']) {
          const cl = parseInt(stream.headers['content-length'], 10);
          if (upstreamIs206 && upstreamStart > 0) {
            fullFileSize = upstreamStart + cl;
          } else {
            fullFileSize = cl;
          }
        }

        // GỬI HEADERS CHO CHROME (CHỈ 1 LẦN DUY NHẤT)
        if (!isHeadersSent) {
          isHeadersSent = true;
          res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('ETag', etag);
          res.setHeader('Last-Modified', lastModified);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          if (res.socket) res.socket.setNoDelay(true);

          if (isRangeRequest) {
            // BẮT BUỘC TRẢ VỀ 206 ĐỂ CHROME TẢI NỐI TIẾP
            res.status(206);
            const end = (clientEnd !== null) ? clientEnd : (fullFileSize > 0 ? fullFileSize - 1 : undefined);
            if (fullFileSize > 0 && end !== undefined) {
              res.setHeader('Content-Range', "bytes " + clientStart + "-" + end + "/" + fullFileSize);
              res.setHeader('Content-Length', end - clientStart + 1);
            } else if (stream.headers['content-range']) {
              res.setHeader('Content-Range', stream.headers['content-range']);
              if (stream.headers['content-length']) res.setHeader('Content-Length', stream.headers['content-length']);
            }
          } else {
            res.status(upstreamStatusCode || 200);
            if (stream.headers['content-length']) {
              res.setHeader('Content-Length', stream.headers['content-length']);
            }
          }
        }

        // TRUYỀN DỮ LIỆU TỐC ĐỘ TỐI ĐA VỀ CHROME NGAY LẬP TỨC
        if (upstreamIs206 || !isRangeRequest) {
          // CDN trả về đúng 206 -> Bơm trực tiếp vào Chrome siêu tốc không delay!
          stream.pipe(res);
        } else {
          // Fallback nếu CDN gửi 200: Bỏ qua các byte đã tải và bơm tiếp
          let skipBytes = upstreamStart;
          stream.on('data', (chunk) => {
            if (skipBytes > 0) {
              if (chunk.length <= skipBytes) {
                skipBytes -= chunk.length;
                return;
              } else {
                chunk = chunk.slice(skipBytes);
                skipBytes = 0;
              }
            }
            res.write(chunk);
          });
          stream.on('end', () => { if (!res.writableEnded) res.end(); });
        }

        stream.on('error', (err) => {
          console.warn('[Stream Error]', err.message);
          if (!res.writableEnded) res.end();
        });
      });

      currentActiveReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 15000);
      });

      currentActiveReq.on('error', (err) => {
        console.warn('[Request Error]', err.message);
        if (!res.headersSent) res.status(502).send('Lỗi kết nối máy chủ CDN: ' + err.message);
        else if (!res.writableEnded) res.end();
      });

    } catch (e) {
      if (!res.headersSent) res.status(400).send('URL không hợp lệ: ' + e.message);
      else if (!res.writableEnded) res.end();
    }
  }

  connect(targetUrl);
}

// Proxy Stream Download: Hỗ trợ mọi video tải tiếp Resume mượt mà trên Chrome
app.get('/api/stream-download', (req, res) => {
  let targetUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!targetUrl) return res.status(400).send('Thiếu URL tải về');

  targetUrl = String(targetUrl).trim();
  if (targetUrl.startsWith('//')) {
    targetUrl = 'https:' + targetUrl;
  }

  streamToClientWithRange(req, res, targetUrl, filename);
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
      const req = require('https').get({
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
      });
      req.setTimeout(8000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      req.on('error', reject);
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

    // 3. Đặt tên file chuẩn và truyền qua bộ điều phối Range siêu bền (Resume 206)
    const safeFilename = (filename || `${bvid}_part${part || 1}.mp4`)
      .replace(/[^\w.\-\u4E00-\u9FFF\u3040-\u30FF]+/g, '_');

    return streamToClientWithRange(req, res, freshCdnUrl, safeFilename, { 'Referer': 'https://www.bilibili.com/' }, totalBytes);

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
