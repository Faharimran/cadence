#!/usr/bin/env bash
#
# Ships the current commit to Railway, and records which commit that was.
#
# Two things this exists to prevent, both of which have already happened:
#
#   · "is the change live?" answered by reading a deploy status that said
#     SUCCESS while the running code was something else. The health endpoint
#     reports CADENCE_VERSION, and this is what sets it — `railway up` uploads a
#     directory rather than a git ref, so Railway never populates its own
#     commit variable and the endpoint would otherwise say "unknown" forever.
#
#   · deploying a dirty tree. What `railway up` sends is the working directory,
#     not HEAD, so uncommitted edits ship silently and the recorded version is a
#     lie about what is running.
#
# Usage: npm run deploy            (both services)
#        npm run deploy -- web     (one of them)
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. railway up ships the DIRECTORY, not the commit,"
  echo "so this would deploy edits that are not in the version it records:"
  git status --short
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
TARGET="${1:-both}"

deploy_one() {
  local service="$1"
  echo "→ $service @ $SHA"
  railway variables --service "$service" --set "CADENCE_VERSION=$SHA" --skip-deploys > /dev/null
  railway up --service "$service" --detach | tail -1
}

case "$TARGET" in
  web)    deploy_one cadence-web ;;
  worker) deploy_one cadence-worker ;;
  both)   deploy_one cadence-web; deploy_one cadence-worker ;;
  *)      echo "Usage: npm run deploy -- [web|worker]"; exit 1 ;;
esac

echo
echo "Deployed $SHA. Confirm what is actually serving with:"
echo "  curl -s https://cadence-web-production-abe9.up.railway.app/api/health | jq .version"
echo
echo "Expect ~2 minutes of 502 while migrations and RLS run before the server starts."
