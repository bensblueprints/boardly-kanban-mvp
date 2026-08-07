import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { KanbanSquare, Calendar, ListChecks } from 'lucide-react';

// Public read-only board, reached via a share link — no login, no chrome.
// The server decides what's safe to show (see the contract in app.js); this
// just renders it.
export default function ShareView({ token }) {
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j ? setData(j) : setMissing(true)))
      .catch(() => setMissing(true));
  }, [token]);

  if (missing) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center">
          <KanbanSquare className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-zinc-400 font-semibold">This link doesn't work anymore</p>
          <p className="text-sm text-zinc-600 mt-1">It was revoked, or it never existed.</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="h-full flex items-center justify-center text-zinc-600">Loading…</div>;
  }

  const { board, lists } = data;

  return (
    <div className="min-h-full">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center gap-2.5">
          <KanbanSquare className="w-6 h-6 text-indigo-400" />
          <span className="font-bold text-lg">Boardly</span>
          <span className="text-zinc-600 text-sm">· shared board, read-only</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-3 mb-1">
            <span className="text-3xl">{board.emoji}</span>
            <h1 className="text-2xl font-bold">{board.name}</h1>
          </div>
          {board.description && (
            <p className="text-sm text-zinc-500 mb-8">{board.description}</p>
          )}
        </motion.div>

        <div className="flex gap-4 overflow-x-auto pb-6 items-start">
          {lists.map((l, i) => (
            <motion.section
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="w-72 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/60"
            >
              <h2 className="px-4 pt-3.5 pb-2 text-sm font-semibold text-zinc-300">{l.name}</h2>
              <div className="px-2.5 pb-2.5 space-y-2">
                {l.cards.map((c, j) => (
                  <div key={j} className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                    <div className="text-sm font-medium">{c.title}</div>
                    {c.description && (
                      <p className="text-xs text-zinc-500 mt-1 line-clamp-3">{c.description}</p>
                    )}
                    {c.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {c.labels.map((lb, k) => (
                          <span
                            key={k}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ background: `${lb.color}22`, color: lb.color }}
                          >
                            {lb.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-500">
                      {c.due_date && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" /> {c.due_date.slice(0, 10)}
                        </span>
                      )}
                      {c.checklists.map((cl, k) => {
                        const done = cl.items.filter((it) => it.done).length;
                        return (
                          <span key={k} className="flex items-center gap-1">
                            <ListChecks className="w-3 h-3" /> {done}/{cl.items.length}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {l.cards.length === 0 && (
                  <p className="text-xs text-zinc-700 px-1.5 pb-1">No cards</p>
                )}
              </div>
            </motion.section>
          ))}
        </div>

        <p className="text-xs text-zinc-700 mt-6">
          Shared from Boardly — the self-hosted kanban you pay for once.
        </p>
      </main>
    </div>
  );
}
