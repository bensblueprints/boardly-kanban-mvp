import React, { useRef, useState, useEffect } from 'react';
import { Alert, BackHandler, Linking, Pressable, Text, View, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useAuth } from '@clerk/expo';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { ORIGIN, isWorkspaceUrl, downloadUrl } from './config';

export default function ProjectWorkspace({ route, workspaceId, userId, title, onClose, onSignOut }: {
  route: string; workspaceId: string; userId: string; title: string; onClose: () => void; onSignOut: () => void;
}) {
  const { getToken } = useAuth();
  const web = useRef<WebView>(null), documentId = useRef(''), currentUrl = useRef(''), generation = useRef(0);
  const [error, setError] = useState(''), [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => () => { generation.current++; documentId.current = ''; currentUrl.current = ''; }, []);
  useEffect(() => { const handler = BackHandler.addEventListener('hardwareBackPress', () => { if (canGoBack) web.current?.goBack(); else onClose(); return true; }); return () => handler.remove(); }, [canGoBack, onClose]);
  function reply(id: string, nonce: string, data?: unknown, failure?: string) {
    if (documentId.current !== nonce || !isWorkspaceUrl(currentUrl.current)) return;
    const message = JSON.stringify({ id, nonce, data, error: failure });
    web.current?.injectJavaScript(`if(location.origin===${JSON.stringify(ORIGIN)}&&location.pathname==='/mobile/'&&window.__BOARDLY_NATIVE_DOC===${JSON.stringify(nonce)}){window.dispatchEvent(new MessageEvent('boardly:native',{data:${JSON.stringify(message)}}));}true;`);
  }
  async function receive(event: WebViewMessageEvent) {
    // Android's WebMessageListener reports the source origin; iOS reports the full URL.
    const source = event.nativeEvent.url;
    if (!(source === ORIGIN || source === ORIGIN + '/' || isWorkspaceUrl(source)) || !isWorkspaceUrl(currentUrl.current) || event.nativeEvent.data.length > 250000) return;
    let message: { type: string; id: string; nonce: string; url?: string; name?: string; workspaceId?: string; content?: string };
    try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (!message || typeof message !== 'object' || typeof message.id !== 'string' || typeof message.nonce !== 'string' || !['ready', 'token', 'signout', 'download', 'shareText'].includes(message.type)) return;
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(message.id) || !/^[a-f0-9-]{36}$/.test(message.nonce)) return;
    if (message.type === 'ready') { if (documentId.current !== message.nonce) generation.current++; documentId.current = message.nonce; reply(message.id, message.nonce, { userId, workspaceId }); return; }
    if (message.nonce !== documentId.current) return;
    const activeGeneration = generation.current;
    try {
      if (message.type === 'token') {
        const token = await getToken();
        if (activeGeneration === generation.current) reply(message.id, message.nonce, token);
      } else if (message.type === 'signout') onSignOut();
      else if (message.type === 'download' || message.type === 'shareText') {
        const url = message.type === 'download' ? downloadUrl(message.url || '') : null, token = await getToken();
        if (!token || activeGeneration !== generation.current) throw new Error('Sign in again to download this file.');
        const cleaned = (message.name || 'Boardly file').replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 180);
        const name = !cleaned || /^\.+$/.test(cleaned) ? 'Boardly file' : cleaned;
        const directory = FileSystem.cacheDirectory + 'boardly-share-' + Crypto.randomUUID() + '/';
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        try {
          const uri = directory + name;
          if (url) {
            const result = await FileSystem.downloadAsync(url, uri, { headers: { authorization: 'Bearer ' + token, 'x-boardly-workspace': message.workspaceId || workspaceId } });
            if (result.status !== 200) throw new Error('The file could not be downloaded. Check your project access.');
          } else {
            if (typeof message.content !== 'string' || message.content.length > 200000) throw new Error('This document is too large to share.');
            await FileSystem.writeAsStringAsync(uri, message.content);
          }
          if (activeGeneration !== generation.current) return;
          if (!(await Sharing.isAvailableAsync())) throw new Error('File sharing is unavailable on this device.');
          await Sharing.shareAsync(uri, { dialogTitle: name });
          reply(message.id, message.nonce, { shared: true });
        } finally { await FileSystem.deleteAsync(directory, { idempotent: true }); }
      }
    } catch (failure) { reply(message.id, message.nonce, undefined, failure instanceof Error ? failure.message : 'Please try again.'); }
  }
  return <View style={styles.root}>
    <View style={styles.toolbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to projects" onPress={onClose} style={styles.button}><Text style={styles.link}>‹ Projects</Text></Pressable>
      <Text numberOfLines={1} style={styles.title}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Reload workspace" onPress={() => { setError(''); web.current?.reload(); }} style={styles.button}><Text style={styles.link}>↻</Text></Pressable>
    </View>
    {!!error && <View style={styles.error}><Text style={styles.text}>{error}</Text><Pressable onPress={() => { setError(''); web.current?.reload(); }}><Text style={styles.link}>Try again</Text></Pressable></View>}
    <WebView ref={web} source={{ uri: ORIGIN + '/mobile/' + route }} style={styles.web} originWhitelist={[ORIGIN]}
      javaScriptEnabled domStorageEnabled sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito
      webviewDebuggingEnabled={__DEV__}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never" allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="prompt" setSupportMultipleWindows
      onLoadStart={event => {
        // Android emits this for hash navigation too, while the same document
        // and pending requests remain alive. A new document replaces its nonce
        // in the ready handshake; injected replies also check that actual nonce.
        if (!isWorkspaceUrl(currentUrl.current) || !isWorkspaceUrl(event.nativeEvent.url)) { generation.current++; documentId.current = ''; }
        currentUrl.current = event.nativeEvent.url;
      }}
      onNavigationStateChange={state => { currentUrl.current = state.url; setCanGoBack(state.canGoBack); }} onMessage={receive}
      onShouldStartLoadWithRequest={request => {
        if (isWorkspaceUrl(request.url)) return true;
        try { if (['https:', 'http:', 'mailto:', 'tel:'].includes(new URL(request.url).protocol)) Linking.openURL(request.url).catch(() => Alert.alert('Could not open link')); } catch {}
        return false;
      }}
      onOpenWindow={event => { const url = event.nativeEvent.targetUrl; try { if (['https:', 'http:'].includes(new URL(url).protocol)) Linking.openURL(url).catch(() => {}); } catch {} }}
      onError={() => setError('Boardly could not connect. Your saved project is still on the server.')}
      onHttpError={event => { if (event.nativeEvent.statusCode >= 400 && isWorkspaceUrl(event.nativeEvent.url)) setError('The workspace is temporarily unavailable.'); }}
      onContentProcessDidTerminate={() => web.current?.reload()}
      onRenderProcessGone={() => { setError('The workspace needs to reload.'); return true; }}
    />
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: '#0c0e12' }, toolbar: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#272d36', minHeight: 48 }, button: { padding: 12 }, title: { flex: 1, color: '#fff', fontWeight: '600', textAlign: 'center' }, link: { color: '#b8f36b', fontSize: 15 }, text: { color: '#fff' }, web: { flex: 1, backgroundColor: '#09090b' }, error: { padding: 18, gap: 12, backgroundColor: '#292018' } });
