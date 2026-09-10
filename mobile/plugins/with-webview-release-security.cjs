const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

module.exports = config => withDangerousMod(config, ['android', mod => {
  const root = path.dirname(require.resolve('react-native-webview/package.json', { paths: [mod.modRequest.projectRoot] }));
  const file = path.join(root, 'android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt');
  const source = fs.readFileSync(file, 'utf8');
  const marker = '// Boardly: use the application flag, not the React library build flag.';
  const pattern = /if \(ReactBuildConfig\.DEBUG\) \{\s*WebView\.setWebContentsDebuggingEnabled\(true\)\s*\}/;
  if (!source.includes(marker)) {
    if (!pattern.test(source)) throw new Error('Review the WebView Android release-debugging patch for this dependency version.');
    fs.writeFileSync(file, source.replace(pattern, `${marker}
        WebView.setWebContentsDebuggingEnabled(
            (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        )`));
  }
  const patches = [
    [file, 'RNCWebView.setWebContentsDebuggingEnabled(enabled)', 'RNCWebView.setWebContentsDebuggingEnabled(enabled && (viewWrapper.context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)'],
    [path.join(path.dirname(require.resolve('@expo/log-box/package.json', { paths: [mod.modRequest.projectRoot] })), 'android/src/main/expo/modules/logbox/ExpoLogBoxWebViewWrapper.kt'), 'setWebContentsDebuggingEnabled(true)', 'setWebContentsDebuggingEnabled((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)'],
    [path.join(path.dirname(require.resolve('@expo/dom-webview/package.json', { paths: [mod.modRequest.projectRoot] })), 'android/src/main/java/expo/modules/webview/DomWebView.kt'), 'WebView.setWebContentsDebuggingEnabled(value)', 'WebView.setWebContentsDebuggingEnabled(value && (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)'],
  ];
  for (const [target, before, after] of patches) {
    const text = fs.readFileSync(target, 'utf8');
    if (text.includes(after)) continue;
    if (!text.includes(before)) throw new Error('Review Android WebView debugging guard in ' + path.basename(target));
    fs.writeFileSync(target, text.replace(before, after));
  }
  return mod;
}]);
