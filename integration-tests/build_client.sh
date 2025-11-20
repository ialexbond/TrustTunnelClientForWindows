#!/usr/bin/env bash

set -e -x

# Build script for VPN client in integrated tests
# This script builds the trusttunnel client and copies output to the output volume

# Variables
SOURCE_DIR="${SOURCE_DIR:-/source}"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"

# Make modifyable source directory

VPN_LIBS_DIR="${SOURCE_DIR}/vpn-libs"
BUILD_DIR="${BUILD_DIR:-/build}"

echo "Starting client build process..."

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Check if CONAN_REPO_URL is set (required for client builds)
if [ -z "$CONAN_REPO_URL" ]; then
    echo "Error: CONAN_REPO_URL environment variable is required for client builds"
    echo "Please set CONAN_REPO_URL to your Conan repository URL"
    exit 1
fi

# Set up Conan repository
echo "Setting up Conan repository: $CONAN_REPO_URL"
conan remote add --index 0 art "$CONAN_REPO_URL"

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "Configuring CMake..."
export LDFLAGS=-fuse-ld=lld
cmake ${VPN_LIBS_DIR} \
    -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -G "Ninja" \
    -DCMAKE_C_COMPILER="clang" \
    -DCMAKE_CXX_COMPILER="clang++" \
    -DCMAKE_CXX_FLAGS="-stdlib=libc++"

echo "Building trusttunnel_client..."
ninja trusttunnel_client

echo "Copying built client to output directory..."
cp ./trusttunnel/trusttunnel_client "$OUTPUT_DIR/"

# Copy any additional test scripts if they exist
if [ -d "$SOURCE_DIR/integrated-tests/client" ]; then
    echo "Copying client test scripts..."
    cp -r "$SOURCE_DIR/integrated-tests/client"/* "$OUTPUT_DIR/" 2>/dev/null || true
fi

echo "Client build completed successfully!"
echo "Output files:"
ls -la "$OUTPUT_DIR"
