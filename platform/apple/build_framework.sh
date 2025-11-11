set -xe

CONFIGURATION="Release"
if [[ "$1" == "-debug" ]]; then
  CONFIGURATION="Debug"
fi

rm -rf build

pod install

# Build VpnClientFramework
xcodebuild -project TrustTunnelClient.xcodeproj \
  -scheme VpnClientFramework \
  -configuration $CONFIGURATION

rm -rf Framework
mkdir -p Framework
mv build/framework/VpnClientFramework.xcframework Framework/

# Build VpnManager framework
xcodebuild -workspace TrustTunnelClient.xcworkspace \
  -scheme TrustTunnelClient-iOS \
  -configuration $CONFIGURATION \
  -sdk iphoneos \
  -archivePath ./build/ios.xcarchive \
  archive

# Build VpnManager framework
xcodebuild -workspace TrustTunnelClient.xcworkspace \
  -scheme TrustTunnelClient-iOS \
  -configuration $CONFIGURATION \
  -sdk iphonesimulator \
  -archivePath ./build/iphonesimulator.xcarchive \
  ARCHS="x86_64 arm64" \
  ONLY_ACTIVE_ARCH=NO \
  archive

# Build VpnManager framework
xcodebuild -workspace TrustTunnelClient.xcworkspace \
  -scheme TrustTunnelClient-MacOS \
  -configuration $CONFIGURATION \
  -archivePath ./build/macos.xcarchive \
  ARCHS="x86_64 arm64" \
  ONLY_ACTIVE_ARCH=NO \
  archive


xcodebuild -create-xcframework \
  -framework ./build/ios.xcarchive/Products/Library/Frameworks/TrustTunnelClient.framework \
  -framework ./build/iphonesimulator.xcarchive/Products/Library/Frameworks/TrustTunnelClient.framework \
  -framework ./build/macos.xcarchive/Products/Library/Frameworks/TrustTunnelClient.framework \
  -output Framework/TrustTunnelClient.xcframework
