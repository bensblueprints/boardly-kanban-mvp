const express = require('express');
const { accessForMember } = require('./member-access');
const fail = (status, message) => Object.assign(Error(message), { status });

function createCompanyChat(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, body TEXT NOT NULL,
    card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    client_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(company_id, sender_id, client_id)
  ); CREATE INDEX IF NOT EXISTS company_messages_history ON company_messages(company_id,id);`);
  const task = id => db.prepare(`SELECT c.id,c.title,l.board_id,b.company_id FROM cards c
    JOIN lists l ON l.id=c.list_id JOIN company_projects p ON p.workspace_id=l.board_id
    JOIN company_boards b ON b.id=p.parent_board_id WHERE c.id=?`).get(id);
  return { task, db };
}

function createCompanyChatRoutes({ memberships }) {
  const router = express.Router();
  router.route('/api/:kind(companies|cards)/:id/team-chat')
    .all(express.json({ limit: '24kb' }))
    .all((req, res, next) => {
      try {
        if (!['GET','HEAD','POST'].includes(req.method)) throw fail(405,'Use GET or POST');
        const { db, task } = req.tenant.teamChat;
        const access = accessForMember(db, memberships.grants(req.workspaceOwnerId, req.cloudUserId));
        const card = req.params.kind === 'cards' ? task(Number(req.params.id)) : null;
        if (req.params.kind === 'cards' && (!card || (!req.workspaceIsOwner && !access.project(card.board_id)))) throw fail(404,'Task not found');
        const companyId = card ? card.company_id : req.params.kind === 'companies' ? Number(req.params.id) : null;
        const company = db.prepare('SELECT id,name FROM companies WHERE id=?').get(companyId ?? -1);
        if (!company || (!req.workspaceIsOwner && !access.company(company.id))) throw fail(403,'Company team chat requires company-wide membership. Ask the owner to add you under Company → Members.');
        const describe = row => {
          const linked = row.card_id && task(row.card_id);
          return { id:row.id,body:row.body,sender_name:row.sender_name,mine:row.sender_id===req.cloudUserId,created_at:row.created_at,
            task:linked?.company_id===company.id ? {id:linked.id,title:linked.title,project_id:linked.board_id} : null };
        };
        if (req.method === 'POST') {
          const { body, client_id } = req.body || {};
          if (typeof body !== 'string' || !body.trim() || body.length > 8000) throw fail(400,'Enter a message of up to 8,000 characters');
          if (typeof client_id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(client_id)) throw fail(400,'A message ID is required');
          const actor = memberships.actor(req.workspaceOwnerId, req.cloudUserId);
          const name = req.workspaceIsOwner ? 'Company owner' : actor?.name || actor?.email || 'Team member';
          db.prepare(`INSERT INTO company_messages(company_id,sender_id,sender_name,body,card_id,client_id,created_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(company_id,sender_id,client_id) DO NOTHING`)
            .run(company.id,req.cloudUserId,name,body.trim(),card?.id??null,client_id,Date.now());
          return res.status(201).json(describe(db.prepare('SELECT * FROM company_messages WHERE company_id=? AND sender_id=? AND client_id=?').get(company.id,req.cloudUserId,client_id)));
        }
        const cursor = name => {
          if (req.query[name] === undefined) return null;
          if (typeof req.query[name] !== 'string' || !/^\d+$/.test(req.query[name]) || !Number.isSafeInteger(Number(req.query[name]))) throw fail(400,'Invalid history cursor');
          return Number(req.query[name]);
        };
        const before=cursor('before'),after=cursor('after');
        if (before!==null && after!==null) throw fail(400,'Choose one history cursor');
        const rows=db.prepare(`SELECT * FROM company_messages WHERE company_id=? AND id>? AND id<? ORDER BY id ${after!==null?'ASC':'DESC'} LIMIT 101`)
          .all(company.id,after??0,before??Number.MAX_SAFE_INTEGER);
        const more=rows.length>100,messages=rows.slice(0,100);
        if(after===null)messages.reverse();
        res.json({company,task:card?{id:card.id,title:card.title}:null,messages:messages.map(describe),has_more:more});
      } catch(e) { next(e); }
    });
  return router;
}
module.exports = { createCompanyChat, createCompanyChatRoutes };
