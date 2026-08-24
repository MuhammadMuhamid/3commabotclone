# Deploy Signal Bot on AWS EC2

## Prerequisites

- Domain (e.g. `bot.yourdomain.com`) pointing to your server IP
- Binance API key (spot trade only, no withdraw)
- TradingView plan with webhooks

## 1. Launch EC2

| Setting | Value |
|---------|--------|
| AMI | Ubuntu 22.04 LTS |
| Type | t3.micro |
| Storage | 20 GB |
| Security group | SSH 22 (your IP), HTTP 80, HTTPS 443 |

Associate an **Elastic IP** so the IP does not change after reboot.

## 2. Install Docker on server

```bash
ssh ubuntu@YOUR_IP
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker ubuntu
# log out and back in
```

## 3. Deploy app

```bash
git clone YOUR_REPO /opt/tradingbot
cd /opt/tradingbot
cp backend/.env.example backend/.env
nano backend/.env
```

Set at minimum:

```env
PUBLIC_URL=https://bot.yourdomain.com
DRY_RUN=true
ENCRYPTION_KEY=your-64-char-random-string
DATABASE_URL=file:/app/data/bot.db
```

```bash
docker compose up -d --build
curl http://localhost/health
```

## 4. HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d bot.yourdomain.com
```

Update `deploy/nginx-host.conf` with your domain and certificate paths, then run nginx on the host proxying to Docker port 80, **or** mount certs into a production compose override.

Simple host nginx (`/etc/nginx/sites-available/signalbot`):

```nginx
server {
    listen 443 ssl;
    server_name bot.yourdomain.com;
    ssl_certificate /etc/letsencrypt/live/bot.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.yourdomain.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## 5. TradingView

1. In the app: **Settings** → add Binance keys.
2. **Create Signal Bot** → select pairs → copy **Webhook URL** and **JSON**.
3. TradingView alert → Notifications → Webhook URL = your URL.
4. Message = JSON from the bot (replace `{{ticker}}` with symbol like `APTUSDT`).

## 6. Go live

1. Test with `DRY_RUN=true` — webhook returns 200, no real orders.
2. Set `DRY_RUN=false` and restart: `docker compose restart backend`
3. Send one small test alert.

## Webhook URL format

```
https://bot.yourdomain.com/api/webhooks/signal_bots
```

Same path as 3commas-style: `/api/webhooks/signal_bots`.
