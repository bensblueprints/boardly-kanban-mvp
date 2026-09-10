import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { AuthView, UserButton } from '@clerk/expo/native';
import NetInfo from '@react-native-community/netinfo';
import * as Haptics from 'expo-haptics';
import { ORIGIN, PUBLISHABLE_KEY } from './src/config';
import ProjectWorkspace from './src/ProjectWorkspace';

type Account = { owner_id: string; name: string; owner: boolean };
type Access = { allowed: boolean; userId: string; workspaceId: string; workspaces: Account[]; error?: string };
type Hierarchy = { companies: { id: number; name: string }[]; boards: { id: number; company_id: number | null; name: string }[]; projects: { id: number; name: string; description: string; parent_board_id: number; task_count: number; emoji: string; starred: number }[] };
const logo = require('./assets/icon.png');

function Boardly() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser(), { signOut } = useClerk();
  const [authOpen, setAuthOpen] = useState(false), [access, setAccess] = useState<Access | null>(null), [tree, setTree] = useState<Hierarchy | null>(null);
  const [selection, setSelection] = useState(''), [company, setCompany] = useState<number | null>(null), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [online, setOnline] = useState(true);
  const [opened, setOpened] = useState<{ route: string; title: string } | null>(null), [accountsOpen, setAccountsOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { request.current?.abort(); setAccess(null); setTree(null); setOpened(null); setSelection(''); return () => request.current?.abort(); }, [userId]);
  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in to open your workspace.');
      const headers = { authorization: 'Bearer ' + token, ...(selection ? { 'x-boardly-workspace': selection } : {}) };
      const meResponse = await fetch(ORIGIN + '/api/me', { headers, signal: controller.signal }); const me: Access = await meResponse.json();
      if (!meResponse.ok || !me.allowed) throw new Error(me.error || 'This account cannot access Boardly yet.');
      const response = await fetch(ORIGIN + '/api/hierarchy', { headers: { ...headers, 'x-boardly-workspace': me.workspaceId }, signal: controller.signal });
      if (!response.ok) throw new Error('Your projects could not be loaded. Pull down to try again.');
      const hierarchy: Hierarchy = await response.json();
      if (controller.signal.aborted) return;
      if (selection && selection !== me.workspaceId) { setOpened(null); setCompany(null); }
      setAccess(me); setTree(hierarchy);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Check your connection and try again.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [isSignedIn, getToken, selection]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => NetInfo.addEventListener(state => setOnline(state.isConnected !== false)), []);
  useEffect(() => { const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); }); return () => subscription.remove(); }, [refresh]);
  const open = (route: string, title: string) => { Haptics.selectionAsync().catch(() => {}); setOpened({ route, title }); };
  const logout = () => { request.current?.abort(); setOpened(null); setTree(null); setAccess(null); signOut().catch(() => Alert.alert('Sign out could not finish', 'Check your connection and try again.')); };
  const projects = (tree?.projects || []).filter(project => (company === null || tree?.boards.some(board => board.id === project.parent_board_id && board.company_id === company)) && (project.name + ' ' + project.description).toLowerCase().includes(search.toLowerCase()));
  return <SafeAreaView style={s.safe}>
    <StatusBar style="light" />
    {!isLoaded ? <ActivityIndicator style={s.loader} color="#b8f36b" /> : !isSignedIn ? <View style={s.welcome}>
      <Image source={logo} accessibilityLabel="Boardly" style={s.heroLogo} />
      <Text style={s.eyebrow}>YOUR COMPANIES. ONE PLACE.</Text>
      <Text style={s.hero}>Move your{'\n'}work forward.</Text>
      <Text style={s.subtitle}>Talk through your projects, hear what matters, and put your AI team to work.</Text>
      <Pressable accessibilityRole="button" style={s.primary} onPress={() => setAuthOpen(true)}><Text style={s.primaryText}>Continue to Boardly →</Text></Pressable>
      <Text style={s.small}>Sign in with your existing Boardly account or create one.</Text>
      <Pressable onPress={() => Linking.openURL(ORIGIN)}><Text style={s.link}>Explore Boardly</Text></Pressable>
    </View> : opened && access && userId ? <ProjectWorkspace key={userId + access.workspaceId} {...opened} workspaceId={access.workspaceId} userId={userId} onClose={() => { setOpened(null); refresh(); }} onSignOut={logout} /> : <>
      <View style={s.header}><Image source={logo} style={s.logo} accessibilityLabel="Boardly" /><Text style={s.brand}>Boardly</Text><UserButton /></View>
      {!online && <Text style={s.offline}>You’re offline. Reconnect to load and update projects.</Text>}
      <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor="#b8f36b" />}>
        <Text style={s.eyebrow}>YOUR WORKSPACE</Text><Text style={s.heading}>Let’s make progress{user?.firstName ? ', ' + user.firstName : ''}.</Text>
        <Pressable style={s.account} onPress={() => setAccountsOpen(true)}><Text style={s.text}>{access?.workspaces.find(account => account.owner_id === access.workspaceId)?.name || 'My account'} ⌄</Text></Pressable>
        {!!error && <View style={s.error}><Text style={s.text}>{error}</Text><Pressable onPress={refresh}><Text style={s.link}>Try again</Text></Pressable></View>}
        <View style={s.stats}><View><Text style={s.statNumber}>{tree?.companies.length ?? '—'}</Text><Text style={s.small}>Companies</Text></View><View><Text style={s.statNumber}>{tree?.projects.length ?? '—'}</Text><Text style={s.small}>Projects</Text></View><View><Text style={s.statNumber}>{tree?.projects.reduce((sum, project) => sum + project.task_count, 0) ?? '—'}</Text><Text style={s.small}>Open tasks</Text></View></View>
        <Pressable style={s.feature} disabled={!access} onPress={() => open('#/', 'Your workspace')}><Text style={s.featureTitle}>Your AI team, ready to work ↗</Text><Text style={s.small}>Open a company or project to chat, hear a briefing, and start work.</Text></Pressable>
        <TextInput accessibilityLabel="Search projects" placeholder="Search projects…" placeholderTextColor="#828c9a" value={search} onChangeText={setSearch} style={s.search} autoCorrect={false} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filters}>
          <Pressable style={[s.chip, company === null && s.selected]} onPress={() => setCompany(null)}><Text style={company === null ? s.chipActive : s.text}>All projects</Text></Pressable>
          {tree?.companies.map(item => <Pressable key={item.id} style={[s.chip, company === item.id && s.selected]} onPress={() => setCompany(item.id)}><Text style={company === item.id ? s.chipActive : s.text}>{item.name}</Text></Pressable>)}
        </ScrollView>
        {company !== null && <Pressable style={s.companyLink} onPress={() => open('#/company/' + company, tree?.companies.find(item => item.id === company)?.name || 'Company')}><Text style={s.link}>Open company · Chat & audio briefing →</Text></Pressable>}
        {projects.map(project => { const board = tree?.boards.find(item => item.id === project.parent_board_id); const companyName = tree?.companies.find(item => item.id === board?.company_id)?.name; return <Pressable accessibilityRole="button" accessibilityLabel={'Open project ' + project.name} key={project.id} style={s.project} onPress={() => open('#/board/' + project.id, project.name)}><View style={s.projectRow}><Text style={s.projectEmoji}>{project.emoji || '📁'}</Text><Text style={s.projectTitle}>{project.name}</Text><Text style={s.link}>↗</Text></View><Text style={s.small}>{[companyName, board?.name].filter(Boolean).join(' / ')}</Text>{!!project.description && <Text numberOfLines={2} style={s.description}>{project.description}</Text>}<Text style={s.taskCount}>{project.task_count} open tasks · Chat & audio</Text></Pressable>; })}
        {!busy && !projects.length && !!tree && <View style={s.empty}><Text style={s.text}>{search ? 'No projects match that search.' : 'Your next project starts here.'}</Text><Pressable onPress={() => open('#/', 'Your workspace')}><Text style={s.link}>Open workspace to create a project →</Text></Pressable></View>}
        <Pressable style={s.help} disabled={!access} onPress={() => open('#/tutorial', 'Help & tutorial')}><Text style={s.link}>Getting started & tutorial →</Text></Pressable>
      </ScrollView>
    </>}
    <Modal animationType="slide" visible={authOpen} presentationStyle="fullScreen" onRequestClose={() => setAuthOpen(false)}><SafeAreaView style={s.safe}><AuthView logo={<Image source={logo} accessibilityLabel="Boardly" style={s.authLogo} />} onDismiss={() => setAuthOpen(false)} /></SafeAreaView></Modal>
    <Modal transparent animationType="fade" visible={accountsOpen} onRequestClose={() => setAccountsOpen(false)}><Pressable style={s.scrim} onPress={() => setAccountsOpen(false)}><View style={s.sheet}><Text style={s.featureTitle}>Choose your account</Text>{access?.workspaces.map(account => <Pressable key={account.owner_id} style={s.accountChoice} onPress={() => { setAccountsOpen(false); if (account.owner_id === access.workspaceId) return; setCompany(null); setTree(null); setAccess(null); setOpened(null); setSelection(account.owner_id); }}><Text style={s.text}>{account.name}{account.owner ? ' · Owner' : ''}</Text></Pressable>)}<Pressable style={s.accountChoice} onPress={() => { setAccountsOpen(false); logout(); }}><Text style={s.link}>Sign out</Text></Pressable></View></Pressable></Modal>
  </SafeAreaView>;
}
export default function App() {
  if (!PUBLISHABLE_KEY) return <SafeAreaProvider><SafeAreaView style={s.welcome}><Text style={s.text}>Boardly sign-in is not configured in this build.</Text></SafeAreaView></SafeAreaProvider>;
  return <ClerkProvider publishableKey={PUBLISHABLE_KEY} tokenCache={tokenCache}><SafeAreaProvider><Boardly /></SafeAreaProvider></ClerkProvider>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: '#0c0e12' }, loader: { flex: 1 }, welcome: { flex: 1, backgroundColor: '#0c0e12', justifyContent: 'center', padding: 28, gap: 20 }, heroLogo: { width: 78, height: 78, borderRadius: 20 }, eyebrow: { color: '#b8f36b', fontSize: 11, fontWeight: '700', letterSpacing: 2 }, hero: { color: '#f5f5f6', fontSize: 43, lineHeight: 47, fontWeight: '800', letterSpacing: -1.7 }, subtitle: { color: '#a5adba', fontSize: 17, lineHeight: 26 }, primary: { backgroundColor: '#b8f36b', borderRadius: 16, padding: 19, marginTop: 14 }, primaryText: { color: '#11160d', textAlign: 'center', fontWeight: '700', fontSize: 16 }, small: { color: '#9ca6b5', fontSize: 12, lineHeight: 19 }, link: { color: '#b8f36b', fontSize: 14 }, text: { color: '#f5f5f6', fontSize: 14 }, header: { paddingHorizontal: 22, height: 62, flexDirection: 'row', alignItems: 'center', gap: 10 }, logo: { height: 33, width: 33, borderRadius: 9 }, brand: { flex: 1, fontSize: 23, color: '#fff', fontWeight: '700', letterSpacing: -0.8 }, content: { padding: 22, paddingBottom: 40, gap: 17 }, heading: { fontSize: 31, color: '#fff', fontWeight: '700', letterSpacing: -0.9, lineHeight: 37 }, account: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 13, borderWidth: 1, borderColor: '#2c333d', borderRadius: 20 }, stats: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, paddingRight: 14 }, statNumber: { fontSize: 31, fontWeight: '700', color: '#fff' }, feature: { padding: 20, borderWidth: 1, borderColor: '#3a4930', backgroundColor: '#171e15', borderRadius: 20, gap: 10 }, featureTitle: { color: '#fff', fontSize: 17, fontWeight: '600' }, search: { backgroundColor: '#171b22', borderRadius: 14, borderWidth: 1, borderColor: '#292f38', padding: 15, color: '#fff', fontSize: 15 }, filters: { gap: 8 }, chip: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 25, borderWidth: 1, borderColor: '#303641' }, selected: { backgroundColor: '#b8f36b', borderColor: '#b8f36b' }, chipActive: { color: '#17200f', fontWeight: '600', fontSize: 14 }, project: { padding: 18, gap: 10, borderRadius: 18, backgroundColor: '#15191f', borderWidth: 1, borderColor: '#282f38' }, projectRow: { flexDirection: 'row', alignItems: 'center', gap: 11 }, projectEmoji: { fontSize: 22 }, projectTitle: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '600' }, description: { color: '#a1aab7', fontSize: 13, lineHeight: 20 }, taskCount: { color: '#c9d6bc', fontSize: 12, marginTop: 4 }, companyLink: { paddingVertical: 4 }, help: { paddingVertical: 16 }, empty: { gap: 12, padding: 22 }, error: { padding: 16, borderRadius: 12, backgroundColor: '#3b2525', gap: 10 }, offline: { backgroundColor: '#332b16', padding: 12, color: '#eddaaa', fontSize: 12 }, scrim: { flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }, sheet: { backgroundColor: '#191e25', padding: 25, paddingBottom: 45, borderTopLeftRadius: 24, borderTopRightRadius: 24 }, accountChoice: { paddingVertical: 18, borderBottomWidth: 1, borderColor: '#303640' }, authLogo: { width: 76, height: 76, margin: 12, borderRadius: 20 } });
