@echo off
chcp 65001 >nul
echo ========================================
echo  TEST DOUYIN APIs - Kiem tra ket noi
echo ========================================
echo.

set NODE="C:\Users\ADMIN\.gemini\antigravity\scratch\UniversalDownloader\runtime\node.exe"

echo [1] Test TikWM IP 104.26.12.103 (Cloudflare CDN 1)...
%NODE% -e "const https=require('https');const opts={hostname:'104.26.12.103',port:443,path:'/api/?url=https://www.douyin.com/video/7306163536368294179&hd=1',method:'GET',headers:{'Host':'www.tikwm.com','User-Agent':'Mozilla/5.0','Referer':'https://www.tikwm.com/','Accept':'application/json'},rejectUnauthorized:false,servername:'www.tikwm.com',timeout:8000};const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log('TikWM IP1 =>',j.code===0?'THANH CONG! hdplay='+j.data.hdplay?.substring(0,60):'THAT BAI code='+j.code+' msg='+j.msg);}catch(e){console.log('TikWM IP1 => Parse ERROR:',d.substring(0,100));}});});req.on('error',e=>console.log('TikWM IP1 => CONNECT ERROR:',e.message));req.on('timeout',()=>{req.destroy();console.log('TikWM IP1 => TIMEOUT');});req.end();"

echo.
echo [2] Test TikWM IP 104.26.13.103 (Cloudflare CDN 2)...
%NODE% -e "const https=require('https');const opts={hostname:'104.26.13.103',port:443,path:'/api/?url=https://www.douyin.com/video/7306163536368294179&hd=1',method:'GET',headers:{'Host':'www.tikwm.com','User-Agent':'Mozilla/5.0','Referer':'https://www.tikwm.com/','Accept':'application/json'},rejectUnauthorized:false,servername:'www.tikwm.com',timeout:8000};const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log('TikWM IP2 =>',j.code===0?'THANH CONG! hdplay='+j.data.hdplay?.substring(0,60):'THAT BAI code='+j.code+' msg='+j.msg);}catch(e){console.log('TikWM IP2 => Parse ERROR:',d.substring(0,100));}});});req.on('error',e=>console.log('TikWM IP2 => CONNECT ERROR:',e.message));req.on('timeout',()=>{req.destroy();console.log('TikWM IP2 => TIMEOUT');});req.end();"

echo.
echo [3] Test TikWM IP 172.67.68.49 (Cloudflare CDN 3)...
%NODE% -e "const https=require('https');const opts={hostname:'172.67.68.49',port:443,path:'/api/?url=https://www.douyin.com/video/7306163536368294179&hd=1',method:'GET',headers:{'Host':'www.tikwm.com','User-Agent':'Mozilla/5.0','Referer':'https://www.tikwm.com/','Accept':'application/json'},rejectUnauthorized:false,servername:'www.tikwm.com',timeout:8000};const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);console.log('TikWM IP3 =>',j.code===0?'THANH CONG! hdplay='+j.data.hdplay?.substring(0,60):'THAT BAI code='+j.code+' msg='+j.msg);}catch(e){console.log('TikWM IP3 => Parse ERROR:',d.substring(0,100));}});});req.on('error',e=>console.log('TikWM IP3 => CONNECT ERROR:',e.message));req.on('timeout',()=>{req.destroy();console.log('TikWM IP3 => TIMEOUT');});req.end();"

echo.
echo [4] Test ByteDance Feed API (api22-normal-c-useast1a.tiktokv.com)...
%NODE% -e "const https=require('https');const opts={hostname:'api22-normal-c-useast1a.tiktokv.com',port:443,path:'/aweme/v1/feed/?aweme_id=7306163536368294179&iid=7318518857994389254&device_id=7318518857994389254&channel=tiktok_web&app_name=tiktok_web&device_platform=web_pc',method:'GET',headers:{'User-Agent':'TikTok 26.2.0 rv:262018 (iPhone; iOS 14.4.2; en_US) Cronet','Accept':'application/json'},timeout:8000};const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);const aw=j.aweme_list&&j.aweme_list[0];const v=aw&&aw.video&&aw.video.play_addr&&aw.video.play_addr.url_list&&aw.video.play_addr.url_list[0];console.log('ByteDance =>',v?'THANH CONG! url='+v.substring(0,60):'THAT BAI status='+j.status_code);}catch(e){console.log('ByteDance => Parse ERROR:',d.substring(0,150));}});});req.on('error',e=>console.log('ByteDance => ERROR:',e.message));req.on('timeout',()=>{req.destroy();console.log('ByteDance => TIMEOUT');});req.end();"

echo.
echo [5] Test DoH (1.1.1.1 DNS-over-HTTPS) cho tikwm.com...
%NODE% -e "const https=require('https');const opts={hostname:'1.1.1.1',port:443,path:'/dns-query?name=www.tikwm.com&type=A',method:'GET',headers:{'Accept':'application/dns-json'},rejectUnauthorized:false,timeout:5000};const req=https.request(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);const a=j.Answer&&j.Answer.find(r=>r.type===1);console.log('DoH tikwm.com =>',a?'IP='+a.data:'Khong tim duoc IP');}catch(e){console.log('DoH => ERROR:',d.substring(0,100));}});});req.on('error',e=>console.log('DoH => CONNECT ERROR:',e.message));req.on('timeout',()=>{req.destroy();console.log('DoH => TIMEOUT');});req.end();"

echo.
echo ========================================
echo  Xem ket qua o tren.
echo  THANH CONG = API do hoat dong duoc!
echo  Khoi dong lai server sau khi xem xong.
echo ========================================
pause
