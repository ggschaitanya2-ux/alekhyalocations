#!/usr/bin/env bash
# Pull latest main and restart. Run on the server:  bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only origin main
npm ci --omit=dev
npm run migrate
sudo systemctl restart alekhya-locations
sleep 1
curl -fsS http://127.0.0.1:${PORT:-3200}/api/health && echo " — updated OK"
