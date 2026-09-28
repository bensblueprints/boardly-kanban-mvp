import React, {useState} from 'react';
import {Download} from 'lucide-react';

const release = 'https://github.com/bensblueprints/boardly-kanban-mvp/releases/download/v1.9.0/';
export const desktopDownloads = [
  ['Windows', 'Windows installer', release + 'Boardly.Setup.1.9.0.exe'],
  ['Mac', 'Apple Silicon · macOS', release + 'Boardly-1.9.0-arm64.dmg'],
  ['Linux', 'AppImage · x64', release + 'Boardly-1.9.0.AppImage'],
  ['Linux', 'Debian / Ubuntu · x64', release + 'boardly_1.9.0_amd64.deb'],
];

export function detectDesktopPlatform(agent = '') {
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return '';
  if (/Windows/i.test(agent)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'Mac';
  if (/Linux/i.test(agent)) return 'Linux';
  return '';
}

const instructions = {
  Windows: 'Download the EXE and open it to follow the installer. Windows installation and publisher-signature verification remain unverified. If Windows blocks the installer, use the web app while the release is checked.',
  Mac: 'This DMG is for Apple Silicon only; no Intel Mac installer is published in this release. The released app failed strict code-signature verification. Use the web app until a corrected release is available. Do not disable Gatekeeper to install it.',
  Linux: 'These packages require an x64 computer. On Debian or Ubuntu, open the DEB with your package installer. For AppImage, allow the downloaded file to run as a program in its file properties, then open it. If your distribution cannot run it, use the web app.',
};

export default function DesktopDownloads({developerAccess = false, onConnect}) {
  const [platform, setPlatform] = useState(() => detectDesktopPlatform(navigator.userAgent));
  const downloads = desktopDownloads.filter(([name]) => !platform || platform === name);
  return <section aria-label="Desktop downloads" className="space-y-5 min-w-0">
    <div><h3 className="font-semibold">Boardly for your desktop</h3><p className="text-sm text-zinc-400 mt-1">Published desktop release: v1.9.0. These older apps store boards locally. Installing one does not sign you into your Boardly cloud account.</p></div>
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 space-y-2"><h4 className="font-medium">Use your current cloud workspace</h4><p className="text-sm text-zinc-300">Open Boardly on the web and sign in with your Boardly account. Choose the same workspace account on each computer to access your cloud projects.</p><a href="https://boardlyagent.com/app" target="_blank" rel="noopener noreferrer" className="inline-block rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm">Open Boardly on the web</a></div>
    <label className="block text-sm">Choose your desktop platform<select aria-label="Desktop platform" value={platform} onChange={e=>setPlatform(e.target.value)} className="block mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2"><option value="">All desktop platforms</option>{['Windows','Mac','Linux'].map(name=><option key={name} value={name}>{name}</option>)}</select></label>
    <p className="text-xs text-zinc-400">Check your computer’s processor before downloading. Browser detection cannot confirm installer compatibility. On a phone or tablet, open this page on the computer where you want to install Boardly.</p>
    <div className="grid sm:grid-cols-2 gap-3">{downloads.map(([name, detail, href])=><article key={href} className="min-w-0 rounded-xl border border-zinc-700 p-4 space-y-3"><h4 className="font-semibold">{name}</h4><p className="text-xs text-zinc-400">{detail} · v1.9.0</p><p className={'text-sm '+(name==='Mac'?'text-amber-200':'text-zinc-300')}>{instructions[name]}</p><a href={href} className="inline-flex items-center gap-2 text-sm text-indigo-300 underline"><Download size={16} className="shrink-0"/>{name==='Mac'?'Download legacy Mac DMG':name==='Windows'?'Download Windows installer':detail.startsWith('AppImage')?'Download Linux AppImage':'Download Linux DEB'}</a></article>)}</div>
    <a href="https://github.com/bensblueprints/boardly-kanban-mvp/releases/tag/v1.9.0" target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-indigo-300 underline">View published release and assets</a>
    <div className="rounded-xl border border-zinc-700 p-4 space-y-3"><h4 className="font-medium">Cloud sign-in and desktop sync</h4><p className="text-sm text-zinc-300">Customer desktop account linking and cloud sync are not available yet. Signing in on the web does not synchronize an existing local installation. Keep using the web app for your cloud work.</p>{developerAccess&&<><p className="text-sm text-zinc-400">The platform owner has a separate legacy sync setup. Before connecting, back up local boards and confirm the destination account. Existing local boards are merged by their identifiers. Project conversations, project files and company settings remain in the cloud.</p><button onClick={onConnect} className="rounded-lg border border-zinc-600 px-4 py-2 text-sm hover:bg-zinc-800">Open owner desktop sync setup</button></>}</div>
  </section>;
}
