const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = config => withAppBuildGradle(config, mod => {
  const marker = '// Boardly private release signing';
  if (mod.modResults.contents.includes(marker)) return mod;
  mod.modResults.contents += `
${marker}
def boardlySigningNames = ['BOARDLY_KEYSTORE_PATH', 'BOARDLY_KEYSTORE_PASSWORD', 'BOARDLY_KEY_ALIAS', 'BOARDLY_KEY_PASSWORD']
def boardlyHasSigning = boardlySigningNames.every { System.getenv(it) }
if (boardlyHasSigning) {
    android.signingConfigs.create('boardlyRelease') {
        storeFile file(System.getenv('BOARDLY_KEYSTORE_PATH'))
        storePassword System.getenv('BOARDLY_KEYSTORE_PASSWORD')
        keyAlias System.getenv('BOARDLY_KEY_ALIAS')
        keyPassword System.getenv('BOARDLY_KEY_PASSWORD')
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.boardlyRelease
} else {
    android.buildTypes.release.signingConfig = null
    gradle.taskGraph.whenReady { graph ->
        if (graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }) {
            throw new GradleException('Boardly release signing is missing. Configure the four BOARDLY_KEYSTORE/KEY environment variables documented in mobile/README.md.')
        }
    }
}
`;
  return mod;
});
