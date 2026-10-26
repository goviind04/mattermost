# Self-Hosting BrainerHub Chat on Our Own Machine

Turn one of our Linux machines (32 GB RAM) into a **dedicated server** that runs everything:
Mattermost v12 (our fork), PostgreSQL, file storage, built-in Calls, and Jitsi for group calls — reachable on our own domain.

Placeholders: `<domain>` = our domain, `chat.<domain>` = chat, `meet.<domain>` = Jitsi, `<PUBLIC-IP>` = our internet IP, `<LAN-IP>` = the machine's IP inside the office network (e.g. `192.168.1.50`).

Related docs: `DEPLOYMENT_GUIDE.md` (VPS version of the same install), `JITSI_AND_UPGRADE_GUIDE.md` (Jitsi details).

---

## 1. What this looks like

```
                         Internet
                            │
                     ┌──────┴──────┐
                     │   Router    │  port forwarding:
                     │ <PUBLIC-IP> │  80, 443 TCP · 8443 UDP+TCP · 10000 UDP
                     └──────┬──────┘
                            │ office LAN
              ┌─────────────┴──────────────────────────────┐
              │  Server machine  <LAN-IP>  (Ubuntu 24.04)   │
              │                                             │
              │  Nginx :443  ── chat.<domain> ──▶ Mattermost :8065 (systemd)
              │       │                              ├─ PostgreSQL 16 (localhost)
              │       │                              ├─ /srv/mattermost/data (files)
              │       │                              └─ Calls plugin :8443 (DM calls)
              │       └────── meet.<domain> ──▶ Jitsi web :8000 (Docker)
              │                                       └─ JVB :10000/udp (video)
              └─────────────────────────────────────────────┘
```

One machine, one Nginx in front, two websites (`chat` and `meet`), all HTTPS via Let's Encrypt.

---

## 2. Before you start — requirements checklist

| Need | Why | Check |
|---|---|---|
| **Reachable public IP** (no CGNAT) | Internet users must reach the machine | See 2.1 |
| **Static public IP** (preferred) or Dynamic DNS | Domain must always point to us | Ask ISP |
| **Router admin access** | Port forwarding | — |
| **ISP allows inbound 80/443** | Some home ISPs block them | Ask ISP / test |
| **Upload bandwidth** | Group video sends a stream to every participant. 10-person Jitsi call ≈ 20–30 Mbps upload. Chat + voice calls need little. | speedtest |
| **Wired Ethernet** | Wi-Fi drops = outages | — |
| **UPS** (battery) | Power cut = DB corruption risk + downtime | — |
| **Dedicated machine** | Don't share with dev work/other Docker projects (port clashes, accidental restarts) | — |
| **2 disks if possible** | Disk 1: system + app, Disk 2: backups | — |

32 GB RAM is plenty: Mattermost ~2–4 GB, PostgreSQL ~2–4 GB, Jitsi ~4–8 GB under load.

### 2.1 Do we have a real public IP? (CGNAT test)
```bash
curl -4 ifconfig.me          # IP the internet sees
```
Compare with the **WAN IP** on the router's status page.
- **Same** → we have a public IP. Use **Option A** below.
- **Different** (or router WAN IP starts with `100.64–100.127`, `10.`, `192.168.`, `172.16–31.`) → we are behind **CGNAT**; port forwarding will not work. Use **Option B**.

### 2.2 Choose the network path

| Option | When | How |
|---|---|---|
| **A. Port forwarding** (recommended) | Public IP available | Router forwards ports to the server. DNS points to `<PUBLIC-IP>`. |
| **B. VPS relay** | CGNAT, or ISP blocks ports | Keep a small VPS (our current one works). DNS points to the VPS; the VPS forwards traffic through a WireGuard tunnel to our machine. Data stays on our machine. See section 10. |

> Not suitable: Cloudflare Tunnel / ngrok alone — they carry web traffic but **not the UDP audio/video** that Calls and Jitsi need.

---

## 3. Prepare the machine

### 3.1 Install the OS
- **Ubuntu Server 24.04 LTS** (clean install; no desktop needed).
- During install: enable OpenSSH, use the whole disk (LVM), create user e.g. `admin`.

### 3.2 BIOS / power
- **Restore on AC power loss: Power On** (machine boots after a power cut).
- Disable sleep/suspend:
  ```bash
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  ```

