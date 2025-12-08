#!/usr/bin/env bash

set -e -x

# Endpoint run script for VPN endpoint
# This script runs the VPN endpoint
# Parameters: LOG_FILE_NAME

LOG_FILE_NAME="${1:-vpn_endpoint.log}"

# Variables with defaults
LOG_LEVEL="${LOG_LEVEL:-info}"
CONFIG_FILE="vpn.conf"
TLS_HOSTS_SETTINGS_FILE="tls_hosts.conf"
RULES_FILE="rules.conf"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
LOG_FILE="${OUTPUT_DIR}/$LOG_FILE_NAME"
PID_FILE="${OUTPUT_DIR}/vpn_endpoint.pid"

# Set environment variables
export RUST_BACKTRACE=1

echo "Starting VPN endpoint..."
echo "Log level: $LOG_LEVEL"
echo "Config file: $CONFIG_FILE"
echo "TLS hosts file: $TLS_HOSTS_SETTINGS_FILE"
echo "Rules file: $RULES_FILE"
echo "Log file: $LOG_FILE"

# Change to output directory where the executable and config files are located
cd "$OUTPUT_DIR"

# Check if vpn_endpoint executable exists
if [ ! -f "./vpn_endpoint" ]; then
    echo "Error: vpn_endpoint executable not found in $OUTPUT_DIR"
    echo "Available files:"
    ls -la
    exit 1
fi

# Check if configuration files exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Configuration file $CONFIG_FILE not found"
    exit 1
fi

if [ ! -f "$TLS_HOSTS_SETTINGS_FILE" ]; then
    echo "Error: TLS hosts settings file $TLS_HOSTS_SETTINGS_FILE not found"
    exit 1
fi

if [ ! -f "$RULES_FILE" ]; then
    echo "Error: Rules file $RULES_FILE not found"
    exit 1
fi

echo "Starting VPN endpoint..."
echo "Log file: $LOG_FILE"

# Run the VPN endpoint in background
echo "Executing: ./vpn_endpoint -l \"$LOG_LEVEL\" \"$CONFIG_FILE\" \"$TLS_HOSTS_SETTINGS_FILE\""
mkdir -p /sys/fs/cgroup/endpoint
(
echo $BASHPID > /sys/fs/cgroup/endpoint/cgroup.procs
exec ./vpn_endpoint -l "$LOG_LEVEL" "$CONFIG_FILE" "$TLS_HOSTS_SETTINGS_FILE" >> "$LOG_FILE" 2>&1
) &
ENDPOINT_PID=$!

# Save PID to file
echo "$ENDPOINT_PID" > "$PID_FILE"
echo "VPN endpoint started with PID: $ENDPOINT_PID"

# Wait a bit for endpoint to initialize
sleep 3

# Check if endpoint is still running
if ! kill -0 "$ENDPOINT_PID" 2>/dev/null; then
    echo "Error: VPN endpoint failed to start or exited immediately"
    echo "Log contents:"
    tail -20 "$LOG_FILE" 2>/dev/null || echo "No log file found"
    rm -f "$PID_FILE"
    exit 1
fi

echo "VPN endpoint is running successfully"
echo "Endpoint PID: $ENDPOINT_PID"
