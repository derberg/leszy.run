// The live backend runs natively on the host (it needs the Mac's LAN interfaces
// for the RFID reader), so the compose `backend` service sits behind
// `profiles: [docker]` and is never running. `docker compose exec backend`
// therefore always fails with `service "backend" is not running` — which is how
// the weekly digest and every retention purge failed silently from August to
// October 2026. `run --rm` starts a fresh container from the backend image for
// each job instead. `--no-deps` skips the db dependency (db is a default compose
// service, already running). Requires the backend image to exist:
// docker compose --profile docker build backend.
// backend's WORKDIR in its Dockerfile is /app, scripts live at /app/backend/scripts/.
export function backendArgv(cmd) {
  return ['docker', 'compose', '--profile', 'docker', 'run', '--rm', '--no-deps', '-T', '--workdir', '/app/backend', 'backend', ...cmd];
}
