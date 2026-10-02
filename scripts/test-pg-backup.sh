#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_script="$root/scripts/backup-postgres.sh"
project="rd-backup-test-$(date +%s)-$$"
work="$(mktemp -d "/tmp/$project.XXXXXXXX")"
backup_dir="$work/backups"
restore_container="$project-restore"
compose_override="$work/docker-compose.network.yml"
export BACKUP_DIR="$backup_dir"
export BACKUP_RETENTION_DAYS=7
export COMPOSE_FILE="$root/docker-compose.yml"
export COMPOSE_OVERRIDE_FILE="$compose_override"
export COMPOSE_PROJECT_DIR="$root"
export COMPOSE_PROJECT_NAME="$project"
export POSTGRES_PORT="$((23000 + $$ % 1000))"

compose() {
  docker compose --project-directory "$COMPOSE_PROJECT_DIR" --project-name "$COMPOSE_PROJECT_NAME" \
    --file "$COMPOSE_FILE" --file "$COMPOSE_OVERRIDE_FILE" "$@"
}

cleanup() {
  docker rm --force "$restore_container" >/dev/null 2>&1 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

python3 - "$compose_override" <<'PY'
import ipaddress
import json
import subprocess
import sys

networks = subprocess.run(
    ["docker", "network", "ls", "-q"], check=True, text=True, capture_output=True
).stdout.split()
existing = []
if networks:
    inspected = subprocess.run(
        ["docker", "network", "inspect", *networks],
        check=True, text=True, capture_output=True,
    )
    for network in json.loads(inspected.stdout):
        for config in (network.get("IPAM", {}).get("Config") or []):
            existing.append(ipaddress.ip_network(config["Subnet"]))
routes = json.loads(subprocess.run(
    ["ip", "-j", "-4", "route", "show"], check=True, text=True, capture_output=True
).stdout)
existing.extend(ipaddress.ip_network(route["dst"]) for route in routes if route.get("dst") != "default")

for candidate in ipaddress.ip_network("10.240.0.0/12").subnets(new_prefix=24):
    if not any(candidate.overlaps(network) for network in existing):
        with open(sys.argv[1], "w", encoding="utf-8") as overlay:
            overlay.write(f"networks:\n  default:\n    ipam:\n      config:\n        - subnet: {candidate}\n")
        print(f"backup test network: subnet={candidate}")
        break
else:
    raise SystemExit("no collision-free /24 available in 10.240.0.0/12")
PY

[[ -x "$backup_script" ]] || { echo "backup script missing or not executable" >&2; exit 1; }
mkdir -m 700 -- "$backup_dir"
compose up -d --wait postgres >/dev/null

compose exec -T postgres sh -eu -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "CREATE TABLE backup_fixture (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO backup_fixture VALUES (1, '\''restore-ok'\'');"' >/dev/null
"$backup_script"
dump="$(find "$backup_dir" -maxdepth 1 -type f -name 'rd-insights-*.dump' -print -quit)"
[[ -s "$dump" ]]
[[ "$(stat -c '%a' "$dump")" == 600 ]]
[[ "$(stat -c '%a' "$backup_dir")" == 700 ]]
[[ "$(stat -c '%a' "$backup_dir/.rd-insights-backup.lock")" == 600 ]]

docker run --detach --rm --name "$restore_container" --network "${project}_default" \
  --env POSTGRES_USER=restore --env POSTGRES_PASSWORD=restore --env POSTGRES_DB=restore postgres:16-alpine >/dev/null
attempt=0
until docker exec "$restore_container" pg_isready -U restore -d restore >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  ((attempt < 30)) || { echo "restore database did not become ready" >&2; exit 1; }
  sleep 1
done
docker cp "$dump" "$restore_container:/tmp/restore.dump" >/dev/null
docker exec "$restore_container" pg_restore --no-owner --no-privileges -U restore -d restore /tmp/restore.dump
restored="$(docker exec "$restore_container" psql -U restore -d restore -Atc 'SELECT value FROM backup_fixture WHERE id = 1')"
[[ "$restored" == restore-ok ]]

recent="$backup_dir/rd-insights-recent.dump"
old="$backup_dir/rd-insights-old.dump"
unrelated="$backup_dir/notes.txt"
outside="$work/outside.txt"
printf 'recent\n' > "$recent"
printf 'old\n' > "$old"
printf 'unrelated\n' > "$unrelated"
printf 'outside\n' > "$outside"
touch -d '2 days ago' "$recent"
touch -d '30 days ago' "$old"
"$backup_script"
[[ -f "$recent" && ! -e "$old" && -f "$unrelated" && -f "$outside" ]]

before="$(sha256sum "$dump" | cut -d ' ' -f 1)"
mkdir -m 700 -- "$work/fake-bin"
cat > "$work/fake-bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'partial dump'
exit 1
SH
chmod 700 "$work/fake-bin/docker"
if PATH="$work/fake-bin:$PATH" "$backup_script" >/dev/null 2>&1; then
  echo "expected pg_dump failure" >&2
  exit 1
fi
after="$(sha256sum "$dump" | cut -d ' ' -f 1)"
[[ "$before" == "$after" ]]
[[ -z "$(find "$backup_dir" -maxdepth 1 -type f -name '.rd-insights-*.dump' -print -quit)" ]]

flock -n "$backup_dir/.rd-insights-backup.lock" sleep 2 &
locker=$!
sleep 0.2
if "$backup_script" >/dev/null 2>&1; then
  echo "expected overlapping backup to be rejected" >&2
  exit 1
fi
wait "$locker"

printf 'backup test passed: dump, restore, retention, failure preservation, lock, and destination scope\n'
