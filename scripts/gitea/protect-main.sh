#!/usr/bin/env bash
# Protect `main` on Gitea so CI must pass before the dev -> main PR can merge.
#
# The required status check contexts are the two blocking CI jobs from ci.yml.
# Playwright E2E is not run on the VPS runner. Gitea derives contexts as
# "<workflow> / <job>", so they stay stable only because ci.yml deliberately has
# no job-level `name:`.
#
# Usage:
#   GITEA_TOKEN=... bash scripts/gitea/protect-main.sh
#
# Optional overrides: GITEA_URL, GITEA_OWNER, GITEA_REPO.
# The token is read from the environment and is never printed.
set -euo pipefail

GITEA_URL="${GITEA_URL:-https://git.thckalbar.com}"
GITEA_OWNER="${GITEA_OWNER:-thckalbar}"
GITEA_REPO="${GITEA_REPO:-vms}"

if [ -z "${GITEA_TOKEN:-}" ]; then
  echo "ERROR: GITEA_TOKEN is required (Gitea: Settings -> Applications -> Generate token)." >&2
  exit 1
fi

api_base="${GITEA_URL%/}/api/v1/repos/${GITEA_OWNER}/${GITEA_REPO}/branch_protections"

payload='{
  "branch_name": "main",
  "enable_push": false,
  "enable_push_whitelist": false,
  "enable_merge_whitelist": false,
  "enable_status_check": true,
  "status_check_contexts": ["ci / backend", "ci / frontend"],
  "required_approvals": 0,
  "enable_approvals_whitelist": false,
  "block_on_rejected_reviews": false,
  "block_on_official_review_requests": false,
  "block_on_outdated_branch": false,
  "dismiss_stale_approvals": false,
  "require_signed_commits": false
}'

# Detect whether protection already exists so the script stays idempotent.
# 200 -> PATCH the existing rule; 404 -> POST a new one; anything else is fatal.
status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: token ${GITEA_TOKEN}" \
  -H "Accept: application/json" \
  "${api_base}/main")"

case "${status}" in
  200)
    method="PATCH"
    url="${api_base}/main"
    action="update existing"
    ;;
  404)
    method="POST"
    url="${api_base}"
    action="create"
    ;;
  *)
    echo "ERROR: unexpected HTTP ${status} while reading protection for 'main'." >&2
    exit 1
    ;;
esac

echo "Branch protection for 'main': ${action} (HTTP ${status})."

body="$(mktemp)"
trap 'rm -f "${body}"' EXIT

result="$(curl -sS -o "${body}" -w '%{http_code}' \
  -X "${method}" \
  -H "Authorization: token ${GITEA_TOKEN}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data "${payload}" \
  "${url}")"

if [ "${result}" -lt 200 ] || [ "${result}" -ge 300 ]; then
  echo "ERROR: Gitea rejected the branch protection update (HTTP ${result})." >&2
  cat "${body}" >&2
  exit 1
fi

echo "OK: 'main' requires ci / backend and ci / frontend."
