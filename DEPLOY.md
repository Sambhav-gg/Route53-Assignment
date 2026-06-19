# Setup & Deployment Guide

Two parts: **[Local development](#part-1--local-development)** to run it on your
machine, and **[Deploy on EC2](#part-2--deploy-on-a-single-ec2-instance)** to host
it (frontend + backend + database on one box, behind nginx, kept alive by PM2).

```
                  ┌──────────────── one EC2 instance ───────────────┐
   browser  ─────▶│  nginx :80                                       │
                  │     /         → Next.js  (PM2 → next start :3000) │
                  │     /api/...  → FastAPI  (PM2 → uvicorn   :8000)  │
                  │  route53.db   (SQLite, local disk)               │
                  └──────────────────────────────────────────────────┘
```

Same origin → the login cookie works with zero CORS config.

---

## Part 1 — Local development

**Prerequisites:** Python 3.10+, Node.js 18+.

### Backend

```bash
cd backend
python -m venv venv
# Windows:        venv\Scripts\activate
# macOS / Linux:  source venv/bin/activate
pip install -r requirements.txt

# optional: copy the env template (sensible defaults are used if you skip this)
cp .env.example .env

uvicorn app.main:app --reload --port 8000
```

API: `http://localhost:8000/api` · Docs: `http://localhost:8000/api/docs`
The SQLite DB and a demo user are created automatically on first run.

### Frontend (in a second terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000** and sign in with the demo account:

```
Email:    demo@route53.aws
Password: Demo1234!
```

---

## Part 2 — Deploy on a single EC2 instance

### 1. Launch the instance

- **AMI:** Ubuntu Server 22.04 or 24.04 LTS
- **Size:** t3.small or larger *(the Next.js build needs ~1–2 GB RAM — see
  [troubleshooting](#build-gets-killed--out-of-memory) if you're on micro)*
- **Security group — inbound rules:** allow **22** (SSH) and **80** (HTTP)
- SSH in: `ssh ubuntu@<EC2_PUBLIC_IP>`

### 2. Install system packages

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nginx git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -   # Node 20 LTS
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3. Get the code

```bash
sudo mkdir -p /opt/route53-clone
sudo chown "$USER":"$USER" /opt/route53-clone
git clone https://github.com/Sambhav-gg/Route53-Assignment.git /opt/route53-clone
cd /opt/route53-clone
```

### 4. Backend — virtualenv + environment

```bash
cd /opt/route53-clone
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r backend/requirements.txt

# create the real env file and inject a strong secret
cp backend/.env.example backend/.env
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" backend/.env
```

> Leave `COOKIE_SECURE=false` (you're serving over HTTP). Only set it to `true`
> if you later add HTTPS, or logins will silently fail.

### 5. Frontend — build for same-origin

```bash
cd /opt/route53-clone/frontend
echo 'NEXT_PUBLIC_API_URL=' > .env.production   # empty → the app calls /api on its own origin
npm ci
npm run build
```

### 6. Run both with PM2

```bash
# backend (run from backend/ so it finds .env and the DB)
cd /opt/route53-clone/backend
pm2 start ../venv/bin/uvicorn --name route53-backend --interpreter none -- \
  app.main:app --host 127.0.0.1 --port 8000

# frontend
cd /opt/route53-clone/frontend
pm2 start node_modules/next/dist/bin/next --name route53-frontend -- start -p 3000

# confirm both are "online"
pm2 status

# persist across crashes AND reboots
pm2 save
pm2 startup        # prints a `sudo env PATH=... pm2 startup ...` line — run that line
```

Quick check that both processes answer:

```bash
curl -s http://127.0.0.1:8000/api/health                       # {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000 # 200
```

### 7. nginx — one origin on port 80

```bash
sudo cp /opt/route53-clone/deploy/nginx.conf /etc/nginx/sites-available/route53
sudo ln -sf /etc/nginx/sites-available/route53 /etc/nginx/sites-enabled/route53
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t                 # must say: syntax is ok / test is successful
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Verify nginx is routing correctly:

```bash
curl -s http://127.0.0.1/api/health                       # {"status":"ok",...}  → /api → backend
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1 # 200                  → /    → frontend
```

### 8. Open it

Browse to **http://&lt;EC2_PUBLIC_IP&gt;** and sign in with `demo@route53.aws` / `Demo1234!`.

You're done. 🎉

---

## Updating after a code change

```bash
cd /opt/route53-clone
git pull
./venv/bin/pip install -r backend/requirements.txt   # only if backend deps changed
cd frontend && npm ci && npm run build               # only if frontend changed
pm2 restart all
```

## Day-to-day commands

| Action | Command |
| ------ | ------- |
| Status of both apps | `pm2 status` |
| Tail logs | `pm2 logs` · `pm2 logs route53-backend` |
| Restart everything | `pm2 restart all` |
| Restart one | `pm2 restart route53-backend` |
| Stop / remove one | `pm2 delete route53-frontend` |
| nginx logs | `sudo tail -f /var/log/nginx/error.log` |

---

## Troubleshooting

**`pm2 restart <name>` → "Process not found"**
It was never started under that name. Use `pm2 start …` first (`restart` only works
on an already-registered process).

**`Script not found: .../node_modules/next/dist/bin/next`**
Frontend dependencies aren't installed. Run `npm ci` (or `npm install`) in
`frontend/`, then `npm run build`, then start it again.

**`File ../venv/bin/uvicorn not found`**
The virtualenv isn't where the command expects. Confirm with
`ls /opt/route53-clone/venv/bin/uvicorn`; if it's missing, redo [step 4](#4-backend--virtualenv--environment).

**Browser hangs / can't connect, but the on-box `curl`s work**
The security group is blocking port **80**. Add an inbound rule for TCP 80 from
`0.0.0.0/0`. (Port 22 being open for SSH does not cover 80.) Also make sure you're
using `http://` and the raw IP — there's no HTTPS.

**Page loads but login or data fails**
Open DevTools → Network and look at the `/api/...` calls. If they 404 / hit the
wrong host, the frontend was built with the wrong `NEXT_PUBLIC_API_URL` — set
`.env.production` to empty ([step 5](#5-frontend--build-for-same-origin)) and
`npm run build` again.

<a id="build-gets-killed--out-of-memory"></a>
**`npm run build` gets killed (out of memory on a micro instance)**
Add swap, then rebuild:
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
npm run build
```

---

## Notes

- **SQLite** is fine for a single instance. It has one writer — heavy concurrent
  writes serialize. Move to Postgres before scaling out.
- The DB file and demo user are created automatically on first backend start.
- **HTTPS (optional):** point a domain at the instance, run
  `sudo certbot --nginx -d your-domain.com`, then set `COOKIE_SECURE=true` in
  `backend/.env` and `pm2 restart route53-backend`.
