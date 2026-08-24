# EC2 setup (5 minutes) — do this in Chrome/Safari (not Cursor browser)

Region: **Asia Pacific (Sydney) `ap-southeast-2`**

## Launch instance

1. Open: [https://ap-southeast-2.console.aws.amazon.com/ec2/home#LaunchInstances](https://ap-southeast-2.console.aws.amazon.com/ec2/home#LaunchInstances):
2. **Name:** `signal-bot`
3. **AMI:** Ubuntu Server 22.04 LTS (free tier)
4. **Instance type:** `t3.micro`
5. **Key pair:** Reuse the existing `tradingsignalbot` key pair if you have it. Only if creating fresh: name it `tradingsignalbot` → **Download .pem** → save to `~/Downloads/tradingsignalbot.pem` (AWS shows the private key once, at creation)
6. **Network / Security group:** Create new
  - Allow **SSH (22)** from **My IP**
  - Allow **HTTP (80)** from **Anywhere** `0.0.0.0/0`
  - Allow **HTTPS (443)** from **Anywhere** `0.0.0.0/0`
7. **Storage:** 20 GB
8. **Launch instance**

## Elastic IP (static IP for DNS)

1. EC2 → **Elastic IPs** → **Allocate**
2. **Actions** → **Associate** → choose `signal-bot` instance

Copy the **Elastic IP** (e.g. `3.105.x.x`) and tell the agent, or add DNS yourself:


| Type | Name  | Value           |
| ---- | ----- | --------------- |
| A    | `bot` | YOUR_ELASTIC_IP |


Hostinger: Domains → alphawebstudioz.com → DNS → Add A record `bot` → IP.

Wait 5–15 minutes for DNS.

## Then tell the agent

```
Elastic IP: x.x.x.x
Key path: ~/Downloads/tradingsignalbot.pem
```

The agent will SSH in and deploy automatically.