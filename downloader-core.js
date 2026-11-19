const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const { spawn } = require('child_process');

const fs = require('fs');
const vm = require('vm');

// ============================================================
// DNS-over-HTTPS cache: bypass ISP DNS block (Cloudflare DoH)
// Pre-seeded with known Cloudflare IPs for domains blocked by Vietnam ISP
// ============================================================
const dohCache = {
  'www.tikwm.com': { ip: '104.26.12.103', expires: Date.now() + 86400000 },
  'tikwm.com':     { ip: '104.26.12.103', expires: Date.now() + 86400000 },
};

// Các IP Cloudflare dự phòng cho tikwm.com (khi IP đầu không phản hồi)
const TIKWM_IPS = ['104.26.12.103', '104.26.13.103', '172.67.68.49'];

async function dohResolve(hostname) {
  if (dohCache[hostname] && dohCache[hostname].expires > Date.now()) {
    return dohCache[hostname].ip;
  }
  return new Promise((resolve) => {
    const path = `/dns-query?name=${encodeURIComponent(hostname)}&type=A`;
    const opts = {
      hostname: '1.1.1.1',
      port: 443,
      path,
      method: 'GET',
      headers: { 'Accept': 'application/dns-json' },
      timeout: 4000,
      rejectUnauthorized: false
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const a = json.Answer && json.Answer.find(r => r.type === 1);
          if (a && a.data) {
            dohCache[hostname] = { ip: a.data, expires: Date.now() + 300000 };
            return resolve(a.data);
          }
        } catch (e) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Lấy đường dẫn thực thi của yt-dlp tương thích cả Windows và Linux Cloud Server
 */
function getYtDlpPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'runtime', 'yt-dlp.exe');
  }
  const localLinux = path.join(__dirname, 'runtime', 'yt-dlp');
  if (fs.existsSync(localLinux)) return localLinux;
  return 'yt-dlp';
}

let cachedTtwid = null;
let ttwidExpireTime = 0;

/**
 * Tự động tạo hoặc lấy Cookie ttwid hợp lệ từ ByteDance để giải quyết triệt để lỗi
 * "Fresh cookies (not necessarily logged in) are needed" của Douyin
 */
async function getDouyinTtwid() {
  const now = Date.now();
  if (cachedTtwid && now < ttwidExpireTime) {
    return cachedTtwid;
  }

  // Cách 1: Đăng ký ttwid qua endpoint chính thức của ByteDance
  try {
    const postData = JSON.stringify({
      region: 'cn',
      aid: 1768,
      needFid: 'false',
      service: 'www.ixigua.com',
      migrate_info: { ticket: '', source: 'node' },
      cbUrlProtocol: 'https',
      union: 'true'
    });

    const res = await fetchUrl('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: postData,
      timeout: 6000
    });

    const cookies = res.headers['set-cookie'];
    if (cookies) {
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      const match = cookieStr.match(/ttwid=([^;]+)/);
      if (match) {
        cachedTtwid = match[1];
        ttwidExpireTime = now + 86400000;
        return cachedTtwid;
      }
    }
  } catch (e) {}

  // Cách 2: Lấy ttwid từ live.douyin.com
  try {
    const res = await fetchUrl('https://live.douyin.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 6000
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
      const match = cookieStr.match(/ttwid=([^;]+)/);
      if (match) {
        cachedTtwid = match[1];
        ttwidExpireTime = now + 86400000;
        return cachedTtwid;
      }
    }
  } catch (e) {}

  // Không dùng fallback ttwid giả (tránh làm các tầng sau tưởng đã có cookie)
  return null;
}

/**
 * Helper gọi yt-dlp với --cookies-from-browser (lấy cookie thực từ trình duyệt người dùng)
 * Thử Edge trước (phổ biến nhất trên Windows 11), rồi Chrome
 */
