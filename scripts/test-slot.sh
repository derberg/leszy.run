#!/usr/bin/env bash
# Runs a `supabase` command against one test slot: an independent local Supabase
# stack, so several worktrees or agents can run tests/registration at once.
#
#   scripts/test-slot.sh <n> start              start the slot's stack (start-stack.sh's exclude list)
#   scripts/test-slot.sh <n> db reset           migrations + seed
#   scripts/test-slot.sh <n> functions serve    serves THIS worktree's functions, with the slot's functions.env
#   scripts/test-slot.sh <n> status | stop      any other supabase command is passed through
#
# Slot 0 is the repo's own stack (supabase/config.toml, ports 543xx), exactly
# what plain `supabase …` uses and what CI runs. Slot n >= 1 lives in
# .supabase-slots/<n>/ (gitignored): a config.toml regenerated from
# supabase/config.toml on every call, with project_id "<id>-s<n>" and every port
# moved up by n x 100, plus symlinks to this worktree's migrations, functions and
# seed.sql. Then run the tests with REG_TEST_SLOT=<n> so every helper port
# (email capture 54399+100n, dpay mock 54398+100n, scratch Postgres 55432+100n,
# Vite 5174+100n)
# follows. Slot numbers are machine-wide (Docker container names): two
# worktrees must not take the same slot.
set -euo pipefail

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[ $# -ge 2 ] || usage 1
slot="$1"; shift
[[ "$slot" =~ ^[0-9]$ ]] || { echo "slot must be 0..9, got '$slot'" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
reg="$root/tests/registration"

if [ "$slot" = 0 ]; then
  workdir_args=()
  env_file="$reg/functions.env"
else
  dir="$root/.supabase-slots/$slot"
  mkdir -p "$dir/supabase"
  node "$reg/helpers/slotConfig.js" "$slot" "$root/supabase/config.toml" "$dir/supabase/config.toml"
  for f in migrations functions tests; do
    if [ -e "$root/supabase/$f" ]; then ln -sfn "$root/supabase/$f" "$dir/supabase/$f"; fi
  done
  # The seed writes slot 0's functions URL into the Vault; pg_net inside this slot's database
  # must reach this slot's own functions port, so the slot gets a copy with the port shifted.
  rm -f "$dir/supabase/seed.sql"
  sed "s#host.docker.internal:54321/#host.docker.internal:$((54321 + slot * 100))/#g" "$root/supabase/seed.sql" > "$dir/supabase/seed.sql"
  capture=$((54399 + slot * 100))
  mock=$((54398 + slot * 100))
  api=$((54321 + slot * 100))
  sed -e "s#host.docker.internal:54399#host.docker.internal:$capture#" \
      -e "s#host.docker.internal:54398#host.docker.internal:$mock#g" \
      -e "s#127.0.0.1:54321/#127.0.0.1:$api/#" "$reg/functions.env" > "$dir/functions.env"
  workdir_args=(--workdir "$dir")
  env_file="$dir/functions.env"
fi

cd "$root"
case "$1" in
  start)
    shift
    exec "$reg/start-stack.sh" ${workdir_args[@]+"${workdir_args[@]}"} "$@"
    ;;
  functions)
    if [ "${2:-}" = serve ] && [[ " $* " != *" --env-file"* ]]; then
      shift 2
      exec supabase functions serve ${workdir_args[@]+"${workdir_args[@]}"} --env-file "$env_file" "$@"
    fi
    ;;
esac
exec supabase ${workdir_args[@]+"${workdir_args[@]}"} "$@"
