#!/bin/bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'Run this installer on macOS.' >&2
  exit 1
fi
: "${WPP_GROUPS:?Set WPP_GROUPS to the allowed group JIDs}"
project_path="$(cd "$(dirname "$0")/.." && pwd)"
node_path="$(command -v node)"
data_path="${WPP_DATA_DIR:-$HOME/Library/Application Support/wpp-vip-ingest}"
mkdir -p "$data_path" "$HOME/Library/LaunchAgents"
chmod 700 "$data_path"
export WPP_PROJECT_PATH="$project_path" WPP_NODE_PATH="$node_path" WPP_DATA_DIR="$data_path"
python3 "${project_path}/deploy/render-launchagent.py"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aurea.wpp-vip-ingest.plist"
echo 'LaunchAgent installed.'
