FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    pandoc \
    antiword \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY package.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 8080
CMD ["npm", "start", "--", "-p", "8080"]
