#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf 'backup failed: %s\n' "$1" >&2
  exit 1
}

: "${BACKUP_DIR:?Set BACKUP_DIR in the host configuration}"
: "${COMPOSE_FILE:?Set COMPOSE_FILE in the host configuration}"
: "${COMPOSE_PROJECT_DIR:?Set COMPOSE_PROJECT_DIR in the host configuration}"
: "${COMPOSE_PROJECT_NAME:?Set COMPOSE_PROJECT_NAME in the host configuration}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
[[ "$retention_days" =~ ^[1-9][0-9]*$ ]] || fail 'BACKUP_RETENTION_DAYS must be a positive integer'

command -v docker >/dev/null || fail 'docker is required'
command -v flock >/dev/null || fail 'flock is required'
command -v find >/dev/null || fail 'find is required'
[[ "$COMPOSE_PROJECT_DIR" == /* && -d "$COMPOSE_PROJECT_DIR" ]] || fail 'COMPOSE_PROJECT_DIR must be an existing absolute directory'
[[ "$COMPOSE_FILE" == /* && -f "$COMPOSE_FILE" ]] || fail 'COMPOSE_FILE must be an existing absolute file'
[[ "$BACKUP_DIR" == /* && "$BACKUP_DIR" != / ]] || fail 'BACKUP_DIR must be an absolute directory other than /'

project_dir="$(realpath -e -- "$COMPOSE_PROJECT_DIR")"
compose_file="$(realpath -e -- "$COMPOSE_FILE")"
compose_files=(--file "$compose_file")
if [[ -n "${COMPOSE_OVERRIDE_FILE:-}" ]]; then
  [[ "$COMPOSE_OVERRIDE_FILE" == /* && -f "$COMPOSE_OVERRIDE_FILE" ]] || fail 'COMPOSE_OVERRIDE_FILE must be an existing absolute file'
  compose_files+=(--file "$(realpath -e -- "$COMPOSE_OVERRIDE_FILE")")
fi
mkdir -p -- "$BACKUP_DIR"
backup_dir="$(realpath -e -- "$BACKUP_DIR")"
[[ "$backup_dir" != / ]] || fail 'BACKUP_DIR cannot resolve to /'
case "$backup_dir/" in
  "$project_dir/"*) fail 'BACKUP_DIR must be outside the Compose project directory' ;;
esac
case "$project_dir/" in
  "$backup_dir/"*) fail 'BACKUP_DIR cannot contain the Compose project directory' ;;
esac
chmod 700 -- "$backup_dir"

lock_file="$backup_dir/.rd-insights-backup.lock"
exec {lock_fd}>"$lock_file"
chmod 600 -- "$lock_file"
flock -n "$lock_fd" || fail 'another backup is already running'

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_file="$backup_dir/rd-insights-$timestamp.dump"
temporary_file="$(mktemp "$backup_dir/.rd-insights-XXXXXXXX.dump")"
cleanup() {
  local status=$?
  [[ ! -e "$temporary_file" ]] || rm -f -- "$temporary_file" || true
  if ((status != 0)); then
    printf 'backup failed: exit_status=%s\n' "$status" >&2
  fi
  return "$status"
}
trap cleanup EXIT

docker compose --project-directory "$project_dir" --project-name "$COMPOSE_PROJECT_NAME" \
  "${compose_files[@]}" exec --no-TTY postgres sh -eu -c \
  'pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "$temporary_file"
[[ -s "$temporary_file" ]] || fail 'pg_dump produced an empty file'
[[ ! -e "$final_file" ]] || fail 'backup filename already exists; refusing to overwrite it'
mv --no-clobber -- "$temporary_file" "$final_file"
[[ ! -e "$temporary_file" ]] || fail 'could not publish backup file atomically'
chmod 600 -- "$final_file"

find "$backup_dir" -mindepth 1 -maxdepth 1 -type f -name 'rd-insights-*.dump' \
  -mmin "+$((retention_days * 1440))" -delete
bytes="$(stat -c '%s' -- "$final_file")"
printf 'backup succeeded: file=%s bytes=%s completed_at=%s\n' \
  "$(basename -- "$final_file")" "$bytes" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
