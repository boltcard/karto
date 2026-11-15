# The card-native module for iOS. The files here
# are the ones that need Apple's frameworks; everything that could be decided without one is the Swift package
# beside them (../swift/CardKit: CardLogic, and CardSsh on apple/swift-nio-ssh), brought in with React Native's
# spm_dependency and tested on Linux (make ios-swift-test).
Pod::Spec.new do |s|
  s.name           = 'CardNative'
  s.version        = '1.0.0'
  s.summary        = 'Karto Wallet native layer: SSH, the device key, card reading, the cameras, bundled server files'
  s.description    = 'Karto Wallet native layer: SSH, the device key, card reading, the cameras, bundled server files'
  s.license        = 'MIT'
  s.author         = 'Peter Rounce'
  s.homepage       = 'https://github.com/boltcard/karto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/boltcard/karto.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreNFC', 'Security', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'ImageIO'

  # Only this folder's own files: the package has its own Package.swift and tests.
  s.source_files = "*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  spm_dependency(s,
    url: File.expand_path('../swift/CardKit', __dir__),
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '1.0.0' },
    products: ['CardSsh', 'CardLogic']
  )
end