### 3.3 Fixed LAN IP
Either set a **DHCP reservation** for the machine's MAC address in the router (easiest), or a static IP in `/etc/netplan/*.yaml`. Port forwarding depends on this IP never changing.

### 3.4 Base security
```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y ufw fail2ban unattended-upgrades curl rsync
sudo dpkg-reconfigure -plow unattended-upgrades       # automatic security updates

# SSH: keys only
#   copy your key first:  ssh-copy-id admin@<LAN-IP>
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# Firewall
sudo ufw default deny incoming
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp   # SSH from LAN only (adjust subnet)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8443/udp
sudo ufw allow 8443/tcp
sudo ufw allow 10000/udp
sudo ufw enable
```
Never expose 22 (SSH), 5432 (Postgres) or 8065 (Mattermost direct) to the internet.

### 3.5 Software
```bash
sudo apt install -y postgresql-16 nginx certbot python3-certbot-nginx
# Docker (for Jitsi only)
curl -fsSL https://get.docker.com | sudo sh
```
(If `postgresql-16` is missing, add the official PostgreSQL apt repository first.)

---

## 4. Router and DNS

### 4.1 Port forwarding (Option A)
Forward from router → `<LAN-IP>`:

| Port | Protocol | For |
|---|---|---|
| 80 | TCP | Let's Encrypt + redirect to HTTPS |
| 443 | TCP | Chat + Jitsi websites |
| 8443 | UDP + TCP | Mattermost Calls audio/screen share |
| 10000 | UDP | Jitsi video |

Also enable **NAT loopback / hairpin NAT** on the router if it has the option, so office users can reach `chat.<domain>` from inside. If the router cannot, add a local DNS override (router DNS or Pi-hole) mapping `chat.<domain>` and `meet.<domain>` → `<LAN-IP>`.

### 4.2 DNS records (at our domain provider)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `chat` | `<PUBLIC-IP>` | 300 |
| A | `meet` | `<PUBLIC-IP>` | 300 |

**Dynamic public IP?** Use Dynamic DNS so the records update automatically:
- Domain on Cloudflare → `ddclient` or a small cron script calling the Cloudflare API every 5 min.
- Other providers → check their DDNS support, or move DNS to Cloudflare (free).
- If using Cloudflare: set these two records to **DNS only (grey cloud)**, not proxied — proxying breaks calls.

Check from outside (mobile data, not office Wi-Fi):
```bash
dig +short chat.<domain>
```

---

## 5. Install Mattermost (our fork)

### 5.1 Build the package (on the dev PC)
```bash
cd ~/Documents/mattermost && git switch sync-v12.0.1
cd webapp && npm ci && npm run build && cd ../server
make build-linux-amd64 && make package-linux-amd64
scp dist/mattermost-team-linux-amd64.tar.gz admin@<LAN-IP>:/tmp/
```

### 5.2 Install on the server
```bash
sudo useradd --system --user-group --home /opt/mattermost mattermost
cd /tmp && tar xzf mattermost-team-linux-amd64.tar.gz
sudo mv mattermost /opt/mattermost
sudo mkdir -p /srv/mattermost/data          # files (put /srv on the bigger disk if you have two)
```

### 5.3 Database
```bash
sudo -u postgres psql <<'SQL'
CREATE USER mmuser WITH PASSWORD '<STRONG-PASSWORD>';
CREATE DATABASE mattermost OWNER mmuser;
SQL
```

### 5.4 Bring our data over from the VPS
1. On the VPS: take a fresh backup (same Amazon Q task as before) → `db.dump`, `config.json`, `files.tgz`.
2. Copy to the new server: `scp -r ubuntu@<VPS-IP>:/home/ubuntu/mm-backup-<date> /tmp/`
3. Restore:
```bash
B=/tmp/mm-backup-<date>
sudo -u postgres pg_restore --no-owner --role=mmuser -d mattermost "$B/db.dump"
sudo -u postgres psql -d mattermost -Atc "select count(*) from users; select count(*) from posts;"   # must match backup

sudo mkdir -p /tmp/mmrestore && sudo tar xzf "$B/files.tgz" -C /tmp/mmrestore
sudo rsync -a /tmp/mmrestore/data/ /srv/mattermost/data/
sudo rsync -a /tmp/mmrestore/plugins/ /opt/mattermost/plugins/
sudo rsync -a /tmp/mmrestore/client/plugins/ /opt/mattermost/client/plugins/
sudo cp "$B/config.json" /opt/mattermost/config/config.json
```

