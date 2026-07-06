import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, Plus, Star, Search, Filter, Download, Upload, Archive,
  History, X, Clock, MessageSquare, Paperclip, CheckSquare, AlignLeft, RotateCcw
} from 'lucide-react';
import { api } from '../api.js';
import CardModal from './CardModal.jsx';

function dueState(due) {
  if (!due) return null;
  const d = new Date(due);
  if (isNaN(d)) return null;
  const now = new Date();
  if (d < now) return 'overdue';
  if (d - now < 24 * 3600 * 1000) return 'soon';
  return 'later';
}

const DUE_STYLES = {
  overdue: 'bg-rose-500/20 text-rose-300 border border-rose-500/40',
  soon: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  later: 'bg-zinc-800 text-zinc-400 border border-zinc-700'
};

function CardChip({ card, onClick }) {
  const due = dueState(card.due_date);
  const cl = card.checklist || { total: 0, done: 0 };
  return (
    <div
      onClick={onClick}
      className="bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-xl p-3 cursor-pointer shadow-sm transition-colors"
    >
      {card.labels?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {card.labels.map((l) => (
            <span key={l.id} className="h-2 w-8 rounded-full" style={{ background: l.color }} title={l.name} />
          ))}
        </div>
      )}
      <p className="text-sm text-zinc-100 leading-snug">{card.title}</p>
      {(due || cl.total > 0 || card.comment_count > 0 || card.attachment_count > 0 || card.has_description) && (
        <div className="flex flex-wrap items-center gap-2 mt-2.5 text-[11px] text-zinc-500">
          {due && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md ${DUE_STYLES[due]}`}>
              <Clock className="w-3 h-3" />
              {new Date(card.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
          {cl.total > 0 && (
            <span className={`flex items-center gap-1 ${cl.done === cl.total ? 'text-emerald-400' : ''}`}>
              <CheckSquare className="w-3 h-3" /> {cl.done}/{cl.total}
            </span>
          )}
          {card.has_description && <AlignLeft className="w-3 h-3" />}
          {card.comment_count > 0 && <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" /> {card.comment_count}</span>}
          {card.attachment_count > 0 && <span className="flex items-center gap-1"><Paperclip className="w-3 h-3" /> {card.attachment_count}</span>}
        </div>
      )}
      {cl.total > 0 && (
        <div className="h-1 bg-zinc-800 rounded-full mt-2 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${cl.done === cl.total ? 'bg-emerald-500' : 'bg-indigo-500'}`}
            style={{ width: `${(cl.done / cl.total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function AddCard({ listId, onAdded, autoFocus }) {
  const [open, setOpen] = useState(!!autoFocus);
  const [title, setTitle] = useState('');
  useEffect(() => { if (autoFocus) setOpen(true); }, [autoFocus]);

  async function add() {
    if (!title.trim()) { setOpen(false); return; }
    await api.post(`/api/lists/${listId}/cards`, { title: title.trim() });
    setTitle('');
    onAdded();
  }
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 rounded-lg px-2.5 py-2 transition-colors">
        <Plus className="w-4 h-4" /> Add a card
      </button>
    );
  }
  return (
    <div>
      <textarea
        autoFocus rows={2} value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Card title… (Enter to add)"
        className="w-full bg-zinc-950 border border-indigo-500/50 rounded-lg px-2.5 py-2 text-sm outline-none resize-none"
      />
      <div className="flex gap-2 mt-1">
        <button onClick={add} className="bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold px-3 py-1.5 rounded-md">Add card</button>
        <button onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-200 px-2">Cancel</button>
      </div>
    </div>
  );
}

export default function BoardView({ boardId, onBack }) {
  const [board, setBoard] = useState(null);
  const [openCardId, setOpenCardId] = useState(null);
  const [query, setQuery] = useState('');
  const [labelFilter, setLabelFilter] = useState(null);
  const [dueFilter, setDueFilter] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [panel, setPanel] = useState(null); // 'activity' | 'archived' | null
  const [activity, setActivity] = useState([]);
  const [archived, setArchived] = useState({ lists: [], cards: [] });
  const [addingList, setAddingList] = useState(false);
  const [listName, setListName] = useState('');
  const [quickAddList, setQuickAddList] = useState(null);
  const searchRef = useRef(null);
  const importRef = useRef(null);

  const load = useCallback(() => api.get(`/api/boards/${boardId}`).then(setBoard).catch(() => onBack()), [boardId]);
  useEffect(() => { load(); }, [load]);

  // keyboard shortcuts: n = new card (first list), / = focus search
  useEffect(() => {
    function onKey(e) {
      if (openCardId || e.target.closest('input, textarea, [contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'n' && board?.lists?.length) { e.preventDefault(); setQuickAddList(board.lists[0].id); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [board, openCardId]);

  const filtering = query || labelFilter || dueFilter;
  const visibleLists = useMemo(() => {
    if (!board) return [];
    if (!filtering) return board.lists;
    const now = new Date();
    return board.lists.map((l) => ({
      ...l,
      cards: l.cards.filter((c) => {
        if (query && !c.title.toLowerCase().includes(query.toLowerCase())) return false;
        if (labelFilter && !c.labels.some((lb) => lb.id === labelFilter)) return false;
        if (dueFilter === 'overdue' && !(c.due_date && new Date(c.due_date) < now)) return false;
        if (dueFilter === 'week' && !(c.due_date && new Date(c.due_date) - now < 7 * 86400000 && new Date(c.due_date) - now > -86400000)) return false;
        if (dueFilter === 'none' && c.due_date) return false;
        return true;
      })
    }));
  }, [board, query, labelFilter, dueFilter]);

  async function onDragEnd(result) {
    const { destination, source, draggableId, type } = result;
    if (!destination || !board) return;

    if (type === 'list') {
      if (destination.index === source.index) return;
      const order = board.lists.map((l) => l.id);
      const [moved] = order.splice(source.index, 1);
      order.splice(destination.index, 0, moved);
      setBoard({ ...board, lists: order.map((id) => board.lists.find((l) => l.id === id)) });
      await api.post(`/api/boards/${boardId}/lists/reorder`, { order });
      return;
    }

    // card move — optimistic update then persist
    const cardId = Number(draggableId.replace('card-', ''));
    const fromListId = Number(source.droppableId.replace('list-', ''));
    const toListId = Number(destination.droppableId.replace('list-', ''));
    if (fromListId === toListId && source.index === destination.index) return;

    const lists = board.lists.map((l) => ({ ...l, cards: [...l.cards] }));
    const from = lists.find((l) => l.id === fromListId);
    const to = lists.find((l) => l.id === toListId);
    const [card] = from.cards.splice(source.index, 1);
    to.cards.splice(destination.index, 0, card);
    setBoard({ ...board, lists });
    await api.post(`/api/cards/${cardId}/move`, { list_id: toListId, position: destination.index });
    load();
  }

  async function addList(e) {
    e.preventDefault();
    if (!listName.trim()) { setAddingList(false); return; }
    await api.post(`/api/boards/${boardId}/lists`, { name: listName.trim() });
    setListName('');
    load();
  }

  async function archiveList(list) {
    await api.patch(`/api/lists/${list.id}`, { archived: true });
    load();
  }

  async function renameList(list, name) {
    if (!name.trim() || name === list.name) return;
    await api.patch(`/api/lists/${list.id}`, { name: name.trim() });
    load();
  }

  async function openPanel(which) {
    setPanel(which);
    if (which === 'activity') setActivity(await api.get(`/api/boards/${boardId}/activity`));
    if (which === 'archived') setArchived(await api.get(`/api/boards/${boardId}/archived`));
  }

  async function restoreCard(id) {
    await api.patch(`/api/cards/${id}`, { archived: false });
    setArchived(await api.get(`/api/boards/${boardId}/archived`));
    load();
  }
  async function restoreList(id) {
    await api.patch(`/api/lists/${id}`, { archived: false });
    setArchived(await api.get(`/api/boards/${boardId}/archived`));
    load();
  }

  async function exportBoard() {
    const data = await api.get(`/api/boards/${boardId}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${board.name.replace(/[^\w\- ]+/g, '')}-boardly-export.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importBoard(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const b = await api.post('/api/boards/import', data);
      location.hash = `#/board/${b.id}`;
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  }

  if (!board) return <div className="h-full flex items-center justify-center text-zinc-600">Loading…</div>;

  return (
    <div className="h-full flex flex-col" style={{ background: `linear-gradient(180deg, ${board.color}22, transparent 240px)` }}>
      {/* header */}
      <header className="shrink-0 px-4 py-3 flex items-center gap-2 flex-wrap border-b border-zinc-800/60 bg-zinc-950/70 backdrop-blur">
        <button onClick={onBack} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100" title="All boards">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-xl">{board.emoji}</span>
        <input
          key={board.id + board.name}
          defaultValue={board.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== board.name &&
            api.patch(`/api/boards/${board.id}`, { name: e.target.value.trim() }).then(load)}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
          className="font-bold text-lg bg-transparent outline-none rounded-md px-1.5 py-0.5 hover:bg-zinc-800/60 focus:bg-zinc-900 max-w-56"
        />
        <button onClick={() => api.patch(`/api/boards/${board.id}`, { starred: !board.starred }).then(load)}
          className="p-2 rounded-lg hover:bg-zinc-800" title="Star board">
          <Star className={`w-4 h-4 ${board.starred ? 'text-amber-400 fill-amber-400' : 'text-zinc-500'}`} />
        </button>

        <div className="flex-1" />

        <div className="relative">
          <Search className="w-4 h-4 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.target.blur())}
            placeholder="Search cards…  ( / )"
            className="bg-zinc-900 border border-zinc-800 focus:border-indigo-500 rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none w-52 transition-colors"
          />
        </div>

        <div className="relative">
          <button onClick={() => setFilterOpen(!filterOpen)}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${labelFilter || dueFilter ? 'border-indigo-500/60 text-indigo-300 bg-indigo-500/10' : 'border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}`}>
            <Filter className="w-4 h-4" /> Filter
          </button>
          <AnimatePresence>
            {filterOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                className="absolute right-0 mt-2 w-60 bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-2xl z-30">
                <p className="text-xs font-semibold text-zinc-500 uppercase mb-2">Labels</p>
                <div className="space-y-1">
                  {board.labels.length === 0 && <p className="text-xs text-zinc-600">No labels yet — add them from a card.</p>}
                  {board.labels.map((l) => (
                    <button key={l.id} onClick={() => setLabelFilter(labelFilter === l.id ? null : l.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm ${labelFilter === l.id ? 'bg-indigo-500/15 text-indigo-200' : 'hover:bg-zinc-800 text-zinc-300'}`}>
                      <span className="w-3 h-3 rounded-full" style={{ background: l.color }} />
                      {l.name}
                    </button>
                  ))}
                </div>
                <p className="text-xs font-semibold text-zinc-500 uppercase mt-3 mb-2">Due date</p>
                {[['overdue', 'Overdue'], ['week', 'Due this week'], ['none', 'No due date']].map(([k, lbl]) => (
                  <button key={k} onClick={() => setDueFilter(dueFilter === k ? null : k)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg text-sm ${dueFilter === k ? 'bg-indigo-500/15 text-indigo-200' : 'hover:bg-zinc-800 text-zinc-300'}`}>
                    {lbl}
                  </button>
                ))}
                {(labelFilter || dueFilter) && (
                  <button onClick={() => { setLabelFilter(null); setDueFilter(null); }}
                    className="w-full mt-2 text-xs text-zinc-500 hover:text-zinc-200 py-1">Clear filters</button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button onClick={() => openPanel('activity')} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100" title="Board activity">
          <History className="w-4 h-4" />
        </button>
        <button onClick={() => openPanel('archived')} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100" title="Archived items">
          <Archive className="w-4 h-4" />
        </button>
        <button onClick={exportBoard} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100" title="Export board as JSON">
          <Download className="w-4 h-4" />
        </button>
        <button onClick={() => importRef.current?.click()} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100" title="Import board from JSON">
          <Upload className="w-4 h-4" />
        </button>
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { importBoard(e.target.files[0]); e.target.value = ''; }} />
      </header>

      {/* lists */}
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="board" direction="horizontal" type="list">
          {(provided) => (
            <div ref={provided.innerRef} {...provided.droppableProps}
              className="flex-1 overflow-x-auto overflow-y-hidden flex items-start gap-3 p-4">
              {visibleLists.map((list, li) => (
                <Draggable key={list.id} draggableId={`listwrap-${list.id}`} index={li} isDragDisabled={!!filtering}>
                  {(lp) => (
                    <div ref={lp.innerRef} {...lp.draggableProps}
                      className="w-72 shrink-0 bg-zinc-950/80 border border-zinc-800/80 rounded-2xl flex flex-col max-h-full">
                      <div {...lp.dragHandleProps} className="flex items-center gap-1 px-3 pt-3 pb-1">
                        <input
                          key={list.id + list.name}
                          defaultValue={list.name}
                          onBlur={(e) => renameList(list, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                          className="flex-1 min-w-0 bg-transparent font-semibold text-sm outline-none rounded-md px-1.5 py-1 hover:bg-zinc-800/60 focus:bg-zinc-900"
                        />
                        <span className="text-xs text-zinc-600 px-1">{list.cards.length}</span>
                        <button onClick={() => archiveList(list)} title="Archive list"
                          className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-600 hover:text-zinc-300">
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <Droppable droppableId={`list-${list.id}`} type="card">
                        {(dp, snapshot) => (
                          <div ref={dp.innerRef} {...dp.droppableProps}
                            className={`flex-1 overflow-y-auto px-2.5 pb-1 space-y-2 min-h-8 rounded-lg mx-0.5 transition-colors ${snapshot.isDraggingOver ? 'bg-indigo-500/5' : ''}`}>
                            {list.cards.map((card, ci) => (
                              <Draggable key={card.id} draggableId={`card-${card.id}`} index={ci} isDragDisabled={!!filtering}>
                                {(cp, cs) => (
                                  <div ref={cp.innerRef} {...cp.draggableProps} {...cp.dragHandleProps}
                                    style={cp.draggableProps.style}
                                    className={cs.isDragging ? 'rotate-2 opacity-90' : ''}>
                                    <CardChip card={card} onClick={() => setOpenCardId(card.id)} />
                                  </div>
                                )}
                              </Draggable>
                            ))}
                            {dp.placeholder}
                          </div>
                        )}
                      </Droppable>
                      <div className="p-2.5 pt-1">
                        <AddCard listId={list.id} autoFocus={quickAddList === list.id}
                          onAdded={() => { setQuickAddList(null); load(); }} />
                      </div>
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}

              {/* add list */}
              <div className="w-72 shrink-0">
                {addingList ? (
                  <form onSubmit={addList} className="bg-zinc-950/80 border border-indigo-500/50 rounded-2xl p-3">
                    <input autoFocus value={listName} onChange={(e) => setListName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setAddingList(false)}
                      placeholder="List name…"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-sm outline-none focus:border-indigo-500" />
                    <div className="flex gap-2 mt-2">
                      <button className="bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-semibold px-3 py-1.5 rounded-md">Add list</button>
                      <button type="button" onClick={() => setAddingList(false)} className="text-xs text-zinc-500 hover:text-zinc-200 px-2">Cancel</button>
                    </div>
                  </form>
                ) : (
                  <button onClick={() => setAddingList(true)}
                    className="w-full flex items-center gap-2 bg-zinc-950/50 hover:bg-zinc-900 border border-dashed border-zinc-800 hover:border-zinc-700 rounded-2xl px-4 py-3 text-sm text-zinc-500 hover:text-zinc-200 transition-colors">
                    <Plus className="w-4 h-4" /> Add list
                  </button>
                )}
              </div>
            </div>
          )}
        </Droppable>
      </DragDropContext>

      {/* side panel: activity / archived */}
      <AnimatePresence>
        {panel && (
          <motion.aside
            initial={{ x: 360 }} animate={{ x: 0 }} exit={{ x: 360 }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="fixed right-0 top-0 bottom-0 w-80 bg-zinc-950 border-l border-zinc-800 z-40 flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <h3 className="font-semibold text-sm flex items-center gap-2">
                {panel === 'activity' ? <><History className="w-4 h-4" /> Board activity</> : <><Archive className="w-4 h-4" /> Archived</>}
              </h3>
              <button onClick={() => setPanel(null)} className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {panel === 'activity' && (activity.length === 0
                ? <p className="text-sm text-zinc-600">No activity yet.</p>
                : activity.map((a) => (
                  <div key={a.id} className="text-sm">
                    <p className="text-zinc-300">{a.detail || a.action}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">{new Date(a.created_at + 'Z').toLocaleString()}</p>
                  </div>
                )))}
              {panel === 'archived' && (
                <>
                  {archived.cards.length === 0 && archived.lists.length === 0 && (
                    <p className="text-sm text-zinc-600">Nothing archived on this board.</p>
                  )}
                  {archived.lists.map((l) => (
                    <div key={`l${l.id}`} className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
                      <span className="text-sm text-zinc-300">📑 {l.name}</span>
                      <button onClick={() => restoreList(l.id)} className="flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200">
                        <RotateCcw className="w-3 h-3" /> Restore
                      </button>
                    </div>
                  ))}
                  {archived.cards.map((c) => (
                    <div key={`c${c.id}`} className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-300 truncate">{c.title}</p>
                        <p className="text-xs text-zinc-600">in {c.list_name}</p>
                      </div>
                      <button onClick={() => restoreCard(c.id)} className="flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200 shrink-0 ml-2">
                        <RotateCcw className="w-3 h-3" /> Restore
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* card modal */}
      <AnimatePresence>
        {openCardId && (
          <CardModal
            cardId={openCardId}
            board={board}
            onClose={() => { setOpenCardId(null); load(); }}
            onBoardChange={load}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
