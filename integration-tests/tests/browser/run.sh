#!/usr/bin/env bash

set -e -x

# Browser test runner script
# Browser tests use agvpn_helper to connect to real backend, always run in TUN mode
# Usage: run.sh [bamboo_vpn_app_id] [bamboo_vpn_token]

# Required parameters for browser tests
BAMBOO_VPN_APP_ID="$1"
BAMBOO_VPN_TOKEN="$2"

# Browser tests always use TUN mode and http2 protocol
PROTOCOL="http2"
MODE="tun"
LOG_FILE_NAME="vpn_tun_http2.log"

# Variables
TEST_DIR="${TEST_DIR:-/tests}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
AGVPN_HELPER_URL="${AGVPN_HELPER_URL:-}"
CLIENT_PID_FILE="${OUTPUT_DIR}/vpn_client.pid"

echo "Starting browser test runner..."

# Check required parameters
if [[ -z "$BAMBOO_VPN_APP_ID" ]] || [[ -z "$BAMBOO_VPN_TOKEN" ]]; then
    echo "Error: Browser tests require BAMBOO_VPN_APP_ID and BAMBOO_VPN_TOKEN"
    echo "Usage: run.sh <bamboo_vpn_app_id> <bamboo_vpn_token>"
    exit 1
fi

# Cleanup function
cleanup() {
    echo "Cleaning up..."

    # Stop VPN client if running
    if [ -f "$CLIENT_PID_FILE" ]; then
        CLIENT_PID=$(cat "$CLIENT_PID_FILE" 2>/dev/null || echo "")
        if [ -n "$CLIENT_PID" ] && kill -0 "$CLIENT_PID" 2>/dev/null; then
            echo "Stopping VPN client (PID: $CLIENT_PID)..."
            kill "$CLIENT_PID" || true
            wait "$CLIENT_PID" 2>/dev/null || true
            echo "VPN client stopped."
        fi
        rm -f "$CLIENT_PID_FILE"
    fi

    # Clean up network namespace if it exists
    if ip netns list | grep -q "^tun"; then
        echo "Removing network namespace 'tun'..."
        ip netns delete tun || true
    fi
}

# Set trap to cleanup on exit
trap cleanup EXIT

echo "Step 1: Checking agvpn_helper..."
# Check if agvpn_helper exists, download if missing
cd "$OUTPUT_DIR"
if [ ! -f agvpn_helper ] || [ ! -x agvpn_helper ]; then
    if [[ -z "$AGVPN_HELPER_URL" ]]; then
        echo "Error: agvpn_helper not found and AGVPN_HELPER_URL not set"
        echo "Please provide AGVPN_HELPER_URL environment variable to download agvpn_helper"
        exit 1
    fi

    echo "Downloading agvpn_helper from $AGVPN_HELPER_URL..."
    curl -L -o agvpn_helper "$AGVPN_HELPER_URL"
    chmod +x agvpn_helper
    echo "agvpn_helper downloaded and made executable"
else
    echo "agvpn_helper found and executable"
fi

echo "Step 2: Getting location data from backend..."
# Get location data from backend via agvpn_helper
location=$(./agvpn_helper get-location -c "Frankfurt" -t "$BAMBOO_VPN_TOKEN")
if [[ -z "$location" ]]; then
    echo "Error: Failed to get location data from backend"
    exit 1
fi

# Parse location data
ENDPOINT_HOSTNAME=$(echo "$location" | jq -r '.endpoints[0].server_name // empty')
ENDPOINT_IP=$(echo "$location" | jq -r '.relays[0].relay_ipv4 // .endpoints[0].ipv4 // empty' | cut -d: -f1)
ENDPOINT_PORT="443"

# Check that we got location data successfully
if [[ -z "$ENDPOINT_HOSTNAME" ]] || [[ -z "$ENDPOINT_IP" ]]; then
    echo "Failed to decode location data from backend: $location"
    exit 1
fi

echo "Location data: hostname=$ENDPOINT_HOSTNAME, ip=$ENDPOINT_IP, port=$ENDPOINT_PORT"

echo "Step 3: Getting credentials from backend..."
# Get credentials from backend via agvpn_helper
output=$(./agvpn_helper get-creds -t "$BAMBOO_VPN_TOKEN")
if [[ -z "$output" ]]; then
    echo "Error: Failed to get credentials from backend"
    exit 1
fi

# Parse credentials
ENDPOINT_USERNAME=$(echo "$output" | jq -r '.username')
ENDPOINT_PASSWORD=$(echo "$output" | jq -r '.password')

# Check that we got credentials successfully
if [[ -z "$ENDPOINT_USERNAME" ]] || [[ -z "$ENDPOINT_PASSWORD" ]]; then
    echo "Failed to decode credentials from backend: $output"
    exit 1
fi
echo "Credentials obtained: username=$ENDPOINT_USERNAME"

echo "Step 4: Setting up client..."
# Use client_setup.sh to configure the VPN client
# For browser tests, we pass custom credentials and endpoint port from backend
"$TEST_DIR/client_setup.sh" "$ENDPOINT_HOSTNAME" "$ENDPOINT_IP" "" "$ENDPOINT_PORT" "$PROTOCOL" "$MODE" "$LOG_FILE_NAME" "" "$ENDPOINT_USERNAME" "$ENDPOINT_PASSWORD"

echo "Step 5: Starting client..."
# Run the VPN client
"$TEST_DIR/client_run.sh" "$LOG_FILE_NAME"

echo "Step 6: Running browser tests..."
# Run browser tests inside the network namespace
echo "Running browser tests..."
"$TEST_DIR/browser/browser_tests.sh"

echo "Step 7: Tests completed, cleanup will be handled by trap"
echo "Browser test run completed successfully!"
