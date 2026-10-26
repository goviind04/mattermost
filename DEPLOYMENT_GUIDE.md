# BrainerHub Chat — Production Deployment Guide (v12.0.1)

How to launch our synced fork (branch `sync-v12.0.1`) properly on our VPS, with calls.

Placeholders: `chat.<domain>` = chat site, `meet.<domain>` = Jitsi, `<VPS-IP>` = server public IP.

---

## 0. The big picture

### Today (what runs now)
```
GitHub push → runner on VPS → git reset in runner folder → systemctl restart mattermost
mattermost = "go run" (dev mode) + dev Docker Postgres 14 (default password, port 5435)
```
Works, but it is a development setup: slow starts, needs Go on the server, weak DB password, DB does not restart on reboot, files live inside the runner folder.

### Target (proper production)
```
                    Internet
                       │
        ┌──────────────┼───────────────────────────┐
        │ 443 (HTTPS)  │ 8443 UDP/TCP (call media) │ 10000 UDP (Jitsi media)
        ▼              ▼                           ▼
   ┌─────────┐   ┌──────────────────────┐    ┌──────────────┐
   │  Nginx  │──▶│ Mattermost v12 binary │    │ Jitsi Meet   │
   │ TLS     │   │ /opt/mattermost       │    │ (Docker)     │
   └─────────┘   │ systemd "mattermost"  │    │ meet.<domain>│
                 │  + Calls plugin (DMs) │    └──────────────┘
                 │  + Jitsi plugin       │
                 └──────────┬────────────┘
                            ▼
                 PostgreSQL 16 (localhost only)
                 /opt/mattermost/data (files)
```