### 5.5 Config changes (`/opt/mattermost/config/config.json`)

| Setting | Value |
|---|---|
| `ServiceSettings.SiteURL` | `https://chat.<domain>` |
| `ServiceSettings.ListenAddress` | `127.0.0.1:8065` |
| `SqlSettings.DataSource` | `postgres://mmuser:<STRONG-PASSWORD>@localhost:5432/mattermost?sslmode=disable&connect_timeout=10&binary_parameters=yes` |
| `FileSettings.Directory` | `/srv/mattermost/data/` |
| `PluginSettings.Directory` | `./plugins` |
| `PluginSettings.ClientDirectory` | `./client/plugins` |
| `TeamSettings.EnableOpenServer` | `false` |

```bash
sudo chown -R mattermost:mattermost /opt/mattermost /srv/mattermost
sudo chmod 600 /opt/mattermost/config/config.json
```

### 5.6 systemd service — `/etc/systemd/system/mattermost.service`
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
sudo systemctl daemon-reload && sudo systemctl enable --now mattermost
sudo journalctl -u mattermost -f            # wait for "Server is listening"
```

---

## 6. Jitsi on the same machine

Jitsi runs in Docker **behind our Nginx** (Nginx owns port 443 for both sites).

```bash
sudo mkdir -p /opt/jitsi && cd /opt/jitsi
# download latest stable release of docker-jitsi-meet from
# https://github.com/jitsi/docker-jitsi-meet/releases and unpack here
cp env.example .env && ./gen-passwords.sh
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
```

`.env` (key lines):
```ini
PUBLIC_URL=https://meet.<domain>
HTTP_PORT=127.0.0.1:8000        # only Nginx reaches it
HTTPS_PORT=127.0.0.1:8001
DISABLE_HTTPS=1                 # Nginx does TLS
ENABLE_HTTP_REDIRECT=0
ENABLE_LETSENCRYPT=0
JVB_ADVERTISE_IPS=<PUBLIC-IP>,<LAN-IP>    # public for internet users, LAN for office users

ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_APP_ID=mattermost
JWT_APP_SECRET=<LONG-RANDOM-SECRET>
ENABLE_GUESTS=0
```
```bash
sudo docker compose up -d
```
If `HTTP_PORT` does not accept an IP in your release, use `HTTP_PORT=8000` and rely on ufw (port 8000 is not opened).

---

## 7. Nginx for both sites + HTTPS

`/etc/nginx/sites-available/brainerhub`:
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

upstream mattermost_backend { server 127.0.0.1:8065; keepalive 32; }

# ---------- chat.<domain> ----------
server {
    listen 80;
    server_name chat.<domain>;

    location ~ /api/v[0-9]+/(users/)?websocket$ {
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
        proxy_read_timeout 90s;
        proxy_http_version 1.1;
        proxy_pass http://mattermost_backend;
    }

    location / {
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100M;
        proxy_read_timeout 600s;
        proxy_http_version 1.1;
        proxy_pass http://mattermost_backend;
    }
}

# ---------- meet.<domain> ----------
server {
    listen 80;
    server_name meet.<domain>;

    location / {
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;          # for /xmpp-websocket and /colibri-ws
        proxy_set_header Connection $connection_upgrade;
        proxy_http_version 1.1;
        proxy_read_timeout 900s;
        proxy_pass http://127.0.0.1:8000;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/brainerhub /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.<domain> -d meet.<domain>     # HTTPS + auto-renew
```

---

## 8. Calls setup

### 8.1 Built-in Calls (1:1 DM voice + screen share)
System Console → Plugins → Calls:

| Setting | Value |
|---|---|
| Enable | true |
| RTC Server Port (UDP and TCP) | `8443` |
| ICE Host Override | `<PUBLIC-IP>` (machine only sees its LAN IP) |

Free edition limit: calls work in **direct messages only**.

### 8.2 Jitsi plugin (group calls in channels)
1. Download `jitsi-2.1.0.tar.gz` from https://github.com/mattermost-community/mattermost-plugin-jitsi/releases
2. System Console → Plugins → Plugin Management → upload → Enable.
3. System Console → Plugins → Jitsi: URL `https://meet.<domain>`, JWT **on**, App ID `mattermost`, App Secret = `JWT_APP_SECRET`.
4. Test `/jitsi` in a channel with 3 people — one on office Wi-Fi, one on mobile data.