function extractWithYtDlpBrowser(targetUrl, browser) {
  return new Promise((resolve, reject) => {
    const ytdlpPath = getYtDlpPath();
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--dump-single-json',
      '--cookies-from-browser', browser,
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      targetUrl
    ];
    const proc = spawn(ytdlpPath, args);
    let stdout = '';
    let stderr = '';
    // Timeout 30 giây mỗi browser
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp [${browser}] timeout`));
    }, 30000);
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      } else {
        reject(new Error(stderr || `yt-dlp [${browser}] failed with exit code ${code}`));
      }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Helper gọi yt-dlp core nội bộ làm lớp dự phòng cuối cùng kèm cookie file
 */
function extractWithYtDlp(targetUrl, customCookie) {
  return new Promise((resolve, reject) => {
    const ytdlpPath = getYtDlpPath();
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--dump-single-json'
    ];

    if (customCookie) {
      try {
        const cookieFile = path.join(__dirname, 'runtime', 'douyin_cookies.txt');
        const lines = [
          '# Netscape HTTP Cookie File',
          '# http://curl.haxx.se/rfc/cookie_spec.html',
          '# This is a generated file!  Do not edit.',
          '',
          ['.douyin.com', 'TRUE', '/', 'TRUE', '2147483647', 'ttwid', customCookie].join('\t'),
          ['.douyin.com', 'TRUE', '/', 'FALSE', '2147483647', 'passport_csrf_token', 'd0a9446f059c3a9f0e1329a2955f1f72'].join('\t')
        ].join('\n');
        fs.writeFileSync(cookieFile, lines, 'utf8');
        args.push('--cookies', cookieFile);
      } catch (e) {}
    }

    args.push(
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      targetUrl
    );

    const proc = spawn(ytdlpPath, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(stderr || `yt-dlp failed with exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

function logDebug(msg) {
  try {
    const logFile = path.join(__dirname, 'douyin_debug.log');
    const time = new Date().toLocaleTimeString();
    fs.appendFileSync(logFile, `[${time}] ${msg}\n`, 'utf8');
    console.log(`[Douyin Debug] ${msg}`);
  } catch (e) {}
}

/**
 * Helper tải nội dung text hoặc JSON an toàn kèm timeout & redirect follow
 */
function fetchUrl(targetUrl, options = {}, redirectsLeft = 5, _resolvedIp = null) {
  return new Promise(async (resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Quá nhiều chuyển hướng (Too many redirects)'));
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('URL không hợp lệ: ' + targetUrl));
    }

    // DNS-over-HTTPS fallback: resolve IP via Cloudflare DoH nếu DNS bình thường bị ISP chặn
    let resolvedHostname = parsed.hostname;
    if (!_resolvedIp && parsed.protocol === 'https:') {
      try {
        const ip = await dohResolve(parsed.hostname);
        if (ip) _resolvedIp = ip;
      } catch (e) {}
    }
    if (_resolvedIp) resolvedHostname = _resolvedIp;

    const client = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      protocol: parsed.protocol,
      hostname: resolvedHostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      rejectUnauthorized: false,
      // SNI: Cloudflare/CDN cần đúng servername trong TLS handshake dù kết nối bằng IP
      servername: parsed.hostname,
      headers: {
        'Host': parsed.hostname, // quan trọng khi kết nối bằng IP
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
        ...(options.headers || {})
      },
      timeout: options.timeout || 15000
    };

    const req = client.request(reqOptions, (res) => {
      // Follow Redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, targetUrl).toString();
        }
        return resolve(fetchUrl(redirectUrl, options, redirectsLeft - 1));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          finalUrl: targetUrl
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Hết thời gian kết nối (Connection timeout)'));
    });

    req.on('error', reject);

    if (options.body) {
      const bodyLen = Buffer.isBuffer(options.body)
        ? options.body.length
        : Buffer.byteLength(String(options.body), 'utf8');
      reqOptions.headers['Content-Length'] = bodyLen;
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Helper parse JSON an toàn: chuyển đổi undefined -> null, xử lý ký tự đặc biệt
 */
function safeJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    let clean = raw.trim().replace(/;+\s*$/, '');
    clean = clean.replace(/:\s*undefined\b/g, ': null');
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

/**
 * Helper giải mã script đóng gói (Dean Edwards Packer) của SnapTik
 */
function unpackSnapTik(script) {
  if (!script || typeof script !== 'string') return '';
  if (!script.includes('eval(function(p,a,c,k,e,d)')) return script;
  try {
    let unpacked = '';
    const sandbox = {
      eval: (code) => { unpacked = code; return code; },
      window: {},
      document: { getElementById: () => ({}) }
    };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox, { timeout: 2000 });
    return unpacked || script;
  } catch (e) {
    return script;
  }
}

/**
 * Helper trích xuất thông tin video Douyin trực tiếp từ HTML SSR
 * Hỗ trợ chuẩn hóa URL //, khớp đúng ID video và an toàn với JSON phức tạp
 */
function extractDouyinFromHtml(html, targetVideoId = null) {
  if (!html || typeof html !== 'string') return null;
  let playUrl = null;
  let title = '';
  let author = 'Douyin Creator';
  let thumbnail = null;

  const findPlay = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    
    // Nếu có targetVideoId, ưu tiên chỉ bóc aweme trùng khớp ID video
    if (targetVideoId && obj.aweme_id && String(obj.aweme_id) !== String(targetVideoId)) {
      return;
    }

    if (obj.desc && !title) title = obj.desc;
    if (obj.nickname && (!author || author === 'Douyin Creator')) author = obj.nickname;
    if (obj.cover && !thumbnail) {
      thumbnail = obj.cover.url_list?.[0] || (typeof obj.cover === 'string' ? obj.cover : null);
    }
    // 1. Kiểm tra play_addr trực tiếp
    if (obj.play_addr && obj.play_addr.url_list && obj.play_addr.url_list.length > 0) {
      playUrl = obj.play_addr.url_list[0];
      return;
    }
    // 2. Kiểm tra danh sách bit_rate (chất lượng cao)
    if (Array.isArray(obj.bit_rate) && obj.bit_rate.length > 0) {
      for (const b of obj.bit_rate) {
        if (b.play_addr?.url_list?.length > 0) {
          playUrl = b.play_addr.url_list[0];
          return;
        }
      }
    }
    // 3. Kiểm tra play_addr_h264 / play_addr_265
    if (obj.play_addr_h264 && obj.play_addr_h264.url_list && obj.play_addr_h264.url_list.length > 0) {
      playUrl = obj.play_addr_h264.url_list[0];
      return;
    }
    for (const k of Object.keys(obj)) {
      if (!playUrl) findPlay(obj[k]);
    }
  };

  // 1. Quét thẻ __UNIVERSAL_DATA_FOR_REHYDRATION__ (Chuẩn SSR hiện đại nhất của ByteDance)
  const universalMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
  if (universalMatch && universalMatch[1]) {
    const json = safeJsonParse(universalMatch[1]);
    if (json) findPlay(json);
  }

  // 2. Quét thẻ <script id="RENDER_DATA"...> (Trang chia sẻ di động iesdouyin.com)
  if (!playUrl) {
    const renderMatch = html.match(/<script id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/i);
    if (renderMatch && renderMatch[1]) {
      let raw = renderMatch[1].trim();
      if (raw.includes('%')) {
        try { raw = decodeURIComponent(raw); } catch (e) {}
      }
      const json = safeJsonParse(raw);
      if (json) findPlay(json);
    }
  }

  // 3. Quét thẻ <script id="ROUTER_DATA"...> hoặc window._ROUTER_DATA (Regex an toàn tới hết script)
  if (!playUrl) {
    const routerMatch = html.match(/<script id="ROUTER_DATA"[^>]*>([\s\S]*?)<\/script>/i) ||
                        html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)(?:;\s*<\/script>|<\/script>)/i);
    if (routerMatch && routerMatch[1]) {
      let raw = routerMatch[1].trim();
      const json = safeJsonParse(raw);
      if (json) findPlay(json);
    }
  }

  // 4. Quét trực tiếp regex trên toàn bộ mã nguồn HTML (Trường hợp script bị nén hoặc băm nhỏ)
  if (!playUrl) {
    const directUrlMatch = html.match(/"play_addr"[\s\S]*?"url_list"\s*:\s*\[\s*"([^"]+)"/i) ||
                           html.match(/"url_list"\s*:\s*\[\s*"(https?:\\\/\\\/[^"]*(?:douyinvod|amemv|byteoversea|snssdk)[^"]*)"/i) ||
                           html.match(/"url_list"\s*:\s*\[\s*"(\/\/v[0-9]+[^"]*)"/i);
    if (directUrlMatch && directUrlMatch[1]) {
      playUrl = directUrlMatch[1].replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    }
  }

  // Lấy tiêu đề từ thẻ <title> nếu chưa có
  if (!title) {
    const tMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (tMatch) title = tMatch[1].replace(/ - 抖音.*/, '').replace(/- 抖音/, '').trim();
  }

  // Lấy ảnh bìa từ meta og:image nếu chưa có
  if (!thumbnail) {
    const imgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (imgMatch) thumbnail = imgMatch[1];
  }

  if (playUrl) {
    // Sửa lỗi URL thiếu https (//v3-web... -> https://v3-web...)
    if (playUrl.startsWith('//')) {
      playUrl = 'https:' + playUrl;
    }
    // Chuyển URL sang định dạng không dính logo (play thay vì playwm)
    playUrl = playUrl.replace('playwm', 'play');
    return {
      platform: 'Douyin (抖音)',
      platformIcon: '🎶',
      title: title || 'Video Douyin Không Logo 1080p HD',
      author: author || 'Douyin Creator',
      thumbnail,
      downloads: [{
        quality: '1080p Full HD (Có Tiếng + Không Logo)',
        type: 'mp4',
        url: playUrl,
        badge: 'Douyin Gốc Không Logo'
      }]
    };
  }

  return null;
}

/**
 * Helper chuyển đổi kết quả yt-dlp thành định dạng chuẩn trả về
 */
function formatYtDlpResult(ytdlpInfo) {
  const formats = ytdlpInfo.formats || [];
  const combined = formats.filter(f => f.url && f.vcodec !== 'none' && f.acodec !== 'none');
  combined.sort((a, b) => (b.height || 0) - (a.height || 0));
  const bestUrl = combined[0]?.url || ytdlpInfo.url || formats[formats.length - 1]?.url;
  if (!bestUrl) return null;
  return {
    platform: 'Douyin (抖音)',
    platformIcon: '🎶',
    title: ytdlpInfo.title || 'Video Douyin HD',
    author: ytdlpInfo.uploader || 'Douyin Creator',
    thumbnail: ytdlpInfo.thumbnail || null,
    duration: ytdlpInfo.duration ? `${ytdlpInfo.duration}s` : null,
    downloads: [{
      quality: `${combined[0]?.height || '1080'}p Full HD Không Logo`,
      type: 'mp4',
      url: bestUrl,
      badge: 'Douyin HD'
    }]
  };
}

