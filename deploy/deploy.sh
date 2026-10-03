#!/usr/bin/env bash
# Rolls out commit $1 on the server: the image CI published for it, plus the compose files of that commit
# (deploy-ssh has already checked the repo out at $1). Runs as accs-deploy; one deploy at a time.
set -euo pipefail

sha=$1
root=/opt/accs-manager
repo=$root/repo
export ACCS_IMAGE="ghcr.io/nokimaro/accs-manager:$sha"

exec 9>"$root/deploy.lock"
flock 9

compose() {
  docker compose --project-directory "$repo" -f "$repo/compose.yml" -f "$repo/compose.prod.yml" --env-file "$root/.env" "$@"
}

echo "deploying $sha"
compose pull --quiet
# migrations run first (accs-migrate), then the api; --wait returns once healthchecks pass
compose up -d --remove-orphans --wait --wait-timeout 180
echo "$sha" > "$root/deployed-sha"

# keep the disk tidy: images of this project that no container uses any more
docker image prune -af --filter 'label=org.opencontainers.image.source=https://github.com/nokimaro/accs-manager' >/dev/null
echo "deployed $sha"
compose ps --format 'table {{.Name}}\t{{.Status}}'
