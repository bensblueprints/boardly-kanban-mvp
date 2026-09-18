import React, {useSyncExternalStore} from 'react';
import {Pause, Play} from 'lucide-react';

const storageKey = 'boardly.activity-motion';
const changeEvent = 'boardly:activity-motion';
let sessionPreference;

function preference() {
  if (sessionPreference !== undefined) return sessionPreference;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'on' || saved === 'off') return saved === 'on';
  } catch { /* Keep the control usable when browser storage is unavailable. */ }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function subscribe(update) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const storageChanged = event => {
    if (event.key === storageKey || event.key === null) {
      sessionPreference = undefined;
      update();
    }
  };
  media.addEventListener('change', update);
  window.addEventListener(changeEvent, update);
  window.addEventListener('storage', storageChanged);
  return () => {
    media.removeEventListener('change', update);
    window.removeEventListener(changeEvent, update);
    window.removeEventListener('storage', storageChanged);
  };
}

export function useActivityMotion() {
  const enabled = useSyncExternalStore(subscribe, preference, () => false);
  const setEnabled = value => {
    sessionPreference = value;
    try { window.localStorage.setItem(storageKey, value ? 'on' : 'off'); } catch {}
    window.dispatchEvent(new Event(changeEvent));
  };
  return [enabled, setEnabled];
}

export default function ActivityMotion({enabled, onChange}) {
  const Icon = enabled ? Pause : Play;
  return <button type="button" role="switch" aria-label="Moving activity lines" aria-checked={enabled}
    onClick={() => onChange(!enabled)}
    className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
    title={enabled ? 'Pause activity animations' : 'Animate active agents, including when reduced motion is enabled'}>
    <Icon size={15} aria-hidden="true"/>Moving lines: {enabled ? 'On' : 'Off'}
  </button>;
}
