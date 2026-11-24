#!/usr/bin/env bash
# Start the Stem Review app. Usage: ./run.sh [--port 8765] [--data /path/to/listening_folder]
set -e
cd "$(dirname "$0")"
exec python3 server.py "$@"