/**
 * 1. Douyin (抖音 Trung Quốc): Bóc tách video 100% Không Logo (No Watermark) 1080p HD
 * Cổng giải mã tự động đám mây song song (Chuẩn Bilibili) -> SSR HTML -> yt-dlp Core
 */
async function parseDouyin(videoUrl) {
   // === TẦNG ĐẶC BIỆT: CỔNG GIẢI MÃ CHUYÊN DỤNG CHO DOUYIN (HỖ TRỢ MODAL_ID, JINGXUAN, V.DOUYIN) ===
  try {
    const postData = JSON.stringify({ text: videoUrl, platform: 'douyin' });
    const res = await fetchUrl('https://downdouyin.com/api/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://downdouyin.com',
        'Referer': 'https://downdouyin.com/'
      },
      body: postData,
      timeout: 10000
    });

    const json = safeJsonParse(res.data);
    if (json && json.success && json.data) {
      const d = json.data;
      const vUrls = d.video_urls || (d.video_url ? [d.video_url] : []);
      const directUrl = vUrls.find(u => u.includes('zjcdn.com') || u.includes('douyinvod.com')) || vUrls[0];
      if (directUrl) {
        return {
          platform: 'Douyin (抖音)',
          platformIcon: '🎶',
          title: d.title || d.desc || 'Video Douyin 1080p Không Logo',
          author: d.author?.nickname || 'Douyin Creator',
          thumbnail: d.cover || null,
          duration: d.duration ? `${Math.round(d.duration)}s` : null,
          downloads: [{
            quality: '1080p Full HD (Có Tiếng + Không Logo)',
            type: 'mp4',
            url: directUrl,
            badge: 'Douyin 1080p Gốc'
          }]
        };
      }
    }
  } catch (e) {} 
  // Trích xuất chính xác videoId từ bất kỳ dạng link nào (modal_id, video/, aweme_id)
  let videoId = null;
  const directMatch = videoUrl.match(/modal_id=(\d{10,21})/) || 
                      videoUrl.match(/\/video\/(\d{10,21})/) || 
                      videoUrl.match(/aweme_id=(\d{10,21})/);
  if (directMatch) {
    videoId = directMatch[1];
  } else {
    try {
      const red = await fetchUrl(videoUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15' },
        timeout: 5000
      });
      const finalUrl = red.finalUrl || '';
      const m = finalUrl.match(/modal_id=(\d{10,21})/) || finalUrl.match(/\/video\/(\d{10,21})/) || finalUrl.match(/video\/(\d+)/);
      if (m) videoId = m[1];

      // Nếu đã có HTML từ bước redirect, thử bóc ngay
      if (red.data) {
        const fromRedirectHtml = extractDouyinFromHtml(red.data);
        if (fromRedirectHtml) {
          logDebug('✅ Bóc thành công từ HTML Redirect!');
          return fromRedirectHtml;
        }
      }
    } catch (e) {}
  }

  const cleanUrl = videoId ? `https://www.douyin.com/video/${videoId}` : videoUrl;
  logDebug(`[Bắt đầu] url=${videoUrl} -> cleanUrl=${cleanUrl} (videoId=${videoId})`);

  // === TẦNG 1: CỔNG GIẢI MÃ TỰ ĐỘNG ĐÁM MÂY (CHẠY SONG SONG SIÊU TỐC NHƯ BILIBILI) ===
  logDebug('Thử Tầng 1: Cổng giải mã tự động đám mây song song...');
  const cloudCalls = [];

  // 1. TikWM POST (cleanUrl & videoUrl) - thử song song cả 3 Cloudflare IP
  for (const target of [cleanUrl, videoUrl]) {
    if (!target) continue;
    for (const tikwmIp of TIKWM_IPS) {
    cloudCalls.push(new Promise(async (resolve, reject) => {
      try {
        const postBody = `url=${encodeURIComponent(target)}&hd=1`;
        // Override dohCache tạm để fetchUrl dùng IP này
        dohCache['www.tikwm.com'] = { ip: tikwmIp, expires: Date.now() + 60000 };
        const res = await fetchUrl('https://www.tikwm.com/api/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.tikwm.com/'
          },
          body: postBody,
          timeout: 5000
        });
        const json = safeJsonParse(res.data);
        if (json && json.code === 0 && json.data) {
          const d = json.data;
          const vUrl = d.hdplay || d.play;
          if (vUrl) {
            return resolve({
              platform: 'Douyin (抖音)',
              platformIcon: '🎶',
              title: d.title || 'Video Douyin Không Logo Full HD',
              author: d.author?.nickname || 'Douyin Creator',
              thumbnail: d.cover || null,
              duration: d.duration ? `${d.duration}s` : null,
              downloads: [{
                quality: '1080p Full HD (Có Tiếng + Không Logo)',
                type: 'mp4',
                url: vUrl.startsWith('http') ? vUrl : `https://www.tikwm.com${vUrl}`,
                badge: 'Douyin Full HD'
              }]
            });
          }
        }
        reject(new Error('TikWM POST no data'));
      } catch (e) {
        reject(e);
      }
    }));
    } // end for tikwmIp
  } // end for target

  // 2. TikWM GET (cleanUrl)
  cloudCalls.push(new Promise(async (resolve, reject) => {
    try {
      const res = await fetchUrl(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}&hd=1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.tikwm.com/'
        },
        timeout: 5000
      });
      const json = safeJsonParse(res.data);
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        const vUrl = d.hdplay || d.play;
        if (vUrl) {
          return resolve({
            platform: 'Douyin (抖音)',
            platformIcon: '🎶',
            title: d.title || 'Video Douyin Không Logo Full HD',
            author: d.author?.nickname || 'Douyin Creator',
            thumbnail: d.cover || null,
            duration: d.duration ? `${d.duration}s` : null,
            downloads: [{
              quality: '1080p Full HD (Có Tiếng + Không Logo)',
              type: 'mp4',
              url: vUrl.startsWith('http') ? vUrl : `https://www.tikwm.com${vUrl}`,
              badge: 'Douyin Full HD'
            }]
          });
        }
      }
      reject(new Error('TikWM GET no data'));
    } catch (e) {
      reject(e);
    }
  }));

  // 3. TiklyDown API
  cloudCalls.push(new Promise(async (resolve, reject) => {
    try {
      const res = await fetchUrl(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(cleanUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
      });
      const json = safeJsonParse(res.data);
      if (json && (json.status === true || json.status === 200) && json.video) {
        let playUrl = json.video.noWatermark || json.video.watermark || json.url;
        if (playUrl) {
          if (playUrl.startsWith('//')) playUrl = 'https:' + playUrl;
          return resolve({
            platform: 'Douyin (抖音)',
            platformIcon: '🎶',
            title: json.title || 'Video Douyin Không Logo HD',
            author: json.author?.name || 'Douyin Creator',
            thumbnail: json.video.cover || null,
            downloads: [{
              quality: '1080p Full HD (Có Tiếng + Không Logo)',
              type: 'mp4',
              url: playUrl,
              badge: 'Douyin Gốc Không Logo'
            }]
          });
        }
      }
      reject(new Error('TiklyDown no data'));
    } catch (e) {
      reject(e);
    }
  }));

  // 4. Pearktrue API
  cloudCalls.push(new Promise(async (resolve, reject) => {
    try {
      const res = await fetchUrl(`https://api.pearktrue.cn/api/douyin/?url=${encodeURIComponent(cleanUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000
      });
      const json = safeJsonParse(res.data);
      if (json && json.code === 200 && json.data) {
        const d = json.data;
        let vUrl = d.url || d.play || d.video;
        if (vUrl) {
          if (vUrl.startsWith('//')) vUrl = 'https:' + vUrl;
          return resolve({
            platform: 'Douyin (抖音)',
            platformIcon: '🎶',
            title: d.title || 'Video Douyin Full HD',
            author: d.author || 'Douyin Creator',
            thumbnail: d.cover || null,
            downloads: [{
              quality: '1080p Full HD (Có Tiếng + Không Logo)',
              type: 'mp4',
              url: vUrl,
              badge: 'Douyin Full HD'
            }]
          });
        }
      }
      reject(new Error('Pearktrue no data'));
    } catch (e) {
      reject(e);
    }
  }));

  // 6. Loco Downloader API (không bị block ở VN)
  cloudCalls.push(new Promise(async (resolve, reject) => {
    try {
      const res = await fetchUrl(`https://locodownloader.com/api/ajaxSearch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Origin': 'https://locodownloader.com',
          'Referer': 'https://locodownloader.com/'
        },
        body: `q=${encodeURIComponent(videoUrl)}&lang=vi&platform=douyin`,
        timeout: 8000
      });
      const json = safeJsonParse(res.data);
      if (json && json.status === 'ok' && json.links && json.links.length > 0) {
        const link = json.links.find(l => l.type === 'mp4' || l.ext === 'mp4') || json.links[0];
        if (link && link.url) {
          return resolve({
            platform: 'Douyin (抖音)',
            platformIcon: '🎶',
            title: json.title || 'Video Douyin',
            author: json.author || 'Douyin Creator',
            thumbnail: json.thumbnail || null,
            downloads: [{
              quality: link.quality || 'HD (Không Logo)',
              type: 'mp4',
              url: link.url,
              badge: 'Douyin HD'
            }]
          });
        }
      }
      reject(new Error('LocoDownloader no data'));
    } catch (e) {
      reject(e);
    }
  }));

  // 7. SnapTik.app API (giải mã trực tiếp bằng máy ảo unpacker nội bộ)
  for (const target of [cleanUrl, videoUrl]) {
    if (!target) continue;
    cloudCalls.push(new Promise(async (resolve, reject) => {
      try {
        const tokenRes = await fetchUrl('https://snaptik.app/', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          },
          timeout: 5000
        });
        const tokenMatch = tokenRes.data && tokenRes.data.match(/name="token"\s+value="([^"]+)"/);
        if (!tokenMatch) return reject(new Error('SnapTik: không lấy được token'));
        const token = tokenMatch[1];
        const postRes = await fetchUrl('https://snaptik.app/abc2.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Origin': 'https://snaptik.app',
            'Referer': 'https://snaptik.app/'
          },
          body: `url=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}&lang=en1`,
          timeout: 8000
        });

        let rawHtml = postRes.data || '';
        if (rawHtml.includes('eval(function(p,a,c,k,e,d)')) {
          rawHtml = unpackSnapTik(rawHtml);
        }

        const urlMatch = rawHtml.match(/href="(https:\/\/[^"]*(?:snaptik|tik|video|download|mp4)[^"]*)"/i) ||
                         rawHtml.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/i) ||
                         rawHtml.match(/<a[^>]*href="(https:\/\/[^"]+)"[^>]*class="[^"]*download-file[^"]*"/i);
        if (urlMatch && urlMatch[1]) {
          let vUrl = urlMatch[1].replace(/&amp;/g, '&');
          return resolve({
            platform: 'Douyin (抖音)',
            platformIcon: '🎶',
            title: 'Video Douyin Không Logo (SnapTik)',
            author: 'Douyin Creator',
            thumbnail: null,
            downloads: [{
              quality: '1080p Full HD (Không Logo)',
              type: 'mp4',
              url: vUrl,
              badge: 'SnapTik HD'
            }]
          });
        }
        reject(new Error('SnapTik no data'));
      } catch (e) {
        reject(e);
      }
    }));
  }

  // 8. SaveTik API (savetik.co - cổng dự phòng chuyên Douyin)
  for (const target of [cleanUrl, videoUrl]) {
    if (!target) continue;
    cloudCalls.push(new Promise(async (resolve, reject) => {
      try {
        const res = await fetchUrl('https://savetik.co/api/ajaxSearch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://savetik.co',
            'Referer': 'https://savetik.co/en/'
          },
          body: `q=${encodeURIComponent(target)}&lang=en`,
          timeout: 7000
        });
        const json = safeJsonParse(res.data);
        if (json && json.data) {
          const html = json.data;
          const m = html.match(/href="(https:\/\/[^"]*(?:tik-cdn\.com|download|mp4)[^"]*)"/i) ||
                    html.match(/<a[^>]*onclick="showAd\(\)"[^>]*href="([^"]+)"/i) ||
                    html.match(/href="([^"]+)"[^>]*class="[^"]*tik-button-dl[^"]*"/i);
          if (m && m[1]) {
            let dlUrl = m[1].replace(/&amp;/g, '&');
            if (dlUrl.startsWith('//')) dlUrl = 'https:' + dlUrl;
            return resolve({
              platform: 'Douyin (抖音)',
              platformIcon: '🎶',
              title: 'Video Douyin Không Logo (SaveTik)',
              author: 'Douyin Creator',
              thumbnail: null,
              downloads: [{
                quality: '1080p Full HD (Có Tiếng + Không Logo)',
                type: 'mp4',
                url: dlUrl,
                badge: 'SaveTik HD'
              }]
            });
          }
        }
        reject(new Error('SaveTik no data'));
      } catch (e) {
        reject(e);
      }
    }));
  }

  // 9. Cổng iesdouyin chính thức (chỉ nhận khi đúng chuẩn videoId)
  if (videoId) {
    cloudCalls.push(new Promise(async (resolve, reject) => {
      try {
        const res = await fetchUrl(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
            'Accept': 'application/json'
          },
          timeout: 6000
        });
        const json = safeJsonParse(res.data);
        if (json && json.item_list && json.item_list.length > 0) {
          const item = json.item_list[0];
          if (String(item.aweme_id) === String(videoId) && item.video) {
            let vUrl = item.video.play_addr?.url_list?.[0];
            if (vUrl) {
              vUrl = vUrl.replace('playwm', 'play');
              if (vUrl.startsWith('//')) vUrl = 'https:' + vUrl;
              return resolve({
                platform: 'Douyin (抖音)',
                platformIcon: '🎶',
                title: item.desc || 'Video Douyin Chuẩn Gốc',
                author: item.author?.nickname || 'Douyin Creator',
                thumbnail: item.video.cover?.url_list?.[0] || null,
                downloads: [{ quality: '1080p Full HD (Có Tiếng + Không Logo)', type: 'mp4', url: vUrl, badge: 'Douyin Gốc' }]
              });
            }
          }
        }
        reject(new Error('iesdouyin no match'));
      } catch (e) {
        reject(e);
      }
    }));
  }

  try {
    const winner = await Promise.any(cloudCalls);
    if (winner) {
      logDebug(`✅ Tầng 1 THÀNH CÔNG [${winner.downloads?.[0]?.badge || 'Đám mây'}]: ${winner.title}`);
      return winner;
    }
  } catch (e) {
    logDebug('Tầng 1: Cổng giải mã đám mây không phản hồi, chuyển sang tầng dự phòng');
  }

  // === TẦNG 2: Bóc tách SSR HTML Douyin (Trang chia sẻ & Máy tính) ===
  if (videoId) {
    try {
      logDebug('Thử Tầng 2: Bóc tách SSR HTML...');
      const webUrl = `https://www.douyin.com/video/${videoId}`;
      const ttwid = await getDouyinTtwid();
      const res = await fetchUrl(webUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.douyin.com/',
          'Cookie': ttwid ? `ttwid=${ttwid};` : ''
        },
        timeout: 6000
      });
      const parsed = extractDouyinFromHtml(res.data, videoId);
      if (parsed) {
        logDebug('✅ Tầng 2 THÀNH CÔNG (Bóc tách SSR)!');
        return parsed;
      }
    } catch (e) {
      logDebug(`Tầng 2 Lỗi: ${e.message}`);
    }
  }

  // === TẦNG 3: yt-dlp Core nội bộ kèm Cookie File ===
  try {
    logDebug('Thử Tầng 3: yt-dlp core + cookie file...');
    const ttwid = await getDouyinTtwid();
    const ytdlpInfo = await extractWithYtDlp(cleanUrl, ttwid);
    const result = formatYtDlpResult(ytdlpInfo);
    if (result) {
      logDebug('✅ Tầng 3 THÀNH CÔNG (yt-dlp)!');
      return result;
    }
  } catch (err) {
    logDebug(`Tầng 3 Lỗi: ${err.message}`);
  }

  // === TẦNG 4: yt-dlp cookies từ trình duyệt (chỉ thử 8 giây mỗi browser) ===
  logDebug('Thử Tầng 4: yt-dlp cookies từ trình duyệt...');
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  const coccocProfile = localAppData ? path.join(localAppData, 'CocCoc', 'Browser', 'User Data') : '';
  const browsersToTry = ['edge', 'chrome', 'brave', 'firefox'];
  if (coccocProfile && fs.existsSync(coccocProfile)) {
    browsersToTry.unshift(`chromium:${coccocProfile}`);
  }

  for (const browser of browsersToTry) {
    try {
      const ytdlpInfo = await extractWithYtDlpBrowser(cleanUrl, browser);
      const result = formatYtDlpResult(ytdlpInfo);
      if (result) {
        logDebug(`✅ Tầng 4 THÀNH CÔNG (yt-dlp ${browser})!`);
        return result;
      }
    } catch (e) {
      logDebug(`Tầng 4 (${browser}) Lỗi: ${e.message.split('\n')[0]}`);
    }
  }

  logDebug('❌ TẤT CẢ CÁC TẦNG ĐỀU THẤT BẠI!');
  throw new Error('Không thể tải video Douyin này. Hãy kiểm tra lại đường link hoặc thử lại sau vài giây.');
}

