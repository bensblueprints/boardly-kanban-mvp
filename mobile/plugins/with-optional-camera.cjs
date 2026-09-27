const { withAndroidManifest } = require('expo/config-plugins');

module.exports = config => withAndroidManifest(config, mod => {
  const manifest = mod.modResults.manifest;
  const features = manifest['uses-feature'] || [];
  for (const name of ['android.hardware.camera', 'android.hardware.camera.autofocus']) {
    const existing = features.find(feature => feature.$?.['android:name'] === name);
    if (existing) existing.$['android:required'] = 'false';
    else features.push({ $: { 'android:name': name, 'android:required': 'false' } });
  }
  manifest['uses-feature'] = features;
  return mod;
});
