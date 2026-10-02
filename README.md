# AquaSense

Hydration tracker (Indonesian UI). Static frontend in `public/`, plus a small
dependency-free Node backend (`server/`) for optional account sync.

- **Guest mode:** works fully in the browser; data lives in localStorage.
- **Signed in:** the browser pushes its data to the server, which merges it with
  the copies from other devices (union of drinks with delete tombstones,
  newest-wins for per-day urination records, target and reminders).

Requires Node >= 22.5 (uses built-in `node:sqlite`). No `npm install` needed.

## Run

    npm start            # http://127.0.0.1:3000
    npm test             # merge logic tests

Env vars: `PORT` (3000), `HOST` (127.0.0.1), `DATA_DIR` (./data, holds `aquasense.db`),
`COOKIE_SECURE=1` (set behind HTTPS).

## Deploy on Linux (systemd + nginx)

    sudo useradd -r -s /usr/sbin/nologin aquasense
    sudo git clone https://github.com/wmwijaya/AquaSense.git /opt/aquasense
    sudo mkdir -p /var/lib/aquasense && sudo chown aquasense: /var/lib/aquasense
    sudo cp /opt/aquasense/deploy/aquasense.service /etc/systemd/system/
    sudo systemctl enable --now aquasense
    sudo cp /opt/aquasense/deploy/nginx.conf /etc/nginx/sites-available/aquasense   # edit server_name
    sudo ln -s /etc/nginx/sites-available/aquasense /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    sudo certbot --nginx -d your-domain.com

Update: `sudo git -C /opt/aquasense pull && sudo systemctl restart aquasense`
Back up: copy `/var/lib/aquasense/aquasense.db`.

## Privacy notes
Passwords are stored as scrypt hashes; sessions are random tokens (hashed in the DB) in
HttpOnly cookies. Registration is open to anyone. Users can delete their account and
server data from Settings. Because the data is health-adjacent, review applicable privacy
rules before running this for minors or the public.
