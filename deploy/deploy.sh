#!/usr/bin/env bash
# Build the images, push them to Artifact Registry and restart the stack on the VM.
#   deploy/deploy.sh             deploy the current commit
#   deploy/deploy.sh --provision also run first-time server setup
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-restaurant-pos-rg}
REGION=${REGION:-asia-south1}
ZONE=${ZONE:-asia-south1-a}
VM=${VM:-pos}
REPO="$REGION-docker.pkg.dev/$PROJECT/pos"
BUCKET="$PROJECT-backups"
TAG=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)

ssh_vm() { gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --quiet --command "$1"; }

if [[ ${1:-} == --provision ]]; then
  gcloud compute scp deploy/provision.sh "$VM:/tmp/provision.sh" --project "$PROJECT" --zone "$ZONE" --quiet
  ssh_vm "sudo bash /tmp/provision.sh $REGION $BUCKET"
fi

gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null
for target in backend web; do
  docker build -f deploy/Dockerfile --target "$target" -t "$REPO/$target:$TAG" -t "$REPO/$target:latest" .
  docker push --quiet "$REPO/$target:$TAG"
  docker push --quiet "$REPO/$target:latest"
done

IP=$(gcloud compute instances describe "$VM" --project "$PROJECT" --zone "$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
HOST=${SITE_HOST:-$(echo "$IP" | tr . -).sslip.io}

gcloud compute scp deploy/compose.yml backend/certs/qz-certificate.pem backend/certs/qz-private-key.pem \
  "$VM:/tmp/" --project "$PROJECT" --zone "$ZONE" --quiet

ssh_vm "set -e
sudo install -m 644 /tmp/compose.yml /opt/pos/compose.yml
sudo install -m 600 /tmp/qz-certificate.pem /tmp/qz-private-key.pem /opt/pos/certs/
rm -f /tmp/compose.yml /tmp/qz-*.pem
if ! sudo test -f /opt/pos/.env; then
  sudo tee /opt/pos/.env >/dev/null <<EOF
DEBUG=False
SECRET_KEY=\$(openssl rand -base64 48 | tr -d '\n/+=')
POSTGRES_PASSWORD=\$(openssl rand -hex 24)
BEHIND_HTTPS_PROXY=True
TIME_ZONE=Asia/Kolkata
EOF
  sudo chmod 600 /opt/pos/.env
fi
sudo sed -i '/^\(SITE_ADDRESS\|ALLOWED_HOSTS\|CORS_ALLOWED_ORIGINS\|IMAGE_REPO\|IMAGE_TAG\)=/d' /opt/pos/.env
printf 'SITE_ADDRESS=%s\nALLOWED_HOSTS=%s\nCORS_ALLOWED_ORIGINS=https://%s\nIMAGE_REPO=%s\nIMAGE_TAG=%s\n' \
  $HOST $HOST $HOST $REPO $TAG | sudo tee -a /opt/pos/.env >/dev/null
cd /opt/pos && sudo docker compose pull -q && sudo docker compose up -d --remove-orphans
sudo docker image prune -f >/dev/null"

echo "Deployed $TAG -> https://$HOST"
