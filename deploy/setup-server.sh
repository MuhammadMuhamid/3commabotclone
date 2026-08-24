#!/bin/bash
set -euo pipefail
# Run on Ubuntu EC2 as ubuntu user after copying tradingbot to /opt/tradingbot

sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx

sudo usermod -aG docker ubuntu
sudo systemctl enable docker
sudo systemctl start docker

cd /opt/tradingbot

# Frontend on 8080 so host nginx can use 80/443 for SSL
if ! grep -q '8080:80' docker-compose.yml; then
  sed -i 's/"80:80"/"8080:80"/' docker-compose.yml
fi

sudo docker compose up -d --build
echo "Waiting for containers..."
sleep 15
curl -sf http://localhost:4000/health && echo " backend OK" || echo " backend health check failed"
curl -sf http://localhost:8080/health && echo " frontend OK" || echo " frontend health check failed"
