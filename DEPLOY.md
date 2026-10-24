# Deploying to AWS (EC2 + Nginx + systemd)

This repo contains no deployment files, so this guide is a recommended setup, not a description of your live server.
Check each step against what is actually running before changing anything.

## 1. System packages (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y nodejs npm ffmpeg python3-pip nginx
sudo pip3 install -U yt-dlp --break-system-packages   # or: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
node -v   # needs >= 18 (a JS runtime is also used by yt-dlp for YouTube: --js-runtimes deno,node)
yt-dlp --version
```

yt-dlp is **not** in `package.json`; the server uses the `yt-dlp` on `PATH`. YouTube changes often, so update it regularly (`sudo yt-dlp -U`).

## 2. App

```bash
cd /opt/yt-downloader && npm ci --omit=dev
cp .env.example .env && chmod 600 .env   # then set APP_PASSWORD (required) to a long random value
```

The server exits at startup if `APP_PASSWORD` is missing or still the old default `download123`.
Keep `HOST=127.0.0.1` and `TRUST_PROXY=1` when Nginx is in front.

## 3. systemd (`/etc/systemd/system/ytdl.service`)

```ini
[Unit]
Description=YT Downloader
After=network.target

[Service]
WorkingDirectory=/opt/yt-downloader
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=ytdl
KillMode=control-group
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ytdl
journalctl -u ytdl -f          # logs
curl -s localhost:3000/api/health
```

## 4. Nginx (HTTPS + long-running SSE downloads)

Use `proxy_pass http://127.0.0.1:3000;` with `proxy_buffering off; proxy_read_timeout 900s; client_max_body_size 500m;`
and a certificate (e.g. `certbot --nginx`). In the EC2 security group open only 80/443 (and SSH from your IP); do not expose 3000.

## 5. Verify

- `curl -i https://YOUR_DOMAIN/api/info?url=https://youtu.be/jNQXAC9IVRw` returns 401 without a token.
- Log in from the UI, download a short public video, confirm the file plays.
- `df -h` and `ls public_downloads/.jobs` (should be empty when idle).

## Rollback

```bash
git log --oneline -5 && git checkout <previous-commit> && sudo systemctl restart ytdl
```

## Server state files

- `.sessions.json` keeps hashed login sessions so restarts don't log you out (git-ignored, mode 600).
  Changing `APP_PASSWORD` invalidates every saved session. Override the path with `SESSIONS_FILE`.
- File links returned by `/api/download` are signed and expire after 60 minutes, matching file retention.

## Android signing

The old `release.keystore` (and its passwords) was public in Git history and is no longer used.
Release builds now sign with `android/app/ytdl-release.jks`, configured by `android/keystore.properties`.
Both are git-ignored. **Back both up somewhere safe (password manager / offline):** without them you
can't publish updates that install over the existing app.

Because the signing key changed, uninstall the old app on your phone before installing a newly built APK.