---

## 9. Backups, monitoring, maintenance

### 9.1 Daily backup — `/usr/local/bin/mm-backup.sh`
```bash
#!/bin/bash
set -e
D=/backup/mattermost/$(date +%F)          # /backup = second disk if available
mkdir -p "$D"
sudo -u postgres pg_dump -Fc mattermost > "$D/db.dump"
cp /opt/mattermost/config/config.json "$D/"
tar czf "$D/data.tgz" -C /srv/mattermost data
find /backup/mattermost -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```
`sudo chmod +x /usr/local/bin/mm-backup.sh` → `sudo crontab -e` → `30 2 * * * /usr/local/bin/mm-backup.sh`

**Off-site copy is mandatory** for a self-hosted machine (fire, theft, disk failure): nightly `rsync` of `/backup/mattermost` to the VPS, cloud storage, or another office machine. Test a restore once a month.

### 9.2 Monitoring
- External uptime check (e.g. UptimeRobot, free) on `https://chat.<domain>/api/v4/system/ping` → email/phone alert when down.
- Disk space: `df -h` weekly, or an alert when > 80%.

### 9.3 Updates
- OS security updates: automatic (unattended-upgrades). Reboot monthly in a quiet hour.
- Our code: build new package on dev PC → backup → stop service → replace `bin/ client/ templates/ i18n/ fonts/ prepackaged_plugins/` in `/opt/mattermost` (keep `config/`, `plugins/`, `client/plugins/`) → start.
- Jitsi: `cd /opt/jitsi && docker compose pull && docker compose up -d` (monthly).

---

## 10. Option B — VPS relay (only if CGNAT / blocked ports)

Our machine connects out to the VPS with WireGuard; the VPS forwards public traffic down the tunnel. All data stays on our machine; the VPS is just a pipe.

```
Internet → VPS <VPS-IP> ──WireGuard tunnel──▶ our server (10.10.0.2)
DNS: chat/meet.<domain> → <VPS-IP>
```

1. Install WireGuard on both (`sudo apt install wireguard`). VPS = `10.10.0.1`, our server = `10.10.0.2`, `PersistentKeepalive = 25` on our server's peer config (keeps the tunnel open through NAT).
2. On the VPS, forward ports to `10.10.0.2`:
```bash
sudo sysctl -w net.ipv4.ip_forward=1
for p in 80 443 8443; do sudo iptables -t nat -A PREROUTING -p tcp --dport $p -j DNAT --to-destination 10.10.0.2:$p; done
for p in 8443 10000; do sudo iptables -t nat -A PREROUTING -p udp --dport $p -j DNAT --to-destination 10.10.0.2:$p; done
sudo iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
sudo apt install -y iptables-persistent      # keep rules after reboot
```
3. Use `<VPS-IP>` everywhere this guide says `<PUBLIC-IP>` (DNS, Calls ICE Host Override, `JVB_ADVERTISE_IPS`).
4. VPS bandwidth must cover video calls (all media passes through it).

---

## 11. Cutover from the VPS

1. **2 days before**: lower DNS TTL for `chat` to 300 s.
2. Set up and test the new server fully with a recent backup (use a temporary name like `chat-new.<domain>` if you want users to test).
3. **Window (≈30 min)**: stop Mattermost on the VPS → fresh backup → restore on new server (5.4) → switch DNS `chat` → `<PUBLIC-IP>` → verify.
4. Keep the VPS untouched for 2 weeks as rollback (switch DNS back + start its service).
5. Disable the old GitHub deploy workflow so pushes don't restart the VPS setup.

---

## 12. Launch checklist
- [ ] CGNAT test passed (or Option B relay working)
- [ ] Machine: UPS, wired, auto power-on, sleep disabled, fixed LAN IP
- [ ] ufw on; only 80/443/8443/10000 reachable from internet (test from mobile data)
- [ ] `https://chat.<domain>` and `https://meet.<domain>` valid HTTPS
- [ ] Real login works; old messages/files/avatars present; BrainerHub branding correct
- [ ] SMTP configured; email notifications arrive
- [ ] DM call works (office ↔ mobile data); Jitsi group call works (office ↔ mobile data)
- [ ] Desktop + mobile apps connect to `https://chat.<domain>`
- [ ] Daily backup runs; off-site copy runs; one test restore done
- [ ] Uptime alert configured
