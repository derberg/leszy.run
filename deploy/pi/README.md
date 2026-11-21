# Timing host on a Raspberry Pi (checkpoint1)

Everything the timing host runs comes from this repository, except two things
that are set by hand: `~/leszyrun/.env` (the Supabase keys, never committed) and
the Wi-Fi profiles (`nmcli`). PostgreSQL 17 and Mosquitto are Debian packages.

| File | Installed as |
|---|---|
| `leszyrun-backend.service` | `/etc/systemd/system/leszyrun-backend.service` (Fastify on :3001) |
| `leszyrun-frontend.service` | `/etc/systemd/system/leszyrun-frontend.service` (admin panel on :3000) |
| `serve-frontend.mjs` | run in place by the frontend unit; serves `frontend/dist` |

The camera units live in `vision/systemd/`, the checkpoint agent's unit in
`checkpoint-agent/README.md`.

## Install or reinstall the units

```bash
cd ~/leszyrun
sudo cp deploy/pi/leszyrun-backend.service deploy/pi/leszyrun-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now leszyrun-backend leszyrun-frontend
```

The repository must be at `/home/leszyrun/leszyrun`, the user `leszyrun`.

## Update

```bash
~/leszyrun/scripts/update-pi.sh
```

It pulls main, runs `npm install`, rebuilds the panel and restarts both units.
It does not reinstall the unit files: after a change to one of them, run the
install block above.
