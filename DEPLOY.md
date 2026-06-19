# Deploying Route 53 Clone on a single EC2 instance

This runs the **frontend, backend, and database on one EC2 box**, with **nginx**
in front routing everything through a single origin:

```
                 ┌──────────────── EC2 (Ubuntu) ────────────────┐
  browser  ─────▶│  nginx :80/:443                               │
                 │     /        → Next.js  (next start)  :3000   │
                 │     /api/... → FastAPI  (uvicorn)     :8000   │
                 │  route53.db  (SQLite, local disk)             │
                 └───────────────────────────────────────────────┘
```

Same-origin means the auth cookie works with no CORS configuration.

---

## 1. Launch the instance

- **AMI:** Ubuntu Server 22.04 or 24.04 LTS
- **Type:** t3.small or larger (the Next.js build needs ~1–2 GB RAM; on t2.micro
  add swap before building)
- **Security group inbound:** allow `22` (SSH), `80` (HTTP), `443` (HTTPS)
- SSH in: `ssh ubuntu@<EC2_PUBLIC_IP>`

## 2. Install system dependencies

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nginx git
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 3. Get the code

```bash
sudo mkdir -p /opt/route53-clone
sudo chown ubuntu:ubuntu /opt/route53-clone
git clone https://github.com/Sambhav-gg/Route53-Assignment.git /opt/route53-clone
cd /opt/route53-clone
```

## 4. Backend

```bash
cd /opt/route53-clone
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r backend/requirements.txt

# Create the real env file from the template
cp backend/.env.example backend/.env
# Generate a strong secret and write it in:
SECRET=$(openssl rand -hex 32)
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$SECRET|" backend/.env
```

Leave `COOKIE_SECURE=false` for now (we start on plain HTTP); flip it to `true`
in step 8 after enabling HTTPS.

## 5. Frontend (build with the same-origin API base)

```bash
cd /opt/route53-clone/frontend
npm ci
# Empty API URL → the app calls /api on its own origin (served by nginx)
echo 'NEXT_PUBLIC_API_URL=' > .env.production
npm run build
```

## 6. Start both apps

Pick **one** process manager — PM2 (6a) **or** systemd (6b). Don't run both, or
they'll fight over ports 8000/3000.

### 6a. PM2 (recommended if you prefer Node tooling)

```bash
sudo npm install -g pm2
cd /opt/route53-clone
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup            # prints a `sudo env PATH=... pm2 startup ...` command — run it
```

Useful: `pm2 status`, `pm2 logs`, `pm2 restart all`, `pm2 logs route53-backend`.
After a `git pull`/rebuild: `pm2 restart all`.

### 6b. systemd

```bash
sudo cp /opt/route53-clone/deploy/route53-backend.service  /etc/systemd/system/
sudo cp /opt/route53-clone/deploy/route53-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now route53-backend route53-frontend

# Check they're up
systemctl status route53-backend --no-pager
systemctl status route53-frontend --no-pager
curl -s http://127.0.0.1:8000/api/health   # {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000   # 200
```

## 7. nginx

```bash
sudo cp /opt/route53-clone/deploy/nginx.conf /etc/nginx/sites-available/route53
sudo ln -sf /etc/nginx/sites-available/route53 /etc/nginx/sites-enabled/route53
sudo rm -f /etc/nginx/sites-enabled/default     # drop the welcome page
sudo nginx -t && sudo systemctl reload nginx
```

Visit **http://&lt;EC2_PUBLIC_IP&gt;** — log in with the seeded demo account
(`demo@route53.aws` / `Demo1234!`) or sign up.

## 8. (Optional but recommended) HTTPS

With a domain pointed at the instance:

```bash
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
# set `server_name your-domain.com;` in the nginx config first, then:
sudo certbot --nginx -d your-domain.com
```

Then harden the cookie and restart the API:

```bash
sed -i 's|^COOKIE_SECURE=.*|COOKIE_SECURE=true|' /opt/route53-clone/backend/.env
sudo systemctl restart route53-backend
```

---

## Updating after a push

```bash
cd /opt/route53-clone
git pull
./venv/bin/pip install -r backend/requirements.txt   # if deps changed
cd frontend && npm ci && npm run build               # if frontend changed
sudo systemctl restart route53-backend route53-frontend
```

## Notes & limits

- **SQLite** is fine for a demo/single instance. It has one writer — heavy
  concurrent writes will serialize. Migrate to Postgres before scaling out.
- The DB file is created and the demo user seeded automatically on first boot.
- Logs: `journalctl -u route53-backend -f` / `journalctl -u route53-frontend -f`.
