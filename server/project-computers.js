const express = require('express');
const { accessForMember } = require('./member-access');
const fail = (status, message) => Object.assign(Error(message), { status });
const COMPUTER_PLAN = Object.freeze({ id:'computer_8gb_150gb', name:'Project computer', currency:'usd', monthly_cents:2999, ram_gb:8, storage_gb:150, ai_usage_included:false });

function installComputers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_computer_requests (
    board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 32),
    requested_by TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','cancelled')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
}
function createComputerRoutes({ memberships }) {
  const router = express.Router(), base = '/api/boards/:boardId/computers';
  function access(req, write = false) {
    const db = req.tenant.app.db, id = Number(req.params.boardId);
    if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM boards WHERE id=?').get(id)) throw fail(404, 'Project not found');
    if (!req.workspaceIsOwner) {
      const scope = accessForMember(db, memberships.grants(req.workspaceOwnerId, req.cloudUserId));
      if (!scope.project(id)) throw fail(404, 'Project not found');
      if (write) throw fail(403, 'The account owner manages computer requests and subscriptions');
    }
    return { db, id };
  }
  function state(req) {
    const {db,id} = access(req), row = db.prepare("SELECT quantity,status,created_at,updated_at FROM project_computer_requests WHERE board_id=? AND status='requested'").get(id);
    // A request is not an entitlement. Checkout and desktop access stay closed
    // until a verified capacity allocator and paid provisioning lifecycle exist.
    return { plan:COMPUTER_PLAN, launch_status:'preparing', available_computers:0, checkout_available:false, can_request:req.workspaceIsOwner, request:row || null };
  }
  router.get(base, (req,res,next) => { try { res.set('Cache-Control','private, no-store').json(state(req)); } catch(e) { next(e); } });
  router.put(base + '/request', express.json({limit:'4kb'}), (req,res,next) => {
    try {
      const {db,id} = access(req,true), quantity = req.body?.quantity;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 32) throw fail(400,'Request between 1 and 32 computers');
      const now=Date.now();
      db.prepare("INSERT INTO project_computer_requests VALUES (?,?,?,'requested',?,?) ON CONFLICT(board_id) DO UPDATE SET quantity=excluded.quantity,requested_by=excluded.requested_by,status='requested',updated_at=excluded.updated_at").run(id,quantity,req.cloudUserId,now,now);
      res.json(state(req));
    } catch(e) { next(e); }
  });
  router.delete(base + '/request', (req,res,next) => {
    try { const {db,id}=access(req,true);db.prepare("UPDATE project_computer_requests SET status='cancelled',updated_at=? WHERE board_id=?").run(Date.now(),id);res.json(state(req)); } catch(e) { next(e); }
  });
  router.post(base + '/checkout', (req,res,next) => {
    try { access(req,true);throw fail(503,'Computer purchases open after hardware and billing are ready. No payment has been taken.'); } catch(e) { next(e); }
  });
  return router;
}
module.exports = { COMPUTER_PLAN, installComputers, createComputerRoutes };
