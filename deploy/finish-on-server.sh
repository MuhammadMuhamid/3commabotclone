#!/bin/bash
# Run ON THE EC2 instance (after SSH in), or via:
#   ssh -i ~/Downloads/tradingsignalbot.pem ubuntu@bot.alphawebstudioz.com 'bash -s' < deploy/finish-on-server.sh

set -euo pipefail
cd /opt/tradingbot

if ! grep -q '8080:80' docker-compose.yml; then
  sed -i 's/"80:80"/"8080:80"/' docker-compose.yml
fi

sudo docker compose up -d --build

sudo cp /opt/tradingbot/deploy/nginx-production.conf /etc/nginx/sites-available/signalbot
sudo ln -sf /etc/nginx/sites-available/signalbot /etc/nginx/sites-enabled/signalbot
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "Backend:  $(curl -sf http://127.0.0.1:4000/health)"
echo "Frontend: $(curl -sf http://127.0.0.1:8080/health)"
echo "Done — open https://bot.alphawebstudioz.com"