| Piece | What it does |
|---|---|
| **Nginx** | Public front door on 443. Handles HTTPS certificate (Let's Encrypt) and forwards to Mattermost. |
| **Mattermost binary** | The compiled server (`bin/mattermost`) + our built BrainerHub web app (`client/`). No Go/Node needed on the server. |
| **systemd** | Starts Mattermost on boot, restarts it if it crashes. |
| **PostgreSQL 16** | Stores users, messages, channels, settings. Listens only on localhost — not reachable from internet. |
| **/opt/mattermost/data** | Uploaded files, images, avatars, branding. |
| **Calls plugin** | Built-in voice calls + screen share. Free edition: **DMs only**. Media on port 8443. |
| **Jitsi** | Group video calls/huddles in any channel. Separate service, free. Media on UDP 10000. |

### Server sizing (≈200 users)
- Mattermost + Postgres: 2 vCPU / 4 GB RAM / 40 GB disk is enough.
- Jitsi: 4 vCPU / 8 GB and good bandwidth. **Best on a separate VPS**; same VPS works for a start if it has 8 GB+.

---

## 1. Build the release package (on the PC)

```bash
cd ~/Documents/mattermost
git switch sync-v12.0.1

# Web app (our BrainerHub UI)
cd webapp && npm ci && npm run build && cd ..

# Server binary + package
cd server
make build-linux-amd64
make package-linux-amd64
ls -lh dist/mattermost-team-linux-amd64.tar.gz
```
The tarball contains: `bin/mattermost`, `bin/mmctl`, `client/` (our UI), `templates/` (our email branding), `i18n/`, `fonts/`, `prepackaged_plugins/` (incl. Calls), and a default `config/config.json` (we will NOT use that config — we keep ours).

Copy to VPS:
```bash
scp server/dist/mattermost-team-linux-amd64.tar.gz ubuntu@<VPS-IP>:/tmp/
```

---

## 2. Prepare the VPS (one time)

### 2.1 Firewall / AWS Security Group
Open inbound: `22/tcp` (SSH, your IP only), `80/tcp`, `443/tcp`, `8443/udp` + `8443/tcp` (Calls), and on the Jitsi host `10000/udp`.
**Do not** open 5432/5435 (Postgres), 8065 (Mattermost direct), 9000/9002 (MinIO).

### 2.2 PostgreSQL 16 (native, auto-starts on boot)
```bash
sudo apt update && sudo apt install -y postgresql-16 nginx certbot python3-certbot-nginx
sudo -u postgres psql <<'SQL'
CREATE USER mmuser WITH PASSWORD '<STRONG-PASSWORD>';
CREATE DATABASE mattermost OWNER mmuser;
SQL
```
(If `postgresql-16` is not in the Ubuntu repo, add the official PostgreSQL apt repo first.)

### 2.3 Mattermost user and folder
```bash
sudo useradd --system --user-group --home /opt/mattermost mattermost
cd /tmp && tar xzf mattermost-team-linux-amd64.tar.gz
sudo mv mattermost /opt/mattermost
sudo mkdir -p /opt/mattermost/data
```

---

## 3. Move our data in (cutover)

Plan a short maintenance window (~30 min). Tell users.

### 3.1 Fresh backup right before cutover
Run the same backup as before (Amazon Q prompt) → `/home/ubuntu/mm-backup-<date>/` with `db.dump`, `config.json`, `files.tgz`. Copy it to the PC too.

### 3.2 Stop the old setup (do NOT delete it — it is our rollback)
```bash
sudo systemctl stop mattermost
sudo systemctl disable mattermost
sudo cp /etc/systemd/system/mattermost.service /etc/systemd/system/mattermost-old.service.bak
```
Also **disable the old GitHub deploy workflow** (Actions → "Deploy Mattermost Server" → Disable), so a push cannot restart the old setup.

### 3.3 Restore database into PostgreSQL 16
```bash
B=/home/ubuntu/mm-backup-<date>
sudo -u postgres pg_restore --no-owner --role=mmuser -d mattermost "$B/db.dump"
sudo -u postgres psql -d mattermost -Atc "select count(*) from users; select count(*) from posts;"
```
Counts must match the backup report.

### 3.4 Restore files and plugins
```bash
sudo mkdir -p /tmp/mmrestore && sudo tar xzf "$B/files.tgz" -C /tmp/mmrestore
sudo rsync -a /tmp/mmrestore/data/ /opt/mattermost/data/
sudo rsync -a /tmp/mmrestore/plugins/ /opt/mattermost/plugins/
sudo rsync -a /tmp/mmrestore/client/plugins/ /opt/mattermost/client/plugins/
```

### 3.5 Config: our old config, updated for production
```bash
sudo cp "$B/config.json" /opt/mattermost/config/config.json
```
Edit `/opt/mattermost/config/config.json`:

| Setting | Value |
|---|---|
| `ServiceSettings.SiteURL` | `https://chat.<domain>` |
| `ServiceSettings.ListenAddress` | `127.0.0.1:8065` (only Nginx can reach it) |
| `SqlSettings.DataSource` | `postgres://mmuser:<STRONG-PASSWORD>@localhost:5432/mattermost?sslmode=disable&connect_timeout=10&binary_parameters=yes` |
| `FileSettings.Directory` | `/opt/mattermost/data/` |
| `PluginSettings.Directory` | `./plugins` |
| `PluginSettings.ClientDirectory` | `./client/plugins` |
| `LogSettings.FileLocation` | `` (empty = `/opt/mattermost/logs`) |
| `TeamSettings.EnableOpenServer` | `false` (invite-only) |

```bash
sudo chown -R mattermost:mattermost /opt/mattermost
sudo chmod 600 /opt/mattermost/config/config.json
```

### 3.6 systemd service
`/etc/systemd/system/mattermost.service`:
```ini
[Unit]
Description=BrainerHub Chat (Mattermost)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=notify
User=mattermost
Group=mattermost
WorkingDirectory=/opt/mattermost
ExecStart=/opt/mattermost/bin/mattermost
TimeoutStartSec=3600
KillMode=mixed
Restart=always
RestartSec=10
LimitNOFILE=49152

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mattermost
sudo journalctl -u mattermost -f      # first start runs v12 DB migrations; wait for "Server is listening"
curl -s http://127.0.0.1:8065/api/v4/system/ping
```

### 3.7 Nginx + HTTPS
DNS: `chat.<domain>` A-record → `<VPS-IP>`.

`/etc/nginx/sites-available/mattermost`:
```nginx
upstream mattermost_backend {
    server 127.0.0.1:8065;
    keepalive 32;
}

server {
    listen 80;
    server_name chat.<domain>;

    location ~ /api/v[0-9]+/(users/)?websocket$ {
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        client_max_body_size 100M;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffers 256 16k;
        proxy_buffer_size 16k;
        proxy_read_timeout 90s;
        proxy_http_version 1.1;
        proxy_pass http://mattermost_backend;
    }

    location / {
        client_max_body_size 100M;
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffers 256 16k;
        proxy_buffer_size 16k;
        proxy_read_timeout 600s;
        proxy_http_version 1.1;
        proxy_pass http://mattermost_backend;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/mattermost /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.<domain>     # adds HTTPS + auto-renew
```
Open `https://chat.<domain>`, log in with a real account, check messages, files, branding.

---

## 4. Calls

### 4.1 Built-in Calls (1:1 voice + screen share in DMs)
System Console → Plugins → **Calls**:

| Setting | Value |
|---|---|
| Enable Plugin | true |
| RTC Server Port (UDP) / (TCP) | `8443` |
| ICE Host Override | `<VPS-IP>` — **required on AWS/any NAT** (server sees a private IP) |
| Test mode | off |

Open 8443 UDP+TCP in firewall/Security Group. Test: two users, a DM, click the phone icon.

### 4.2 Jitsi (group calls / huddles in any channel)
Follow `JITSI_AND_UPGRADE_GUIDE.md` Part 1:
1. Run Jitsi (Docker) on `meet.<domain>` with JWT auth, open UDP 10000.
2. Install the Jitsi plugin (`jitsi-2.1.0.tar.gz`) in System Console → Plugins.
3. Set Jitsi URL `https://meet.<domain>`, JWT on, same App ID/Secret as Jitsi.
4. Test `/jitsi` in a channel with 3 people.

---

## 5. After launch

### 5.1 Daily backup (cron)
`/usr/local/bin/mm-backup.sh`:
```bash
#!/bin/bash
set -e
D=/var/backups/mattermost/$(date +%F)
mkdir -p "$D"
sudo -u postgres pg_dump -Fc mattermost > "$D/db.dump"
cp /opt/mattermost/config/config.json "$D/"
tar czf "$D/data.tgz" -C /opt/mattermost data
find /var/backups/mattermost -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```
`sudo crontab -e` → `30 2 * * * /usr/local/bin/mm-backup.sh`
Also copy backups off the server regularly (to the PC or S3) — a backup on the same disk does not survive a disk failure.

### 5.2 Future updates (our code)
1. Change code on PC → `npm run build` + `make build-linux-amd64 package-linux-amd64`.
2. Backup (5.1) → upload tarball → stop service → replace `/opt/mattermost/bin`, `client`, `templates`, `i18n`, `fonts`, `prepackaged_plugins` (**keep** `config/`, `data/`, `plugins/`, `client/plugins/`) → start service.
3. Later we can automate this with a new GitHub Actions workflow that builds the tarball and does step 2.

### 5.3 Rollback (if launch fails)
```bash
sudo systemctl stop mattermost && sudo systemctl disable mattermost
sudo cp /etc/systemd/system/mattermost-old.service.bak /etc/systemd/system/mattermost.service
sudo systemctl daemon-reload && sudo systemctl enable --now mattermost
```
The old code folder and old Postgres 14 data were never touched, so the old site comes back as it was. Messages written on the new site after cutover would be lost in a rollback — decide quickly.

---

## 6. Launch checklist
- [ ] Fresh backup taken and copied to PC
- [ ] Old deploy workflow disabled
- [ ] Postgres 16 restored, counts match
- [ ] `https://chat.<domain>` loads with BrainerHub branding, real login works
- [ ] Old messages, files, avatars visible
- [ ] Email notifications work (SMTP set in System Console → Environment → SMTP)
- [ ] DM call works (Calls), group call works (Jitsi)
- [ ] Desktop app + mobile app connect to `https://chat.<domain>`
- [ ] Daily backup cron running
- [ ] Ports 5432/5435/8065/9000 NOT reachable from internet
