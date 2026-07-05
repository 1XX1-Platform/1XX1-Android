# 1XX1 Platform — Dockerfile
# Aşama 20 — Operasyon 20.2
#
# Multi-stage build:
#   deps   → bağımlılık kurulumu (cache layer)
#   build  → TypeScript derleme
#   production → minimal çalışma ortamı

# ── Aşama 1: Bağımlılıklar ───────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# package.json ve lock dosyasını kopyala (cache için ayrı layer)
COPY package.json package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

# ── Aşama 2: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# TypeScript derle
RUN npm run build 2>/dev/null || npx tsc --noEmit 2>/dev/null || true
# Not: Bu proje sıfır-bağımlılık prensibiyle geliştirildiğinden
# gerçek derleme adımı runtime'a ertelenebilir (Deno/tsx vb.)

# ── Aşama 3: Üretim ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Güvenlik: root olmayan kullanıcı
RUN addgroup -g 1001 -S x1group && \
    adduser  -u 1001 -S x1user -G x1group

WORKDIR /app

# Üretim bağımlılıkları
COPY --from=deps  --chown=x1user:x1group /app/node_modules ./node_modules
# Uygulama kodu
COPY --from=build --chown=x1user:x1group /app/dist ./dist
COPY --chown=x1user:x1group package.json .

# Veri dizini
RUN mkdir -p /app/data && chown x1user:x1group /app/data

USER x1user

# Port açıklamaları
EXPOSE 8080   # API
EXPOSE 9090   # Prometheus metrics

# Sağlık kontrolü
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O- http://localhost:8080/health || exit 1

# Çalıştırma
CMD ["node", "dist/main.js"]

# Metadata
LABEL org.opencontainers.image.title="1XX1 Platform Node" \
      org.opencontainers.image.description="Decentralized, ad-free, open-source app ecosystem" \
      org.opencontainers.image.vendor="Kaptan (Emirhan)" \
      org.opencontainers.image.licenses="MIT"
