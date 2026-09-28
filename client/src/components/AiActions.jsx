import React from 'react';
import { Headphones, MessageSquare } from 'lucide-react';

// Keep the two ways to talk to AI together at every workspace entry point.
export default function AiActions({ onChat, onAudio, chatLabel = 'Chat with AI', audioDisabled = false, audioTitle = 'Hear priorities, blockers and next steps' }) {
  return <div role="group" aria-label="AI actions" className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
    <button type="button" onClick={onChat} className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-sm"><MessageSquare size={16} className="shrink-0" />{chatLabel}</button>
    <button type="button" onClick={onAudio} disabled={audioDisabled} title={audioDisabled ? 'Audio requires Editor access to this project' : audioTitle} className="flex items-center gap-2 rounded-lg border border-indigo-400 text-indigo-100 hover:bg-indigo-500/10 px-3 py-2 text-sm disabled:opacity-40"><Headphones size={16} className="shrink-0" />Audio briefing</button>
  </div>;
}
