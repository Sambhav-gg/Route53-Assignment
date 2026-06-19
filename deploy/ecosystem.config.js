// PM2 process file — runs the FastAPI backend and the Next.js frontend
// persistently on one machine.
//
// Usage (from the repo root, after building the frontend):
//   pm2 start deploy/ecosystem.config.js
//   pm2 save
//   pm2 startup        # run the sudo command it prints, to survive reboots
//
// Paths are resolved relative to this file, so it works regardless of where
// the repo is cloned. Assumes:
//   - a Python virtualenv at  <repo>/venv   (with backend deps installed)
//   - the frontend already built (npm ci && npm run build)

const path = require("path");
const ROOT = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "route53-backend",
      // Run the venv's Python directly (no node interpreter).
      script: path.join(ROOT, "venv/bin/python"),
      args: "-m uvicorn app.main:app --host 127.0.0.1 --port 8000",
      interpreter: "none",
      // cwd = backend/ so python-dotenv finds backend/.env and ./route53.db
      cwd: path.join(ROOT, "backend"),
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
    {
      name: "route53-frontend",
      // Next.js production server (output of `npm run build`).
      script: path.join(ROOT, "frontend/node_modules/next/dist/bin/next"),
      args: "start -p 3000",
      cwd: path.join(ROOT, "frontend"),
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
