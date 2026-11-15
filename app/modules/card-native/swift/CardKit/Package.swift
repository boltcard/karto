// swift-tools-version:6.1
// The plain Swift of the iPhone's native module: whatever can be decided without an Apple framework, so it builds and tests on Linux
// (deploy/test/ios-swift-test.sh) as well as on a Mac. The Apple-only files beside it (../../ios) call into it.
import PackageDescription

let package = Package(
  name: "CardKit",
  platforms: [.iOS("16.4"), .macOS(.v13)],
  // Two products, each named in the podspec (../../ios/CardNative.podspec).
  products: [
    .library(name: "CardLogic", targets: ["CardLogic"]),
    .library(name: "CardSsh", targets: ["CardSsh"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.15.0"),
    .package(url: "https://github.com/apple/swift-nio.git", from: "2.81.0"),
    .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
  ],
  targets: [
    // No dependency at all, and none on CardSsh: it is compiled into the app whatever happens to the SSH layer.
    .target(name: "CardLogic"),
    // Fixtures/card-edges.bin: the edge finder's cross-check, written by Android's CardEdgesFixtureTest.kt.
    .testTarget(name: "CardLogicTests", dependencies: ["CardLogic"], resources: [.copy("Fixtures/card-edges.bin")]),
    // The SSH layer (android/.../SshSessions.kt's other implementation), on apple/swift-nio-ssh.
    .target(
      name: "CardSsh",
      dependencies: [
        "CardLogic",
        .product(name: "NIOSSH", package: "swift-nio-ssh"),
        .product(name: "NIOCore", package: "swift-nio"),
        .product(name: "NIOPosix", package: "swift-nio"),
        .product(name: "NIOConcurrencyHelpers", package: "swift-nio"),
        .product(name: "Crypto", package: "swift-crypto"),
      ]
    ),
    .testTarget(name: "CardSshTests", dependencies: ["CardSsh", "CardLogic"]),
  ],
  swiftLanguageModes: [.v5]
)
