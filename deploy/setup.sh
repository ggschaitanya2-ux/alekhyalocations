#!/usr/bin/env bash
# One-time install on the Utho server (Ubuntu 24.04), next to Alekhya Gate.
# Usage (as a sudo user):  bash deploy/setup.sh
set -euo pipefail
APP=/opt/alekhya/alekhya-locations
GATE_ENV=/opt/alekhya/alekhya-gate/.env
cd "$APP"

if [ ! -f .env ]; then
  cp .env.example .env
  # Reuse the Gate's database + JWT secret so logins are shared
  if [ -f "$GATE_ENV" ]; then
    DB=$(grep -E '^DATABASE_URL=' "$GATE_ENV" | head -1 | cut -d= -f2-)
    JS=$(grep -E '^JWT_SECRET=' "$GATE_ENV" | head -1 | cut -d= -f2-)
    [ -n "$DB" ] && sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB|" .env
    [ -n "$JS" ] && sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JS|" .env
    echo "Copied DATABASE_URL and JWT_SECRET from the Gate .env"
  else
    echo "!! $GATE_ENV not found — edit $APP/.env by hand before continuing"; exit 1
  fi
  chmod 600 .env
fi

npm ci --omit=dev
npm run migrate

# First install only: load the starting sites (seed/*.csv) if the location list is empty
if [ "$(node -e "require('dotenv').config();const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('select count(*)::int n from locations').then(r=>{console.log(r.rows[0].n);p.end()})")" = "0" ]; then
  for f in seed/alekhya-grand.csv seed/alekhya-grande.csv seed/vuyyuru-layout.csv; do node scripts/seed.js "$f"; done
fi

# Run as the same user that owns the Gate folder
OWNER=$(stat -c %U /opt/alekhya/alekhya-gate 2>/dev/null || echo "$USER")
sed "s/^User=.*/User=$OWNER/" deploy/alekhya-locations.service | sudo tee /etc/systemd/system/alekhya-locations.service >/dev/null
sudo chown -R "$OWNER" "$APP"
sudo systemctl daemon-reload
sudo systemctl enable --now alekhya-locations

if ! grep -q 'loc.150-241-247-25.sslip.io' /etc/caddy/Caddyfile; then
  echo "" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
  sudo tee -a /etc/caddy/Caddyfile < deploy/Caddyfile.snippet >/dev/null
  sudo systemctl reload caddy
fi
sleep 1
curl -fsS http://127.0.0.1:3200/api/health && echo
echo "Done → https://loc.150-241-247-25.sslip.io"
