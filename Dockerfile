FROM node:22-slim

# System dependencies: FFmpeg, Chromium, fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install HyperFrames CLI globally
RUN npm install -g hyperframes

# Chromium env for headless rendering
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV HYPERFRAMES_CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY shim.js /app/shim.js

EXPOSE 8082
CMD ["node", "shim.js"]
