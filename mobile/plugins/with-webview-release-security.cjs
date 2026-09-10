const { withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

module.exports = config => withDangerousMod(config, ['android', mod => {
  const root = path.dirname(require.resolve('react-native-webview/package.json', { paths: [mod.modRequest.projectRoot] }));
  const file = path.join(root, 'android/src/main/java/com/reactnativecommunity/webview/RNCWebViewManagerImpl.kt');
  const source = fs.readFileSync(file, 'utf8');
  const marker = '// Boardly: use the application flag, not the React library build flag.';
  if (source.includes(marker)) return mod;
  const pattern = /if \(ReactBuildConfig\.DEBUG\) \{\s*WebView\.setWebContentsDebuggingEnabled\(true\)\s*\}/;
  if (!pattern.test(source)) throw new Error('Review the WebView Android release-debugging patch for this dependency version.');
  fs.writeFileSync(file, source.replace(pattern, `${marker}
        WebView.setWebContentsDebuggingEnabled(
            (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        )`));
  return mod;
}]);
