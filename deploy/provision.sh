#!/usr/bin/env bash
# One-time server setup, run on the VM as root by deploy.sh: Docker, registry login,
# and an hourly copy of backups to Cloud Storage.
#   provision.sh <region> <backup-bucket>
set -euo pipefail
REGION=$1 BUCKET=$2

if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -yq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
mkdir -p /opt/pos/certs /var/lib/pos/backups

cat > /etc/cron.d/pos-backup-sync <<EOF
17 * * * * root gcloud storage rsync --recursive /var/lib/pos/backups gs://$BUCKET/backups >/var/log/pos-backup-sync.log 2>&1
EOF
