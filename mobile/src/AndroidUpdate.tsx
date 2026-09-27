import React, { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useAuth } from '@clerk/expo';
import { ORIGIN } from './config';
import { validateAndroidRelease } from './android-release';

// The native module must stream and verify the APK before exposing installation.
// Tokens are transient arguments, never stored in update metadata or URLs.
type UpdateModule = {
  prepare(sessionToken: string, metadata: string): Promise<void>;
  install(): Promise<'installer_opened' | 'permission_required'>;
  discard(): Promise<void>;
};
const updater = requireOptionalNativeModule<UpdateModule>('BoardlyAndroidUpdate');

export default function AndroidUpdate() {
  const { getToken, userId } = useAuth();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setMessage('');
    return () => { generation.current++; updater?.discard().catch(() => {}); };
  }, [userId]);
  if (Platform.OS !== 'android') return null;

  async function download() {
    if (active.current) return;
    if (!updater) { setMessage('Android updates are unavailable in this build.'); return; }
    active.current = true; setBusy(true); setMessage('Checking the latest Android release…');
    const current = ++generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in again to download an update.');
      const response = await fetch(ORIGIN + '/api/mobile/android/release', {
        headers: { Authorization: 'Bearer ' + token }, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 503 ? 'The Android release is being prepared. Please try again later.' : 'The update could not be retrieved. Check your sign-in and try again.');
      const release = validateAndroidRelease(await response.json());
      if (current !== generation.current) return;
      setMessage('Downloading and verifying version ' + release.version + '…');
      const freshToken = await getToken();
      if (!freshToken || current !== generation.current) return;
      await updater.prepare(freshToken, JSON.stringify(release));
      if (current !== generation.current) { await updater.discard(); return; }
      setMessage('Update verified. Ready for Android installation.');
      Alert.alert('Install Boardly ' + release.version + '?', 'Android will ask you to confirm installation. Your workspace remains saved in Boardly.', [
        { text: 'Cancel', style: 'cancel', onPress: () => { if (current !== generation.current) return; updater.discard().catch(() => {}); setMessage('Update cancelled.'); } },
        { text: 'Install update', onPress: () => {
          if (current !== generation.current) return;
          updater.install().then(result => {
            if (current !== generation.current) return;
            setMessage(result === 'permission_required' ? 'Allow installation from Boardly in Android settings, then return and tap Download update again.' : 'Android installer opened. Installation is not yet confirmed.');
          }).catch(() => { if (current === generation.current) setMessage('Installation could not start. Download the update again.'); });
        } },
      ]);
    } catch (failure) {
      if (current === generation.current) setMessage(failure instanceof Error ? failure.message : 'Update failed. Please try again.');
    } finally {
      clearTimeout(timer); active.current = false;
      if (current === generation.current) setBusy(false);
    }
  }
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={download} style={{ padding: 15, borderRadius: 14, borderWidth: 1, borderColor: '#303641' }}>
      <Text style={{ color: '#b8f36b', fontSize: 15 }}>{busy ? 'Preparing update…' : 'Download update'}</Text>
    </Pressable>
    {!!message && <Text accessibilityLiveRegion="polite" style={{ color: '#a5adba', fontSize: 13 }}>{message}</Text>}
  </View>;
}
