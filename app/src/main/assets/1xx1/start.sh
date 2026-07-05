#!/bin/bash
# 1XX1 Platform — Linux / Android (Termux) Başlatıcı
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║          1XX1 PLATFORM v1.0.0            ║"
echo "║   Merkeziyetsiz · Reklamsız · Açık       ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# Node.js kontrolü
if ! command -v node &> /dev/null; then
  echo -e "${RED}❌ Node.js bulunamadı!${NC}"
  echo ""
  echo "Kurulum:"
  echo "  Linux:  sudo apt install nodejs"
  echo "  Termux: pkg install nodejs"
  echo "  macOS:  brew install node"
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
echo -e "✅ Node.js ${NODE_VER} bulundu"

# Proje dizini
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Port kontrolü
PORT=${X1_UI_PORT:-1331}
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo -e "${RED}⚠️  Port $PORT kullanımda. X1_UI_PORT ile değiştirin.${NC}"
  exit 1
fi

echo -e "${GREEN}🚀 1XX1 başlatılıyor...${NC}"
echo ""

# Tarayıcıyı arka planda aç (3 saniye sonra)
(sleep 3 && (
  xdg-open "http://localhost:$PORT" 2>/dev/null ||
  open "http://localhost:$PORT" 2>/dev/null ||
  echo "Tarayıcıda açın: http://localhost:$PORT"
)) &

# Çekirdeği başlat
exec node --experimental-strip-types main.ts