/**
 * 2. TikTok (Quốc Tế): Bóc tách video không logo (No Watermark) chuẩn 1080p HD
 */
async function parseTikTok(videoUrl) {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}&hd=1`;
    const res = await fetchUrl(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const json = JSON.parse(res.data);
    if (json.code === 0 && json.data) {
      const d = json.data;
      const downloads = [];

      if (d.hdplay) {
        downloads.push({
          quality: '1080p Full HD (Có Tiếng + Không Logo)',
          type: 'mp4',
          url: d.hdplay.startsWith('http') ? d.hdplay : `https://www.tikwm.com${d.hdplay}`,
          badge: 'TikTok Full HD',
          size: d.hd_size ? `${(d.hd_size / (1024 * 1024)).toFixed(1)} MB` : null
        });
      }

      if (d.play) {
        downloads.push({
          quality: 'Chất Lượng Tiêu Chuẩn (Có Tiếng + Không Logo)',
          type: 'mp4',
          url: d.play.startsWith('http') ? d.play : `https://www.tikwm.com${d.play}`,
          badge: 'Hình + Tiếng',
          size: d.size ? `${(d.size / (1024 * 1024)).toFixed(1)} MB` : null
        });
      }

      if (d.music) {
        downloads.push({
          quality: 'Tùy chọn phụ: Chỉ Tải Riêng Nhạc Nền MP3 (Không lấy video)',
          type: 'mp3',
          url: d.music.startsWith('http') ? d.music : `https://www.tikwm.com${d.music}`,
          badge: 'Chỉ Lấy MP3'
        });
      }

      if (Array.isArray(d.images) && d.images.length > 0) {
        d.images.forEach((imgUrl, idx) => {
          downloads.push({
            quality: `Tải Ảnh #${idx + 1} (Gốc HD)`,
            type: 'jpg',
            url: imgUrl,
            badge: 'Ảnh nét'
          });
        });
      }

      return {
        platform: 'TikTok',
        platformIcon: '🎵',
        title: d.title || 'Video TikTok Không Logo HD',
        author: d.author?.nickname || d.author?.unique_id || 'TikTok User',
        avatar: d.author?.avatar || null,
        thumbnail: d.cover || null,
        duration: d.duration ? `${d.duration}s` : null,
        downloads
      };
    }
  } catch (err) {
    console.warn('[Parse TikTok Error]', err.message);
  }

  // Dự phòng TikTok qua yt-dlp core
  try {
    const ytdlpInfo = await extractWithYtDlp(videoUrl);
    if (ytdlpInfo && (ytdlpInfo.url || (ytdlpInfo.formats && ytdlpInfo.formats.length > 0))) {
      const bestVideo = ytdlpInfo.url || ytdlpInfo.formats[ytdlpInfo.formats.length - 1].url;
      return {
        platform: 'TikTok',
        platformIcon: '🎵',
        title: ytdlpInfo.title || 'Video TikTok HD',
        author: ytdlpInfo.uploader || 'TikTok User',
        thumbnail: ytdlpInfo.thumbnail || null,
        duration: ytdlpInfo.duration ? `${ytdlpInfo.duration}s` : null,
        downloads: [
          {
            quality: '1080p Full HD (Không Logo)',
            type: 'mp4',
            url: bestVideo,
            badge: 'TikTok HD'
          }
        ]
      };
    }
  } catch (err) {
    console.warn('[TikTok yt-dlp Error]', err.message);
  }

  throw new Error('Không thể tải video TikTok này. Hãy kiểm tra lại liên kết hoặc xem video có ở chế độ riêng tư không.');
}

