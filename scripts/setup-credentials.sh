#!/usr/bin/env bash
# Stores the Reddit app credentials in the macOS keychain, then checks them with Reddit.
# The secret is typed into the keychain's own hidden prompt, so it never reaches a file,
# the shell history or a process argument. Usage: npm run setup

set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE=reddit-sentiment

if [[ "$(uname)" != Darwin ]]; then
  echo "This setup uses the macOS keychain. Elsewhere, set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USERNAME."
  exit 1
fi

read -r -p "Reddit app client id: " client_id
read -r -p "Reddit username that owns the app: " username
username="${username#/}"
username="${username#u/}"
if [[ -z "$client_id" || -z "$username" ]]; then
  echo "Client id and username are both required. Nothing was stored."
  exit 1
fi

security add-generic-password -U -s "$SERVICE" -a client-id -w "$client_id"
security add-generic-password -U -s "$SERVICE" -a username -w "$username"
echo "Client secret, typed twice, hidden:"
security add-generic-password -U -s "$SERVICE" -a client-secret -w

echo "Stored in the keychain under \"$SERVICE\". Checking with Reddit..."
node scripts/check-connection.js
