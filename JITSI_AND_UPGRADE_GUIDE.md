# Group Calls with Jitsi + Upstream Upgrade Impact

Internal guide for our self-hosted Mattermost fork (`goviind04/mattermost`, based on upstream v11.6, Team Edition / no license).

---

## Part 1 — Group calls (huddles) with Jitsi

### 1.1 Is it free and does it work with our current code?

| Question | Answer |
|---|---|
| Is the Jitsi plugin free? | **Yes.** `mattermost-plugin-jitsi`, Apache-2.0 license, no Mattermost license needed. |
| Is Jitsi Meet (the video server) free? | **Yes.** Open source (Apache-2.0), self-hostable. |
| Does it work on our current fork? | **Yes.** Plugin v2.1.0 needs server ≥ 5.2.0; we are on 11.6. **No code changes needed** in our repo. |
| Does it work in channels (group calls)? | **Yes.** Unlike the built-in Calls plugin (DM-only without a license), Jitsi works in any channel. |
| Can we keep using built-in Calls too? | Yes. Built-in Calls stays usable for 1:1 DM calls. Jitsi covers group calls. |

### 1.2 How it works

```
User clicks "Start Jitsi meeting" (or types /jitsi) in a channel
   → plugin posts a meeting card in the channel with a "Join" link
   → everyone clicks Join → opens video call on OUR Jitsi server
      (in a new tab, or embedded floating window — experimental)
```

Mattermost does not carry the audio/video — the Jitsi server does. Mattermost only creates and shares the meeting link.

### 1.3 Which Jitsi server to use

| Option | Use it? | Why |
|---|---|---|
| Public `https://meet.jit.si` (plugin default) | **No, not for the org** | Calls go through a third party; meet.jit.si requires sign-in for moderators and limits embedding to short demos. Anyone with the link can join. |
| **Self-hosted Jitsi on our server/subdomain** | **Yes (recommended)** | Our data stays on our infra, no time limits, can lock to Mattermost users via JWT. |

If we already run a Jitsi server, skip to **1.5** and just point the plugin at it.

### 1.4 Set up a self-hosted Jitsi server (Docker)

**Server sizing for ~200 users** (not all in calls at once): 4 vCPU, 8 GB RAM, good upload bandwidth. Video bandwidth is the real limit — scale the bridge (JVB) if many large calls run at the same time. Can be the same machine as Mattermost for a start, but a separate VM is better.

**DNS:** create `meet.<ourdomain>` → server public IP.

**Firewall:** open `80/tcp`, `443/tcp`, **`10000/udp`** (media — calls fail without it).