/**
 * 2. Facebook: Bóc tách video Facebook Reels, Watch & Video bài viết (HD 1080p / SD)
 * Hệ thống 2 lớp: HTML Scraper trực tiếp -> yt-dlp Core nội bộ (Bypass Login Block)
 */
async function parseFacebook(videoUrl) {
  // Lớp 1: Bóc tách trực tiếp từ HTML Facebook (Nhanh nhất)
  try {
    const res = await fetchUrl(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Sec-Fetch-Mode': 'navigate'
      }
    });

    const html = res.data;
    let hdUrl = null;
    let sdUrl = null;
    let title = 'Video Facebook HD';
    let thumb = null;

    // Tìm HD src đa dạng regex (browser_native_hd_url, playable_url_quality_hd, hd_src)
    const hdMatch = html.match(/"browser_native_hd_url":"([^"]+)"/) || 
                    html.match(/"playable_url_quality_hd":"([^"]+)"/) || 
                    html.match(/hd_src:"([^"]+)"/);
    if (hdMatch) hdUrl = hdMatch[1].replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

    // Tìm SD src (browser_native_sd_url, playable_url, sd_src)
    const sdMatch = html.match(/"browser_native_sd_url":"([^"]+)"/) || 
                    html.match(/"playable_url":"([^"]+)"/) || 
                    html.match(/sd_src:"([^"]+)"/);
    if (sdMatch) sdUrl = sdMatch[1].replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

    // Tìm tiêu đề
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].replace(/&amp;/g, '&');

    // Tìm thumbnail
    const thumbMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (thumbMatch) thumb = thumbMatch[1].replace(/&amp;/g, '&');

    const downloads = [];
    if (hdUrl) {
      downloads.push({
        quality: '1080p / 720p HD Siêu Nét',
        type: 'mp4',
        url: hdUrl,
        badge: 'Facebook HD'
      });
    }
    if (sdUrl) {
      downloads.push({
        quality: 'Chất Lượng Tiêu Chuẩn (SD)',
        type: 'mp4',
        url: sdUrl,
        badge: 'Facebook SD'
      });
    }

    if (downloads.length > 0) {
      return {
        platform: 'Facebook',
        platformIcon: '📘',
        title: title || 'Video Facebook Reels',
        author: 'Facebook User',
        thumbnail: thumb,
        downloads
      };
    }
  } catch (err) {
    console.warn('[Parse Facebook HTML Error]', err.message);
  }

  // Lớp 2: yt-dlp core nội bộ (chạy trực tiếp trên máy người dùng, bypass login block cho Reels, Watch, Page posts)
  try {
    const ytdlpInfo = await extractWithYtDlp(videoUrl);
    if (ytdlpInfo && (ytdlpInfo.url || (ytdlpInfo.formats && ytdlpInfo.formats.length > 0))) {
      const downloads = [];
      const formats = ytdlpInfo.formats || [];
      
      // Lọc các định dạng có cả video lẫn âm thanh (progressive)
      const progressiveFormats = formats.filter(f => f.url && f.vcodec !== 'none' && f.acodec !== 'none');
      progressiveFormats.sort((a, b) => ((b.height || 0) - (a.height || 0)));

      const hdFmt = progressiveFormats.find(f => (f.height && f.height >= 720) || (f.format_note && f.format_note.toLowerCase().includes('hd')));
      const sdFmt = progressiveFormats.find(f => f !== hdFmt && (f.height || f.filesize));

      if (hdFmt) {
        downloads.push({
          quality: `${hdFmt.height ? hdFmt.height + 'p ' : ''}HD Siêu Nét`,
          type: 'mp4',
          url: hdFmt.url,
          badge: 'Facebook HD',
          size: hdFmt.filesize ? `${(hdFmt.filesize / (1024 * 1024)).toFixed(1)} MB` : null
        });
      }

      if (sdFmt) {
        downloads.push({
          quality: `${sdFmt.height ? sdFmt.height + 'p ' : ''}Tiêu Chuẩn (SD)`,
          type: 'mp4',
          url: sdFmt.url,
          badge: 'Facebook SD',
          size: sdFmt.filesize ? `${(sdFmt.filesize / (1024 * 1024)).toFixed(1)} MB` : null
        });
      }

      if (downloads.length === 0) {
        const bestUrl = ytdlpInfo.url || (formats.length > 0 ? formats[formats.length - 1].url : null);
        if (bestUrl) {
          downloads.push({
            quality: '1080p / 720p HD (Gốc Không Giảm Chất Lượng)',
            type: 'mp4',
            url: bestUrl,
            badge: 'Facebook HD'
          });
        }
      }

      if (downloads.length > 0) {
        return {
          platform: 'Facebook',
          platformIcon: '📘',
          title: ytdlpInfo.title || 'Video Facebook HD',
          author: ytdlpInfo.uploader || 'Facebook User',
          thumbnail: ytdlpInfo.thumbnail || null,
          duration: ytdlpInfo.duration ? `${ytdlpInfo.duration}s` : null,
          downloads
        };
      }
    }
  } catch (err) {
    console.warn('[Parse Facebook yt-dlp Error]', err.message);
  }

  throw new Error('Không thể bóc tách video Facebook này. Hãy đảm bảo video được để ở chế độ Công Khai (Public).');
}

