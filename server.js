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
  maxSockets: 300,
  maxFreeSockets: 100,
  timeout: 300000,
  keepAliveMsecs: 60000
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 300,
  maxFreeSockets: 100,
  timeout: 300000,
  keepAliveMsecs: 60000
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
 * BỘ ĐIỀU PHỐI LUỒNG TẢI TỰ ĐỘNG CHỮA LỖI & CHỐNG NGẮT QUÃNG (AUTO-HEAL CONTINUOUS ENGINE)
 * - Tự động phát hiện khi máy chủ CDN ngắt kết nối giữa chừng (ví dụ giới hạn 2GB của Bilibili/Douyin)
 * - Tự động kết nối lại CDN tại đúng byte đang ngắt mà KHÔNG ngắt kết nối với Chrome
 * - Chrome tải liên tục 1 mạch từ 0% đến 100% (dù file 5GB hay 10GB, video 9 tiếng) mà không bị đứt
 * - Tự động làm mới link CDN nếu video dài tải qua nhiều giờ làm URL hết hạn
 */
function streamToClientWithRange(req, res, targetUrl, filename, customHeaders = {}, totalKnownSize = 0, urlRefresher = null) {
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
  let bytesStreamed = (clientStart !== null) ? clientStart : 0;
  let fullFileSize = totalKnownSize;

  // 2. Tạo ETag và Last-Modified cố định (BẮT BUỘC để Chrome cho phép nối tiếp & đa luồng Parallel)
  let etagSource = '';
  if (req.query && req.query.bvid && req.query.cid) {
    etagSource = 'bili_' + req.query.bvid + '_' + req.query.cid + '_' + (req.query.part || '1');
  } else if (req.query && req.query.url) {
    etagSource = 'stream_' + String(req.query.url).split('?')[0];
  } else {
    etagSource = (req.originalUrl ? req.originalUrl.split('?')[0] : 'video') + '_' + (filename || '');
  }
  const etag = '"' + crypto.createHash('md5').update(etagSource).digest('hex') + '"';
  const lastModified = 'Sun, 01 Jan 2026 00:00:00 GMT';

  let isHeadersSent = false;
  let currentActiveReq = null;
  let currentActiveStream = null;
  let isClientClosed = false;

  req.on('close', () => {
    isClientClosed = true;
    if (currentActiveStream) { try { currentActiveStream.destroy(); } catch (e) {} }
    if (currentActiveReq) { try { currentActiveReq.destroy(); } catch (e) {} }
  });

  res.on('drain', () => {
    if (currentActiveStream && !currentActiveStream.destroyed && typeof currentActiveStream.resume === 'function') {
      currentActiveStream.resume();
    }
  });

  function connect(currentFetchUrl, byteOffset = 0, redirectsLeft = 5, retriesLeft = 20) {
    if (isClientClosed || res.writableEnded || res.destroyed) return;
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

      currentActiveReq = client.get(currentFetchUrl, { headers, agent, highWaterMark: 4 * 1024 * 1024 }, (stream) => {
        currentActiveStream = stream;

        // Xử lý chuyển hướng 301/302/307
        if ([301, 302, 303, 307, 308].includes(stream.statusCode) && stream.headers.location && !isHeadersSent) {
          let nextUrl = stream.headers.location;
          if (nextUrl.startsWith('//')) nextUrl = 'https:' + nextUrl;
          else if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, currentFetchUrl).toString();
          return connect(nextUrl, byteOffset, redirectsLeft - 1, retriesLeft);
        }

        // Tự động làm mới link CDN nếu link bị hết hạn trong khi tải (403/410)
        if ([403, 410].includes(stream.statusCode) && typeof urlRefresher === 'function' && retriesLeft > 0) {
          console.log('[Auto-Heal] URL CDN đã hết hạn, đang tự động lấy URL mới...');
          urlRefresher().then(newUrl => {
            if (newUrl) connect(newUrl, bytesStreamed, 5, retriesLeft - 1);
            else if (!res.writableEnded) res.end();
          }).catch(() => {
            if (!res.writableEnded) res.end();
          });
          return;
        }

        const upstreamStatusCode = stream.statusCode;
        const upstreamIs206 = (upstreamStatusCode === 206);

        // Xác định tổng kích thước file
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
          const rawName = String(filename || 'video.mp4').replace(/[\r\n"]/g, '');
          const asciiFallback = rawName.replace(/[^\x20-\x7E]/g, '_');
          const utf8Encoded = encodeURIComponent(rawName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
          res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`);
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('ETag', etag);
          res.setHeader('Last-Modified', lastModified);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          if (res.socket) {
            res.socket.setNoDelay(true);
            res.socket.setKeepAlive(true, 10000);
          }

          if (isRangeRequest) {
            // BẮT BUỘC TRẢ VỀ 206 ĐỂ CHROME TẢI NỐI TIẾP HOẶC TẢI SONG SONG
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
            if (fullFileSize > 0) {
              res.setHeader('Content-Length', fullFileSize);
            } else if (stream.headers['content-length']) {
              res.setHeader('Content-Length', stream.headers['content-length']);
            }
          }
        }

        // Bỏ qua byte nếu CDN trả về 200 thay vì 206
        let skipBytes = 0;
        if (!upstreamIs206 && upstreamStart > 0) {
          skipBytes = upstreamStart;
        }

        // BƠM DỮ LIỆU LIÊN TỤC VỀ CHROME
        stream.on('data', (chunk) => {
          if (isClientClosed || res.writableEnded || res.destroyed) {
            try { stream.destroy(); } catch (e) {}
            return;
          }

          if (skipBytes > 0) {
            if (chunk.length <= skipBytes) {
              skipBytes -= chunk.length;
              return;
            } else {
              chunk = chunk.slice(skipBytes);
              skipBytes = 0;
            }
          }

          bytesStreamed += chunk.length;
          const ok = res.write(chunk);
          if (!ok) {
            stream.pause();
          }
        });

        let isStreamFinished = false;

        function tryAutoHeal(reason) {
          if (isStreamFinished) return;
          isStreamFinished = true;

          const targetEnd = (clientEnd !== null) ? clientEnd : (fullFileSize > 0 ? fullFileSize - 1 : 0);
          // NẾU CDN NGẮT SỚM KHI CHƯA TẢI ĐỦ 100%: TỰ ĐỘNG NỐI LẠI NGAY LẬP TỨC
          if (targetEnd > 0 && bytesStreamed <= targetEnd && retriesLeft > 0 && !isClientClosed && !res.writableEnded && !res.destroyed) {
            console.log(`[Auto-Heal Engine] ${reason} tại ${bytesStreamed}/${targetEnd + 1} bytes. Đang tự động kết nối lại CDN tại byte ${bytesStreamed}... (còn ${retriesLeft} lần thử)`);
            setTimeout(() => {
              connect(currentFetchUrl, bytesStreamed, 5, retriesLeft - 1);
            }, 300);
            return;
          }

          // ĐÃ TẢI HOÀN TOÀN XONG 100% FILE -> ĐÓNG KẾT NỐI HOÀN TẤT
          if (!res.writableEnded) {
            res.end();
          }
        }

        stream.on('end', () => {
          tryAutoHeal('CDN ngắt luồng sớm (giới hạn dung lượng kết nối)');
        });

        stream.on('error', (err) => {
          console.warn('[Stream Error]', err.message);
          tryAutoHeal('Lỗi socket CDN: ' + err.message);
        });
      });

      currentActiveReq.on('socket', (sock) => {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 10000);
      });

      currentActiveReq.on('error', (err) => {
        console.warn('[Request Error]', err.message);
        if (!isHeadersSent) {
          if (retriesLeft > 0 && !isClientClosed) {
            setTimeout(() => connect(currentFetchUrl, byteOffset, redirectsLeft, retriesLeft - 1), 1000);
          } else {
            res.status(502).send('Lỗi kết nối máy chủ CDN: ' + err.message);
          }
        } else {
          const targetEnd = (clientEnd !== null) ? clientEnd : (fullFileSize > 0 ? fullFileSize - 1 : 0);
          if (targetEnd > 0 && bytesStreamed <= targetEnd && retriesLeft > 0 && !isClientClosed && !res.writableEnded && !res.destroyed) {
            setTimeout(() => connect(currentFetchUrl, bytesStreamed, 5, retriesLeft - 1), 500);
          } else if (!res.writableEnded) {
            res.end();
          }
        }
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
// BỘ NHỚ ĐỆM CDN BILIBILI: Chống rate-limit WAF 412 & hỗ trợ Resume / Tải song song
// ===========================================================================
const biliCdnCache = new Map();
function getCachedBiliCdn(key) {
  const item = biliCdnCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > 30 * 60 * 1000) { // Hết hạn sau 30 phút
    biliCdnCache.delete(key);
    return null;
  }
  return item;
}
function setCachedBiliCdn(key, cdnUrl, totalBytes) {
  if (biliCdnCache.size > 500) {
    const firstKey = biliCdnCache.keys().next().value;
    biliCdnCache.delete(firstKey);
  }
  biliCdnCache.set(key, { cdnUrl, totalBytes, time: Date.now() });
}

// ===========================================================================
// API TẢI BILIBILI: Luôn fetch link CDN mới ngay lúc bấm tải (không bị hết hạn)
// ===========================================================================
app.get('/api/bili-download', async (req, res) => {
  const { bvid, cid, part, filename } = req.query;
  if (!bvid || !cid) return res.status(400).send('Thiếu bvid hoặc cid');

  req.setTimeout(0);
  res.setTimeout(0);

  // 0. Kiểm tra Cache trước (nếu người dùng Resume hoặc Chrome tải đa luồng Parallel)
  const cacheKey = `${bvid}_${cid}_${part || '1'}`;
  const cached = getCachedBiliCdn(cacheKey);

  let freshCdnUrl = cached ? cached.cdnUrl : null;
  let totalBytes = cached ? cached.totalBytes : 0;

  // Helper: thử parse JSON, trả về null nếu không phải JSON (HTML, v.v.)
  function tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Helper: gọi HTTPS đơn giản không qua fetchUrl
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
    if (!freshCdnUrl) {
      // 1. Lấy cookie buvid3/buvid4 — nếu thất bại thì bỏ qua (không có cookie vẫn hoạt động)
      let cookie = '';
      try {
        const spi = await httpsGet('https://api.bilibili.com/x/frontend/finger/spi', { 'Referer': 'https://www.bilibili.com/' });
        const spiJson = tryParseJson(spi.body);
        if (spiJson?.data?.b_3) cookie = `buvid3=${spiJson.data.b_3}; buvid4=${spiJson.data.b_4 || ''};`;
      } catch (e) { /* tiếp tục không có cookie */ }

      // 2. Thử lấy link CDN — thử nhiều qn (chất lượng): 64=720p, 80=1080p, 32=480p, 16=360p
      let rawCdnUrl = null;

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
            // Ưu tiên chọn CDN Tencent Cloud (mirrorcos) hoặc Alibaba Cloud (mirrorali) quốc tế
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

            // Lưu vào cache để các luồng nối tiếp / tải song song dùng chung tức thì
            setCachedBiliCdn(cacheKey, freshCdnUrl, totalBytes);
            break;
          }

          // Nếu Bilibili trả về HTML (412 / WAF), thử không có cookie
          if (pRes.status === 412 && cookie) {
            cookie = '';
            continue;
          }
        } catch (e) { continue; }
      }
    }

    if (!freshCdnUrl) {
      return res.status(502).send(
        'Bilibili đang chặn tải trực tiếp từ server này (IP bị giới hạn). ' +
        'Vui lòng thử lại sau vài giây.'
      );
    }

    // 3. Đặt tên file chuẩn và truyền qua bộ điều phối Range siêu bền (Resume 206 & Auto-Heal)
    const defaultName = `${bvid}_part${part || 1}.mp4`;
    const safeFilename = String(filename || defaultName)
      .replace(/[^\w.\-\u4E00-\u9FFF\u3040-\u30FF]+/g, '_');

    // Hàm tự động làm mới link CDN nếu video dài tải qua nhiều giờ làm link CDN hết hạn
    const cdnRefresher = async () => {
      try {
        console.log('[Bili Refresher] Đang lấy lại CDN URL mới từ Bilibili...');
        const pRes = await httpsGet(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&type=mp4&platform=html5`, {
          'Referer': `https://www.bilibili.com/video/${bvid}`
        });
        const pJson = tryParseJson(pRes.body);
        if (pJson?.data?.durl?.[0]?.url) {
          const newUrl = pJson.data.durl[0].url.replace(/https?:\/\/[^\/]+/, 'https://upos-sz-mirrorcos.bilivideo.com');
          setCachedBiliCdn(cacheKey, newUrl, pJson.data.durl[0].size || totalBytes);
          return newUrl;
        }
      } catch (e) {
        console.warn('[Bili Refresher Error]', e.message);
      }
      return null;
    };

    return streamToClientWithRange(req, res, freshCdnUrl, safeFilename, { 'Referer': 'https://www.bilibili.com/' }, totalBytes, cdnRefresher);
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
server.keepAliveTimeout = 300000;
server.headersTimeout = 305000;
if ('requestTimeout' in server) {
  server.requestTimeout = 0;
}
