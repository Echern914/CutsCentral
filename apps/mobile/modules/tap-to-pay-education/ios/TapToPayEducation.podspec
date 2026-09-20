Pod::Spec.new do |s|
  s.name           = 'TapToPayEducation'
  s.version        = '1.0.0'
  s.summary        = "Apple's required How to Tap merchant education overlay"
  s.description    = "Presents ProximityReaderDiscovery .payment(.howToTap), which Apple requires before Tap to Pay on iPhone may ship."
  s.author         = 'ChairBack'
  s.homepage       = 'https://getchairback.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