/**
 * 3. YouTube: Bóc tách YouTube Video, Shorts & Nhạc MP3
 * Hệ thống 2 lớp: oEmbed Metadata cực nhanh -> yt-dlp Core nội bộ stream trực tiếp
 */
async function parseYouTube(videoUrl) {
  let videoId = null;
  try {
    const urlObj = new URL(videoUrl);
    if (urlObj.hostname.includes('youtu.be')) {
      videoId = urlObj.pathname.slice(1).split('/')[0].split('?')[0];
    } else if (urlObj.pathname.includes('/shorts/')) {
      videoId = urlObj.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
    } else if (urlObj.pathname.includes('/embed/')) {
      videoId = urlObj.pathname.split('/embed/')[1].split('/')[0].split('?')[0];
    } else {
      videoId = urlObj.searchParams.get('v');
    }
  } catch (e) {}

  let title = 'YouTube Video HD';
  let author = 'YouTube Creator';
  let thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;

  // Lớp 1: oEmbed chính thức của YouTube (Rất nhanh, không bị rate-limit)
  let oembedSuccess = false;
  if (videoId) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const oembedRes = await fetchUrl(oembedUrl);
      const info = JSON.parse(oembedRes.data);
      if (info && info.title) {
        title = info.title;
        author = info.author_name || author;
        oembedSuccess = true;
      }
    } catch (err) {
      console.warn('[YouTube oEmbed Warning]', err.message);
    }
  }

  // Lớp 2: Nếu oEmbed thất bại (video giới hạn tuổi hoặc định dạng đặc biệt), dùng yt-dlp core
  if (!oembedSuccess) {
    try {
      const ytdlpInfo = await extractWithYtDlp(videoUrl);
      if (ytdlpInfo && ytdlpInfo.title) {
        title = ytdlpInfo.title;
        author = ytdlpInfo.uploader || author;
        if (ytdlpInfo.thumbnail) thumbnail = ytdlpInfo.thumbnail;
      }
    } catch (err) {
      console.warn('[YouTube yt-dlp Info Warning]', err.message);
    }
  }

  const safeTitle = (title || 'YouTube_Video').replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF ]/g, '_').slice(0, 40);
  const downloads = [
    {
      quality: '1080p Full HD (Chuẩn Nét Có Tiếng)',
      type: 'mp4',
      url: `/api/ytdlp-download?url=${encodeURIComponent(videoUrl)}&quality=1080&filename=${encodeURIComponent(safeTitle)}_1080p.mp4`,
      isDirectAppRoute: true,
      badge: '1080p Full HD'
    },
    {
      quality: '720p HD (Tốc Độ Tải Siêu Nhanh)',
      type: 'mp4',
      url: `/api/ytdlp-download?url=${encodeURIComponent(videoUrl)}&quality=720&filename=${encodeURIComponent(safeTitle)}_720p.mp4`,
      isDirectAppRoute: true,
      badge: '720p HD'
    },
    {
      quality: '360p Tiết Kiệm Dung Lượng',
      type: 'mp4',
      url: `/api/ytdlp-download?url=${encodeURIComponent(videoUrl)}&quality=360&filename=${encodeURIComponent(safeTitle)}_360p.mp4`,
      isDirectAppRoute: true
    },
    {
      quality: 'Tách Nhạc Nền MP3 (Âm Thanh Gốc)',
      type: 'mp3',
      url: `/api/ytdlp-download?url=${encodeURIComponent(videoUrl)}&audio=true&filename=${encodeURIComponent(safeTitle)}_audio.mp3`,
      isDirectAppRoute: true,
      badge: 'Chỉ Lấy MP3'
    }
  ];

  return {
    platform: 'YouTube',
    platformIcon: '▶️',
    title,
    author,
    thumbnail,
    downloads
  };
}