**Install** (official `docker-jitsi-meet`; download the latest stable release from https://github.com/jitsi/docker-jitsi-meet/releases):

```bash
# on the Jitsi server, in a fresh directory
# unpack the latest stable docker-jitsi-meet release, then:
cp env.example .env
./gen-passwords.sh
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
```

Edit `.env`:

```ini
PUBLIC_URL=https://meet.<ourdomain>
HTTP_PORT=80
HTTPS_PORT=443

# Let's Encrypt TLS
ENABLE_LETSENCRYPT=1
LETSENCRYPT_DOMAIN=meet.<ourdomain>
LETSENCRYPT_EMAIL=<admin email>

# If the server is behind NAT, set the public IP
JVB_ADVERTISE_IPS=<server public IP>

# --- Lock meetings to Mattermost users (recommended) ---
ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_APP_ID=mattermost
JWT_APP_SECRET=<long random secret — same value goes in the plugin>
ENABLE_GUESTS=0
```

Start:

```bash
docker compose up -d
```

Test by opening `https://meet.<ourdomain>` — with JWT on, it should refuse to create a room without a token (that is correct).

### 1.5 Install and configure the plugin in Mattermost

1. Download `jitsi-2.1.0.tar.gz` from https://github.com/mattermost-community/mattermost-plugin-jitsi/releases
2. Make sure plugin uploads are allowed — in `config.json`:
   ```json
   "PluginSettings": { "Enable": true, "EnableUploads": true }
   ```
   (restart Mattermost after changing). Alternatively upload with `mmctl plugin add jitsi-2.1.0.tar.gz`.
3. **System Console → Plugins → Plugin Management** → upload the `.tar.gz` → **Enable**.
4. **System Console → Plugins → Jitsi**:

| Setting | Value |
|---|---|
| Jitsi Server URL | `https://meet.<ourdomain>` |
| Use JWT authentication | **true** |
| App ID | `mattermost` (same as `JWT_APP_ID`) |
| App Secret | same as `JWT_APP_SECRET` |
| Meeting link valid time | `30` minutes (default; raise if people join late) |
| Embed Jitsi in Mattermost | false to start (experimental); users can change via `/jitsi settings` |
| Meeting naming scheme | `words` (default) is fine |
| Compatibility mode | **leave false** (marked insecure) |

5. Test: in any channel click the Jitsi icon in the channel header or type `/jitsi`, then join from two different accounts.

### 1.6 Notes / limits

- **Desktop app:** joining opens the browser or the embedded window; screen sharing works in both.
- **Mobile:** links open in the Jitsi Meet mobile app (users install it once).
- **Recording** is not included by default — it needs the separate Jibri component (extra server resources). Skip unless required.
- **Backups:** Jitsi stores no chat/call history; only back up the `.env` and `~/.jitsi-meet-cfg`.
- **Plugin settings** are stored in the Mattermost config, so they survive Mattermost upgrades.

---

## Part 2 — What happens if we take the new upstream changes?

Short answer: **our data and config are kept; our code changes are kept but must be merged and re-tested; the database is upgraded one-way.**

### 2.1 What stays and what changes

| Item | Where it lives | Effect of upgrading to upstream v12 |
|---|---|---|
| **Our code changes** (branding, logo, login screen, notifications, loading screen, etc.) | Git commits on our fork | **Kept** in git history, but merging upstream will cause **conflicts**, mostly in `webapp/` — upstream moved to React 19 and replaced many UI components (Compass UI). Some of our UI edits will need to be re-done on the new components. |
| **Messages, users, channels, teams** | PostgreSQL database | **Kept.** On first start, the new server runs DB migrations automatically (we are at migration 158; v12 adds many more). |
| **Uploaded files, images, avatars** | `data/` directory (or S3) | **Kept.** Not touched by upgrade. |
| **`config.json`** (SiteURL, DB password, SMTP, plugin settings) | Server only — it is gitignored | **Kept.** `git pull` / `git reset --hard` do not touch ignored files. New settings get defaults; settings removed in v12 are dropped. Upstream specifically added "keep previously valid configurations starting on v12". |
| **Installed plugins** (Jitsi, Calls, …) | `plugins/` dir + DB | **Kept.** Bundled plugins (Calls, Playbooks, Boards, Agents) get newer versions. |
| **PostgreSQL version** | Server | **Must be 15 or newer** for v12. Check with `psql --version`; upgrade Postgres *before* upgrading Mattermost if older. |

### 2.2 Risks to know

1. **Database upgrade is one-way.** After v12 migrates the DB, we cannot just go back to the old binary. The only rollback is restoring a backup → **always back up first.**
2. **UI conflicts.** Expect to spend most of the upgrade effort re-applying branding in `webapp/`.
3. **Users at the limit.** Free edition warns at **200** active users and **blocks new accounts at 250** — this is the same in v12. We are ~200 now, so **deactivate leavers** (deactivated users don't count) and plan for growth.
4. **Do not install an "Entry" license** — it caps visible history at 10,000 messages. Stay unlicensed (Team Edition) to keep full history.

### 2.3 Safe upgrade procedure

**Never upgrade production directly. Test on a copy first.**

1. **Pick a release tag**, not upstream `master` (e.g. the latest `v12.x` release).
2. **Code — on a new branch**, merge or rebase our commits onto that tag; fix conflicts; build (`make build-linux` in `server/`, `npm run build` in `webapp/`).
3. **Backup production:**
   ```bash
   sudo systemctl stop mattermost
   pg_dump -Fc -U mmuser mattermost > mm-$(date +%F).dump
   tar czf mm-data-$(date +%F).tgz /path/to/mattermost/data
   cp /path/to/mattermost/config/config.json config-$(date +%F).json
   ```
4. **Test copy:** restore the dump + data on a staging server, run the new build against it, check login, messages, files, branding, Jitsi.
5. **Production:** stop service → backup (step 3) → deploy new build → start → watch logs (migrations run on first start; can take minutes on big DBs).
6. **Rollback if needed:** stop → restore the `pg_dump` + `data/` + `config.json` → start the **old** build.

### 2.4 Recommendation

- **Now:** add Jitsi (Part 1) to the current version — no code change, no risk to data.
- **Before relying on it long-term:** do one planned upgrade to a v12 release using **2.3**, mainly for the security fixes.
- **After that:** keep our changes small and isolated (theme/branding files) so future upgrades stay easy.
