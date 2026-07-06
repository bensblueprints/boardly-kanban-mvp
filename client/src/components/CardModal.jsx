import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { marked } from 'marked';
import {
  X, AlignLeft, CheckSquare, Tag, Clock, Paperclip, MessageSquare, History,
  Archive, Trash2, Plus, Pencil, Download, RotateCcw
} from 'lucide-react';
import { api } from '../api.js';

marked.setOptions({ breaks: true, gfm: true });

const LABEL_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

function Section({ icon: Icon, title, action, children }) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2.5">
        <Icon className="w-4 h-4 text-zinc-500" />
        <h3 className="font-semibold text-sm">{title}</h3>
        <div className="flex-1" />
        {action}
      </div>
      <div className="pl-6">{children}</div>
    </section>
  );
}

export default function CardModal({ cardId, board, onClose, onBoardChange }) {
  const [card, setCard] = useState(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [comment, setComment] = useState('');
  const [labelPicker, setLabelPicker] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[4]);
  const [newItemFor, setNewItemFor] = useState(null);
  const [newItemText, setNewItemText] = useState('');
  const fileRef = useRef(null);

  const load = () => api.get(`/api/cards/${cardId}`).then((c) => { setCard(c); setDesc(c.description); });
  useEffect(() => { load(); }, [cardId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest('textarea, input')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!card) return null;

  const listName = board.lists.find((l) => l.id === card.list_id)?.name || 'a list';
  const overdue = card.due_date && new Date(card.due_date) < new Date();

  async function patch(fields) {
    const updated = await api.patch(`/api/cards/${card.id}`, fields);
    setCard(updated);
    onBoardChange();
  }

  async function saveDesc() {
    await patch({ description: desc });
    setEditingDesc(false);
  }

  async function toggleLabel(label) {
    const has = card.labels.some((l) => l.id === label.id);
    if (has) await api.del(`/api/cards/${card.id}/labels/${label.id}`);
    else await api.post(`/api/cards/${card.id}/labels/${label.id}`);
    load();
    onBoardChange();
  }

  async function createLabel(e) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    const l = await api.post(`/api/boards/${board.id}/labels`, { name: newLabel.trim(), color: newLabelColor });
    await api.post(`/api/cards/${card.id}/labels/${l.id}`);
    setNewLabel('');
    load();
    onBoardChange();
  }

  async function addChecklist() {
    await api.post(`/api/cards/${card.id}/checklists`, { title: 'Checklist' });
    load();
  }

  async function addItem(clId) {
    if (!newItemText.trim()) { setNewItemFor(null); return; }
    await api.post(`/api/checklists/${clId}/items`, { text: newItemText.trim() });
    setNewItemText('');
    load();
    onBoardChange();
  }

  async function toggleItem(item) {
    await api.patch(`/api/checklist-items/${item.id}`, { done: !item.done });
    load();
    onBoardChange();
  }

  async function addComment(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    await api.post(`/api/cards/${card.id}/comments`, { body: comment.trim() });
    setComment('');
    load();
    onBoardChange();
  }

  async function uploadFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    await api.post(`/api/cards/${card.id}/attachments`, form);
    load();
    onBoardChange();
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 sm:p-10"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 16, scale: 0.98 }}
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
      >
        {/* header */}
        <div className="flex items-start gap-3 p-5 pb-2">
          <div className="flex-1 min-w-0">
            <input
              key={card.id + card.title}
              defaultValue={card.title}
              onBlur={(e) => e.target.value.trim() && e.target.value !== card.title && patch({ title: e.target.value.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
              className="w-full bg-transparent text-lg font-bold outline-none rounded-md px-1.5 py-0.5 -ml-1.5 hover:bg-zinc-800/60 focus:bg-zinc-950"
            />
            <p className="text-xs text-zinc-500 mt-0.5 px-0">
              in <span className="text-zinc-400">{listName}</span>
              {!!card.archived && <span className="ml-2 text-amber-400">• Archived</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-500 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          {/* labels + due */}
          <div className="flex flex-wrap items-center gap-2 mb-5 pl-0">
            {card.labels.map((l) => (
              <span key={l.id} className="text-xs font-medium px-2.5 py-1 rounded-md text-white" style={{ background: l.color }}>
                {l.name}
              </span>
            ))}
            <div className="relative">
              <button onClick={() => setLabelPicker(!labelPicker)}
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
                <Tag className="w-3 h-3" /> Labels
              </button>
              {labelPicker && (
                <div className="absolute left-0 mt-2 w-64 bg-zinc-950 border border-zinc-800 rounded-xl p-3 shadow-2xl z-20">
                  <div className="space-y-1 mb-3">
                    {board.labels.map((l) => {
                      const active = card.labels.some((cl) => cl.id === l.id);
                      return (
                        <button key={l.id} onClick={() => toggleLabel(l)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm ${active ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}>
                          <span className="w-4 h-4 rounded" style={{ background: l.color }} />
                          <span className="flex-1 text-left text-zinc-200">{l.name}</span>
                          {active && <span className="text-indigo-400 text-xs">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                  <form onSubmit={createLabel}>
                    <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New label…"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500" />
                    <div className="flex gap-1.5 mt-2">
                      {LABEL_COLORS.map((c) => (
                        <button type="button" key={c} onClick={() => setNewLabelColor(c)}
                          className={`w-5 h-5 rounded ${newLabelColor === c ? 'ring-2 ring-white' : ''}`} style={{ background: c }} />
                      ))}
                    </div>
                    <button className="w-full mt-2 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold rounded-lg py-1.5">
                      Create + add
                    </button>
                  </form>
                </div>
              )}
            </div>
            <label className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border cursor-pointer ${overdue ? 'border-rose-500/50 text-rose-300 bg-rose-500/10' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}`}>
              <Clock className="w-3 h-3" />
              <input
                type="datetime-local"
                value={card.due_date || ''}
                onChange={(e) => patch({ due_date: e.target.value || null })}
                className="bg-transparent outline-none [color-scheme:dark] w-40"
              />
              {card.due_date && (
                <span onClick={(e) => { e.preventDefault(); patch({ due_date: null }); }} className="hover:text-rose-300">✕</span>
              )}
            </label>
          </div>

          {/* description */}
          <Section
            icon={AlignLeft}
            title="Description"
            action={!editingDesc && (
              <button onClick={() => setEditingDesc(true)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          >
            {editingDesc ? (
              <div>
                <textarea
                  autoFocus rows={6} value={desc} onChange={(e) => setDesc(e.target.value)}
                  placeholder="Write markdown… **bold**, `code`, - lists, [links](https://)"
                  className="w-full bg-zinc-950 border border-indigo-500/50 rounded-lg px-3 py-2 text-sm outline-none resize-y font-mono"
                />
                <div className="flex gap-2 mt-1.5">
                  <button onClick={saveDesc} className="bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold px-3 py-1.5 rounded-md">Save</button>
                  <button onClick={() => { setDesc(card.description); setEditingDesc(false); }}
                    className="text-xs text-zinc-500 hover:text-zinc-200 px-2">Cancel</button>
                </div>
              </div>
            ) : card.description.trim() ? (
              <div className="md-body" onClick={() => setEditingDesc(true)}
                dangerouslySetInnerHTML={{ __html: marked.parse(card.description) }} />
            ) : (
              <button onClick={() => setEditingDesc(true)}
                className="w-full text-left text-sm text-zinc-600 bg-zinc-950/70 hover:bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-3">
                Add a more detailed description… (markdown supported)
              </button>
            )}
          </Section>

          {/* checklists */}
          <Section
            icon={CheckSquare}
            title="Checklists"
            action={
              <button onClick={addChecklist} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
                <Plus className="w-3 h-3" /> Add checklist
              </button>
            }
          >
            {card.checklists.length === 0 && <p className="text-sm text-zinc-600">No checklists yet.</p>}
            {card.checklists.map((cl) => {
              const total = cl.items.length;
              const done = cl.items.filter((i) => i.done).length;
              const pct = total ? Math.round((done / total) * 100) : 0;
              return (
                <div key={cl.id} className="mb-4">
                  <div className="flex items-center gap-2">
                    <input
                      key={cl.id + cl.title}
                      defaultValue={cl.title}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== cl.title &&
                        api.patch(`/api/checklists/${cl.id}`, { title: e.target.value.trim() }).then(load)}
                      className="font-medium text-sm bg-transparent outline-none rounded px-1 -ml-1 hover:bg-zinc-800/60 focus:bg-zinc-950 flex-1"
                    />
                    <button onClick={() => api.del(`/api/checklists/${cl.id}`).then(() => { load(); onBoardChange(); })}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-600 hover:text-rose-400" title="Delete checklist">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[11px] text-zinc-500 w-8">{pct}%</span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div layout className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                        animate={{ width: `${pct}%` }} transition={{ type: 'tween', duration: 0.25 }} />
                    </div>
                  </div>
                  <div className="mt-2 space-y-1">
                    {cl.items.map((item) => (
                      <div key={item.id} className="group flex items-center gap-2.5 px-1 py-1 rounded-lg hover:bg-zinc-800/50">
                        <input type="checkbox" checked={!!item.done} onChange={() => toggleItem(item)}
                          className="w-4 h-4 rounded accent-indigo-500 cursor-pointer" />
                        <span className={`flex-1 text-sm ${item.done ? 'line-through text-zinc-600' : 'text-zinc-200'}`}>{item.text}</span>
                        <button onClick={() => api.del(`/api/checklist-items/${item.id}`).then(() => { load(); onBoardChange(); })}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-600 hover:text-rose-400">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {newItemFor === cl.id ? (
                    <div className="mt-1.5 flex gap-2">
                      <input autoFocus value={newItemText} onChange={(e) => setNewItemText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addItem(cl.id); if (e.key === 'Escape') setNewItemFor(null); }}
                        placeholder="Item text… (Enter)"
                        className="flex-1 bg-zinc-950 border border-indigo-500/50 rounded-lg px-2.5 py-1.5 text-sm outline-none" />
                      <button onClick={() => addItem(cl.id)} className="bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold px-3 rounded-lg">Add</button>
                    </div>
                  ) : (
                    <button onClick={() => { setNewItemFor(cl.id); setNewItemText(''); }}
                      className="mt-1 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 px-1 py-1">
                      <Plus className="w-3 h-3" /> Add item
                    </button>
                  )}
                </div>
              );
            })}
          </Section>

          {/* attachments */}
          <Section
            icon={Paperclip}
            title="Attachments"
            action={
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
                <Plus className="w-3 h-3" /> Upload file
              </button>
            }
          >
            <input ref={fileRef} type="file" className="hidden"
              onChange={(e) => { uploadFile(e.target.files[0]); e.target.value = ''; }} />
            {card.attachments.length === 0 && <p className="text-sm text-zinc-600">No attachments.</p>}
            <div className="space-y-2">
              {card.attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-3 bg-zinc-950/70 border border-zinc-800 rounded-lg px-3 py-2">
                  {/^image\//.test(a.mime)
                    ? <img src={`/uploads/${a.filename}`} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
                    : <div className="w-10 h-10 rounded bg-zinc-800 flex items-center justify-center shrink-0"><Paperclip className="w-4 h-4 text-zinc-500" /></div>}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{a.original_name}</p>
                    <p className="text-[11px] text-zinc-600">{(a.size / 1024).toFixed(1)} KB</p>
                  </div>
                  <a href={`/uploads/${a.filename}`} download={a.original_name}
                    className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200" title="Download">
                    <Download className="w-4 h-4" />
                  </a>
                  <button onClick={() => api.del(`/api/attachments/${a.id}`).then(() => { load(); onBoardChange(); })}
                    className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-rose-400" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </Section>

          {/* comments */}
          <Section icon={MessageSquare} title="Comments">
            <form onSubmit={addComment} className="mb-3">
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(e); } }}
                placeholder="Write a comment… (Enter to post)"
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-lg px-3 py-2 text-sm outline-none resize-none transition-colors" />
            </form>
            <div className="space-y-3">
              {card.comments.map((cm) => (
                <div key={cm.id} className="group flex gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-bold shrink-0">
                    {cm.author[0]?.toUpperCase() || 'A'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-500">
                      <span className="font-semibold text-zinc-300">{cm.author}</span>
                      {' · '}{new Date(cm.created_at + 'Z').toLocaleString()}
                      <button onClick={() => api.del(`/api/comments/${cm.id}`).then(() => { load(); onBoardChange(); })}
                        className="ml-2 opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-400">delete</button>
                    </p>
                    <p className="text-sm text-zinc-200 mt-0.5 whitespace-pre-wrap">{cm.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* activity */}
          <Section icon={History} title="Activity">
            <div className="space-y-2">
              {card.activity.length === 0 && <p className="text-sm text-zinc-600">No activity yet.</p>}
              {card.activity.map((a) => (
                <div key={a.id} className="text-xs text-zinc-500">
                  <span className="text-zinc-400">{a.detail || a.action}</span>
                  {' — '}{new Date(a.created_at + 'Z').toLocaleString()}
                </div>
              ))}
            </div>
          </Section>

          {/* footer actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
            {card.archived ? (
              <button onClick={() => patch({ archived: false })}
                className="flex items-center gap-1.5 text-sm text-emerald-300 hover:bg-emerald-500/10 px-3 py-1.5 rounded-lg">
                <RotateCcw className="w-4 h-4" /> Restore card
              </button>
            ) : (
              <button onClick={() => { patch({ archived: true }).then(onClose); }}
                className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-amber-300 hover:bg-amber-500/10 px-3 py-1.5 rounded-lg">
                <Archive className="w-4 h-4" /> Archive card
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={() => { if (confirm('Permanently delete this card?')) api.del(`/api/cards/${card.id}`).then(() => { onBoardChange(); onClose(); }); }}
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 px-3 py-1.5 rounded-lg">
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