/**
 * 4. Instagram: Bóc tách Reels & Video
 */
async function parseInstagram(videoUrl) {
  try {
    // Chuẩn hóa url thêm /?__a=1&__d=dis
    const cleanUrl = videoUrl.split('?')[0].replace(/\/+$/, '');
    const apiUrl = `${cleanUrl}/?__a=1&__d=dis`;
    const res = await fetchUrl(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json'
      }
    });

    const json = JSON.parse(res.data);
    const item = json.graphql?.shortcode_media || json.items?.[0];

    if (item && item.video_url) {
      return {
        platform: 'Instagram',
        platformIcon: '📸',
        title: item.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 80) || 'Instagram Reel Video HD',
        author: item.owner?.username || 'Instagram User',
        thumbnail: item.display_url || null,
        downloads: [
          {
            quality: '1080p HD Gốc Không Logo',
            type: 'mp4',
            url: item.video_url,
            badge: 'Chất lượng gốc'
          }
        ]
      };
    }
  } catch (err) {
    console.warn('[Parse Instagram Error]', err.message);
  }

  throw new Error('Không thể tải video Instagram này. Hãy kiểm tra tài khoản có để ở chế độ Công khai không.');
}

/**
 * 5. Bilibili Trung Quốc: Bóc tách video HD (b23.tv & bilibili.com)
 * Kết hợp lấy Metadata chính xác qua API Bilibili và luồng Direct Stream qua yt-dlp Core
 */
async function parseBilibili(videoUrl) {
  try {
    let finalUrl = videoUrl;
    // Xử lý link rút gọn dạng https://b23.tv/xxxxxx
    if (/b23\.tv/i.test(videoUrl)) {
      const redirected = await fetchUrl(videoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      finalUrl = redirected.finalUrl || videoUrl;
    }

    // Trích xuất BV id
    let bvid = null;
    const bvMatch = finalUrl.match(/video\/(BV[a-zA-Z0-9]+)/i) || videoUrl.match(/(BV[a-zA-Z0-9]+)/i);
    if (bvMatch) {
      bvid = bvMatch[1];
    }

    if (!bvid) {
      throw new Error('Không tìm thấy mã video Bilibili (BVID).');
    }

    // 1. Lấy buvid token tự động từ Bilibili để bypass mã lỗi 412
    let cookie = '';
    try {
      const spiRes = await fetchUrl('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.bilibili.com/'
        }
      });
      const spiJson = JSON.parse(spiRes.data);
      if (spiJson.data && spiJson.data.b_3) {
        cookie = `buvid3=${spiJson.data.b_3}; buvid4=${spiJson.data.b_4};`;
      }
    } catch (e) {
      cookie = 'buvid3=auto;';
    }

    // 2. Lấy thông tin video (Title, Cover, Tác giả, Danh sách tập/Parts)
    const viewApi = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const viewRes = await fetchUrl(viewApi, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Cookie': cookie
      }
    });

    const viewJson = JSON.parse(viewRes.data);
    if (viewJson.code !== 0 || !viewJson.data) {
      throw new Error(viewJson.message || 'Video Bilibili không tồn tại hoặc đã bị ẩn.');
    }

    const data = viewJson.data;
    const title = data.title || 'Bilibili Video HD';
    const author = data.owner?.name || 'Bilibili Creator';
    const thumbnail = data.pic ? data.pic.replace('http:', 'https:') : null;
    const durationHours = (data.duration / 3600).toFixed(1);
    const duration = data.duration > 3600 ? `${durationHours} Giờ (${data.duration}s)` : `${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, '0')}`;

    // 3. Xây danh sách tải — dùng /api/bili-download (luôn fetch link CDN mới khi bấm tải)
    const downloads = [];

    if (Array.isArray(data.pages) && data.pages.length > 0) {
      for (const p of data.pages) {
        const pHours = (p.duration / 3600).toFixed(1);
        const pMin  = Math.floor(p.duration / 60);

        // Lấy kích thước file (chỉ cần gọi playurl 1 lần để hiển thị dung lượng — link này có thể hết hạn, không sao)
        let sizeText = null;
        try {
          const playApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${p.cid}&qn=64&type=mp4&platform=html5`;
          const playRes = await fetchUrl(playApi, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.bilibili.com/'
            }
          });
          const playJson = JSON.parse(playRes.data);
          if (playJson.code === 0 && playJson.data?.durl?.[0]?.size) {
            const bytes = playJson.data.durl[0].size;
            sizeText = bytes > 1073741824
              ? `${(bytes / 1073741824).toFixed(2)} GB`
              : `${(bytes / 1048576).toFixed(1)} MB`;
          }
        } catch (e) { /* bỏ qua, size không bắt buộc */ }

        const durationLabel = p.duration >= 3600 ? `${pHours} Giờ` : `${pMin} phút`;
        const partLabel = data.pages.length > 1
          ? `Tải Tập #${p.page}: ${p.part || ('Phần ' + p.page)} (${durationLabel})`
          : `Tải Video MP4 (${durationLabel})`;

        // URL trỏ đến endpoint /api/bili-download với bvid+cid (sẽ fetch link CDN mới ngay lúc bấm tải)
        const safePartName = (p.part || ('part' + p.page)).replace(/[^\w\u4E00-\u9FFF\u3040-\u30FF]+/g, '_').slice(0, 30);
        const dlFilename = `${title.slice(0, 30)}_Tap${p.page}_${safePartName}.mp4`;

        downloads.push({
          quality: partLabel,
          type: 'mp4',
          url: `/api/bili-download?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(p.cid)}&part=${p.page}&filename=${encodeURIComponent(dlFilename)}`,
          isDirectAppRoute: true,
          size: sizeText,
          badge: 'Hình + Tiếng'
        });
      }
    }

    // Tùy chọn phụ: tải âm thanh riêng (cũng qua /api/bili-download)
    if (downloads.length > 0 && data.pages?.length > 0) {
      const firstCid = data.pages[0].cid;
      downloads.push({
        quality: 'Tùy chọn: Chỉ Tải Riêng File Âm Thanh (không có hình)',
        type: 'mp3',
        url: `/api/bili-download?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(firstCid)}&part=1&filename=${encodeURIComponent(title.slice(0,30) + '_audio.mp4')}`,
        isDirectAppRoute: true,
        badge: 'Chỉ Lấy MP3'
      });
    }

    return {
      platform: 'Bilibili (哔哩哔哩)',
      platformIcon: '📺',
      title,
      author,
      thumbnail,
      duration,
      downloads
    };
  } catch (err) {
    console.warn('[Parse Bilibili Error]', err.message);
    throw new Error('Lỗi khi tải video Bilibili: ' + (err.message || 'Hãy kiểm tra lại đường link.'));
  }
}

