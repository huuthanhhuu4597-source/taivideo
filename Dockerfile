FROM node:20-bullseye-slim

# Cài đặt Python, FFmpeg và các thư viện cần thiết cho bóc tách video
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài đặt dependencies
COPY package*.json ./
RUN npm install --production

# Sao chép mã nguồn (bỏ runtime Windows)
COPY . .

ENV PORT=4000
ENV NODE_ENV=production

EXPOSE 4000

CMD ["node", "server.js"]
