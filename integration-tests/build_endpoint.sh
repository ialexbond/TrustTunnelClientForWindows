#!/usr/bin/env bash

set -e -x

# Build script for VPN endpoint in integrated tests
# This script builds the VPN endpoint and copies output to the output volume

# Variables
SOURCE_DIR="${SOURCE_DIR:-/source}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"

# Make modifyable source directory
ENDPOINT_DIR="${SOURCE_DIR}/vpn-libs-endpoint"
export CARGO_TARGET_DIR="${BUILD_DIR:-/build}/target"

echo "Starting endpoint build process..."

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Check if endpoint directory exists
if [ ! -d "$ENDPOINT_DIR" ]; then
    echo "Error: Endpoint directory not found at $ENDPOINT_DIR"
    exit 1
fi

echo "Building VPN endpoint with Cargo..."
cd "$ENDPOINT_DIR"
cargo build --config net.git-fetch-with-cli=true --release --bin vpn_endpoint

echo "Copying built endpoint to output directory..."
cp ${CARGO_TARGET_DIR}/release/vpn_endpoint "$OUTPUT_DIR/"

echo "Endpoint build completed successfully!"
echo "Output files:"
ls -la "$OUTPUT_DIR"