/**
 * 6. X (Twitter): Bóc tách video Twitter / X
 */
async function parseTwitter(videoUrl) {
  try {
    const tweetMatch = videoUrl.match(/status\/(\d+)/);
    if (!tweetMatch) throw new Error('Không tìm thấy ID bài đăng X/Twitter.');
    const tweetId = tweetMatch[1];

    const apiUrl = `https://api.vxtwitter.com/Twitter/status/${tweetId}`;
    const res = await fetchUrl(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const data = JSON.parse(res.data);
    const media = data.media_extended || [];
    const videoMedia = media.find(m => m.type === 'video' || m.type === 'gif');

    if (videoMedia && videoMedia.url) {
      return {
        platform: 'X (Twitter)',
        platformIcon: '𝕏',
        title: data.text?.slice(0, 80) || 'Video X (Twitter) HD',
        author: data.user_name || 'Twitter User',
        thumbnail: videoMedia.thumbnail_url || null,
        downloads: [
          {
            quality: '1080p / 720p HD Gốc',
            type: 'mp4',
            url: videoMedia.url,
            badge: 'HD Twitter'
          }
        ]
      };
    }
  } catch (err) {
    console.warn('[Parse Twitter Error]', err.message);
  }
  throw new Error('Không thể tải video Twitter này hoặc bài viết không chứa video.');
}

/**
 * 7. Xiaohongshu (Tiểu Hồng Thư / RED 小红书): Mạng xã hội video trend Trung Quốc
 */
async function parseXiaohongshu(videoUrl) {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`;
    const res = await fetchUrl(apiUrl);
    const json = JSON.parse(res.data);
    if (json.code === 0 && json.data) {
      const d = json.data;
      const downloads = [];
      if (d.play) {
        downloads.push({
          quality: '1080p HD Không Logo (小红书)',
          type: 'mp4',
          url: d.play,
          badge: 'RED Gốc'
        });
      }
      if (Array.isArray(d.images) && d.images.length > 0) {
        d.images.forEach((img, idx) => {
          downloads.push({
            quality: `Ảnh #${idx + 1} (Gốc HD)`,
            type: 'jpg',
            url: img,
            badge: 'HD'
          });
        });
      }
      return {
        platform: 'Xiaohongshu (小红书)',
        platformIcon: '📕',
        title: d.title || 'Video Tiểu Hồng Thư HD',
        author: d.author?.nickname || 'RED Creator',
        thumbnail: d.cover,
        downloads
      };
    }
  } catch (err) {
    console.warn('[Parse Xiaohongshu Error]', err.message);
  }
  throw new Error('Không thể bóc tách bài đăng Tiểu Hồng Thư (小红书) này.');
}

/**
 * 8. Kuaishou (Kwai / 快手 Trung Quốc)
 */
async function parseKuaishou(videoUrl) {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`;
    const res = await fetchUrl(apiUrl);
    const json = JSON.parse(res.data);
    if (json.code === 0 && json.data) {
      const d = json.data;
      return {
        platform: 'Kuaishou (快手)',
        platformIcon: '⚡',
        title: d.title || 'Video Kuaishou HD',
        author: d.author?.nickname || 'Kwai Creator',
        thumbnail: d.cover,
        downloads: [
          {
            quality: '1080p HD Không Logo',
            type: 'mp4',
            url: d.play || d.hdplay,
            badge: 'Kwai HD'
          }
        ]
      };
    }
  } catch (err) {
    console.warn('[Parse Kuaishou Error]', err.message);
  }
  throw new Error('Không thể bóc tách video Kuaishou (快手) này.');
}

/**
 * TỔNG HỢP: Tự nhận diện nền tảng thông minh từ URL (Kèm trích xuất regex văn bản dán kèm tiếng Trung/Việt)
 */
async function parseAnyVideo(rawInput) {
  let text = String(rawInput || '').trim();
  if (!text) throw new Error('Vui lòng dán một đường link video hợp lệ.');

  // Trích xuất chính xác URL video từ chuỗi dán (kể cả khi dính kèm chữ tiếng Trung/Việt từ app)
  // Hỗ trợ cả: v.douyin.com, www.douyin.com/video/..., www.douyin.com/jingxuan?modal_id=..., iesdouyin.com
  const douyinMatch = text.match(/https?:\/\/(?:(?:v|www|iesdouyin)\.douyin\.com|douyin\.com)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const tiktokMatch = text.match(/https?:\/\/(?:www|vm|vt|t|m)\.tiktok\.com\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const biliMatch   = text.match(/https?:\/\/(?:www\.)?(?:bilibili\.com|b23\.tv)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const fbMatch     = text.match(/https?:\/\/(?:www|m|web|fb)?\.?(?:facebook\.com|fb\.watch|fb\.me)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const ytMatch     = text.match(/https?:\/\/(?:www|m)?\.?(?:youtube\.com|youtu\.be)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const igMatch     = text.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const xMatch      = text.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const xhsMatch    = text.match(/https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.com)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
  const kwaiMatch   = text.match(/https?:\/\/(?:www\.)?(?:kuaishou\.com|kwai\.com)\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);

  if (douyinMatch) {
    const cleanUrl = douyinMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseDouyin(cleanUrl);
  } else if (tiktokMatch) {
    const cleanUrl = tiktokMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseTikTok(cleanUrl);
  } else if (biliMatch) {
    const cleanUrl = biliMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseBilibili(cleanUrl);
  } else if (fbMatch) {
    const cleanUrl = fbMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseFacebook(cleanUrl);
  } else if (ytMatch) {
    const cleanUrl = ytMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseYouTube(cleanUrl);
  } else if (igMatch) {
    const cleanUrl = igMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseInstagram(cleanUrl);
  } else if (xMatch) {
    const cleanUrl = xMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseTwitter(cleanUrl);
  } else if (xhsMatch) {
    const cleanUrl = xhsMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseXiaohongshu(cleanUrl);
  } else if (kwaiMatch) {
    const cleanUrl = kwaiMatch[0].replace(/[\.,;!?，。！？]+$/, '');
    return await parseKuaishou(cleanUrl);
  } else {
    // Dự phòng tìm URL bất kỳ
    const anyUrlMatch = text.match(/https?:\/\/[^\s\u4e00-\u9fa5\uff00-\uffef]+/i);
    const fallbackUrl = anyUrlMatch ? anyUrlMatch[0].replace(/[\.,;!?，。！？]+$/, '') : text;
    if (/douyin\.com/i.test(fallbackUrl)) {
      return await parseDouyin(fallbackUrl);
    }
    return await parseTikTok(fallbackUrl);
  }
}

module.exports = {
  parseAnyVideo,
  fetchUrl
};
