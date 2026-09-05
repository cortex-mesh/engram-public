#!/bin/bash
set -euxo pipefail

echo "Bootstrapping shared Cortex app host"

if command -v dnf >/dev/null 2>&1; then
  sudo dnf update -y || true
  sudo dnf install -y docker
  sudo systemctl enable --now docker
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker installation not completed by bootstrap script" >&2
fi

echo "Host bootstrap complete"
