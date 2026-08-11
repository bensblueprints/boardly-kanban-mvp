// Row → sync payload serialization. Local rows reference parents by integer
// FKs; payloads exchanged with the sync server use parent UUIDs instead, so
// rows stay meaningful on a device whose local ids are completely different.
// uuid/updated_at/deleted travel as envelope fields, never inside the payload.

// Dependency order for applying pulled changes: parents before children.
const TABLE_ORDER = [
  'boards',
  'lists',
  'cards',
  'labels',
  'checklists',
  'checklist_items',
  'card_labels',
  'comments',
  'attachments',
];

function uuidOf(db, table, id) {
  const row = db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id);
  return row ? row.uuid : null;
}

function rowToPayload(db, table, row) {
  switch (table) {
    case 'boards':
      return {
        name: row.name,
        description: row.description,
        color: row.color,
        emoji: row.emoji,
        starred: row.starred,
      };
    case 'lists':
      return {
        board_uuid: uuidOf(db, 'boards', row.board_id),
        name: row.name,
        position: row.position,
        archived: row.archived,
      };
    case 'cards':
      return {
        list_uuid: uuidOf(db, 'lists', row.list_id),
        title: row.title,
        description: row.description,
        position: row.position,
        due_date: row.due_date,
        archived: row.archived,
      };
    case 'labels':
      return {
        board_uuid: uuidOf(db, 'boards', row.board_id),
        name: row.name,
        color: row.color,
      };
    case 'card_labels':
      return {
        card_uuid: uuidOf(db, 'cards', row.card_id),
        label_uuid: uuidOf(db, 'labels', row.label_id),
      };
    case 'checklists':
      return {
        card_uuid: uuidOf(db, 'cards', row.card_id),
        title: row.title,
        position: row.position,
      };
    case 'checklist_items':
      return {
        checklist_uuid: uuidOf(db, 'checklists', row.checklist_id),
        text: row.text,
        done: row.done,
        position: row.position,
      };
    case 'comments':
      return {
        card_uuid: uuidOf(db, 'cards', row.card_id),
        author: row.author,
        body: row.body,
        created_at: row.created_at,
      };
    // filename is the local storage key and is deliberately NOT synced.
    case 'attachments':
      return {
        card_uuid: uuidOf(db, 'cards', row.card_id),
        original_name: row.original_name,
        size: row.size,
        mime: row.mime,
        created_at: row.created_at,
      };
    default:
      throw new Error(`cannot serialize table: ${table}`);
  }
}

module.exports = { TABLE_ORDER, rowToPayload };
