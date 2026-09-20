Pod::Spec.new do |s|
  s.name           = 'WalletPass'
  s.version        = '1.0.0'
  s.summary        = 'Adds an appointment pass to Apple Wallet from inside the app'
  s.description    = "Presents PKAddPassesViewController for a signed .pkpass, which a WKWebView navigation cannot do."
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
