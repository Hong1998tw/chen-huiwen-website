#!/usr/bin/env bash
set -euo pipefail

# GitHub's Ubuntu 24.04 image can route apt through a regional Azure mirror
# that stalls on package indexes. Use Ubuntu's official archive over HTTPS;
# apt's configured archive keyring and signature checks remain unchanged.
apt_sources=/etc/apt/sources.list.d/ubuntu.sources
if [[ -f "$apt_sources" ]]; then
  sudo sed -i \
    -e 's#http://azure.archive.ubuntu.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' \
    -e 's#https://azure.archive.ubuntu.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' \
    "$apt_sources"
fi

sudo tee /etc/apt/apt.conf.d/99-huiwen-playwright-network >/dev/null <<'APT_CONFIG'
Acquire::Retries "2";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT_CONFIG

apt_lock_held() {
  local lock
  for lock in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock; do
    if sudo fuser -s "$lock" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

wait_for_apt_idle() {
  local deadline=$((SECONDS + 90))
  while apt_lock_held; do
    if (( SECONDS >= deadline )); then
      echo "Another apt/dpkg process still holds its package-manager lock after 90 seconds." >&2
      return 1
    fi
    sleep 3
  done
}

for attempt in 1 2; do
  if wait_for_apt_idle && timeout --kill-after=15s 180s npx --prefix tests/donation playwright install --with-deps chromium; then
    exit 0
  else
    status=$?
  fi
  if [[ "$attempt" -lt 2 ]]; then
    echo "Playwright browser/dependency installation attempt $attempt ended with status $status; retrying once."
    sleep 5
  fi
done

echo "Playwright browser/dependency installation failed after two bounded attempts." >&2
exit 1
