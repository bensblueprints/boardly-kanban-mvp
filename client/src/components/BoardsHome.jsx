import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KanbanSquare, Plus, Star, Trash2, LogOut, Upload, Layers, StickyNote } from 'lucide-react';
import { api } from '../api.js';

const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#64748b'];
const EMOJIS = ['📋', '🚀', '🎯', '💼', '🛠️', '🎨', '📦', '🧠', '🔥', '🌱', '🏠', '✍️'];

export default function BoardsHome({ onOpen, onLogout }) {
  const [boards, setBoards] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const importRef = useRef(null);

  const load = () => api.get('/api/boards').then(setBoards);
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const b = await api.post('/api/boards', { name: name.trim(), color, emoji });
    setName('');
    setCreating(false);
    onOpen(b.id);
  }

  async function toggleStar(b, e) {
    e.stopPropagation();
    await api.patch(`/api/boards/${b.id}`, { starred: !b.starred });
    load();
  }

  async function remove(b, e) {
    e.stopPropagation();
    if (!confirm(`Delete board "${b.name}" and everything on it? This cannot be undone.`)) return;
    await api.del(`/api/boards/${b.id}`);
    load();
  }

  async function importBoard(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const b = await api.post('/api/boards/import', data);
      onOpen(b.id);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <KanbanSquare className="w-6 h-6 text-indigo-400" />
            <span className="font-bold text-lg">Boardly</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => importRef.current?.click()}
              className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <Upload className="w-4 h-4" /> Import board
            </button>
            <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
              onChange={(e) => { importBoard(e.target.files[0]); e.target.value = ''; }} />
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 px-3 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold mb-1">Your boards</h1>
        <p className="text-sm text-zinc-500 mb-8">Every project, one flat price. Zero per-seat math.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {(boards || []).map((b) => (
              <motion.button
                key={b.id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                onClick={() => onOpen(b.id)}
                className="group relative text-left rounded-2xl border border-zinc-800 bg-zinc-900 hover:border-zinc-700 overflow-hidden transition-colors"
              >
                <div className="h-2" style={{ background: b.color }} />
                <div className="p-5">
                  <div className="flex items-start justify-between">
                    <span className="text-3xl">{b.emoji}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span onClick={(e) => toggleStar(b, e)}
                        className="p-1.5 rounded-md hover:bg-zinc-800 cursor-pointer" title="Star board">
                        <Star className={`w-4 h-4 ${b.starred ? 'text-amber-400 fill-amber-400' : 'text-zinc-500'}`} />
                      </span>
                      <span onClick={(e) => remove(b, e)}
                        className="p-1.5 rounded-md hover:bg-zinc-800 cursor-pointer" title="Delete board">
                        <Trash2 className="w-4 h-4 text-zinc-500 hover:text-rose-400" />
                      </span>
                    </div>
                    {!!b.starred && (
                      <Star className="w-4 h-4 text-amber-400 fill-amber-400 absolute top-5 right-5 group-hover:opacity-0 transition-opacity" />
                    )}
                  </div>
                  <h2 className="font-semibold mt-3 truncate">{b.name}</h2>
                  <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                    <span className="flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> {b.list_count} lists</span>
                    <span className="flex items-center gap-1"><StickyNote className="w-3.5 h-3.5" /> {b.card_count} cards</span>
                  </div>
                </div>
              </motion.button>
            ))}
          </AnimatePresence>

          {creating ? (
            <motion.form
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              onSubmit={create}
              className="rounded-2xl border border-indigo-500/50 bg-zinc-900 p-5"
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
                placeholder="Board name…"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
              <div className="flex flex-wrap gap-1.5 mt-3">
                {COLORS.map((c) => (
                  <button key={c} type="button" onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-white scale-110' : 'hover:scale-110'}`}
                    style={{ background: c }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {EMOJIS.map((em) => (
                  <button key={em} type="button" onClick={() => setEmoji(em)}
                    className={`w-8 h-8 rounded-lg text-lg flex items-center justify-center ${emoji === em ? 'bg-indigo-500/25 ring-1 ring-indigo-400' : 'hover:bg-zinc-800'}`}>
                    {em}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 mt-4">
                <button className="bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors">Create</button>
                <button type="button" onClick={() => setCreating(false)}
                  className="text-sm text-zinc-400 hover:text-zinc-100 px-3 py-1.5">Cancel</button>
              </div>
            </motion.form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="rounded-2xl border border-dashed border-zinc-800 hover:border-indigo-500/60 hover:bg-indigo-500/5 min-h-36 flex flex-col items-center justify-center gap-2 text-zinc-500 hover:text-indigo-300 transition-colors"
            >
              <Plus className="w-6 h-6" />
              <span className="text-sm font-medium">New board</span>
            </button>
          )}
        </div>

        {boards && boards.length === 0 && !creating && (
          <p className="text-zinc-600 text-sm mt-8">No boards yet — create your first one above.</p>
        )}
      </main>
    </div>
  );
}
