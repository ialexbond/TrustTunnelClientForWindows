#!/usr/bin/env bash

set -e -x

# Client run script for VPN client
# This script runs the standalone VPN client
# Parameters: LOG_FILE_NAME

LOG_FILE_NAME="${1:-vpn_client.log}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
PID_FILE="${OUTPUT_DIR}/vpn_client.pid"

# Change to output directory where the executable and config files are located
cd "$OUTPUT_DIR"

echo "Starting VPN client..."
echo "Log file: ${OUTPUT_DIR}/$LOG_FILE_NAME"

# Check if standalone_client exists
if [ ! -f "./standalone_client" ]; then
    echo "Error: standalone_client binary not found in current directory"
    exit 1
fi

# Check if configuration exists
if [ ! -f "./standalone_client.toml" ]; then
    echo "Error: standalone_client.toml configuration not found in current directory"
    exit 1
fi

echo "Running standalone client..."
mkdir -p /sys/fs/cgroup/client
(
echo $BASHPID > /sys/fs/cgroup/client/cgroup.procs
exec ./standalone_client >>"${OUTPUT_DIR}/$LOG_FILE_NAME" 2>&1
) &
CLIENT_PID=$!

# Save PID to file
echo "$CLIENT_PID" > "$PID_FILE"
echo "VPN client started with PID: $CLIENT_PID"

# Wait a bit for client to initialize
sleep 3

# Check if client is still running
if ! kill -0 "$CLIENT_PID" 2>/dev/null; then
    echo "Error: VPN client failed to start or exited immediately"
    echo "Log contents:"
    tail -20 "${OUTPUT_DIR}/$LOG_FILE_NAME" 2>/dev/null || echo "No log file found"
    rm -f "$PID_FILE"
    exit 1
fi

echo "VPN client is running successfully"
echo "Client PID: $CLIENT_PID"
