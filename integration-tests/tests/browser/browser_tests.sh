#!/usr/bin/env bash

set -e -x

OUTPUT_DIR="${OUTPUT_DIR:-/output}"

tunexec() {
    ip netns exec tun "$@"
}

# Browser test implementation
# This script runs the actual browser tests and should be executed inside the TUN network namespace
# Usage: browser_tests.sh

echo "Starting browser tests..."

# Use the local browser test files in the same directory
TEST_DIR="$(dirname "$0")"
cd "$TEST_DIR"

echo "Installing Node.js dependencies..."
PUPPETEER_SKIP_DOWNLOAD=true yarn install

# Check that VPN client is running
echo "Checking if VPN client is running..."
sleep 5
if ! pgrep standalone > /dev/null; then
    echo "VPN client is not running"
    exit 1
fi

echo "Testing that vpn-client actually works"
tunexec curl -I https://google.com -4
tunexec curl -I https://google.com -6

echo "Running browser tests for 30 minutes..."
RESULT=0

# Run tests for 30 minutes
tunexec env TIME_LIMIT=30m VERBOSE=true node index.js || RESULT=1
cp output.json ${OUTPUT_DIR}/output1part.json 2>/dev/null || true

echo "Simulating network problems..."
# Imitate network problems. Drop all traffic to endpoint. Client should reconnect.
iptables -A OUTPUT -j DROP
iptables -A INPUT -j DROP
sleep 1

# Send SIGHUP to client to trigger reconnection
PIDS=$(pgrep standalone)
echo "PIDS: $PIDS"
for pid in $PIDS; do
    kill -SIGHUP $pid || true
done
sleep 9

# Restore network connectivity
iptables -D OUTPUT -j DROP
iptables -D INPUT -j DROP
sleep 60

echo "Running browser tests again after network recovery..."
# Run tests again
tunexec env TIME_LIMIT=30m VERBOSE=true node index.js || RESULT=1
cp output.json ${OUTPUT_DIR}/output2part.json 2>/dev/null || true

echo "Browser tests completed with result: $RESULT"
exit "$RESULT"
