const fail=(status,message)=>Object.assign(Error(message),{status});

function installTaskFiles(db){
 db.exec(`CREATE TABLE IF NOT EXISTS task_file_links (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  generated INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, PRIMARY KEY(card_id,file_id)
 ); CREATE INDEX IF NOT EXISTS task_file_by_file ON task_file_links(file_id);`);
}
function taskBoard(db,id){return db.prepare('SELECT l.board_id FROM cards c JOIN lists l ON l.id=c.list_id WHERE c.id=?').get(id)?.board_id;}
function linkTaskFile(db,cardId,fileId,{generated=false}={}){
 const boardId=taskBoard(db,cardId),file=db.prepare('SELECT id,board_id FROM project_files WHERE id=?').get(fileId);
 if(!boardId||file?.board_id!==boardId)throw fail(404,'File not found in this task’s project');
 // An automatic save must not restore a shortcut the user has removed.
 db.prepare(`INSERT INTO task_file_links(card_id,file_id,generated,created_at) VALUES(?,?,?,?)
  ON CONFLICT(card_id,file_id) ${generated?'DO NOTHING':'DO UPDATE SET hidden=0'}`).run(cardId,fileId,Number(generated),Date.now());
 return{card_id:Number(cardId),file_id:Number(fileId)};
}
function linkGeneratedFile(db,cardId,fileId,boardId){
 if(cardId&&taskBoard(db,cardId)===boardId)return linkTaskFile(db,cardId,fileId,{generated:true});
}
function backfillTaskOutputs(db){
 // Existing job/file provenance supplies the relationship without copying bytes
 // or guessing task identity from filenames or assistant messages.
 db.exec(`INSERT OR IGNORE INTO task_file_links(card_id,file_id,generated,created_at)
  SELECT t.card_id,f.id,1,f.created_at FROM chat_outputs o
  JOIN chat_jobs j ON j.id=o.job_id JOIN chat_threads t ON t.id=j.thread_id
  JOIN cards c ON c.id=t.card_id JOIN lists l ON l.id=c.list_id
  JOIN project_files f ON f.id=o.file_id
  WHERE l.board_id=t.board_id AND f.board_id=l.board_id;`);
}
function listTaskFiles(db,cardId){
 return db.prepare(`SELECT f.id,f.name,f.size,f.mime,f.url,f.created_at,x.generated
  FROM task_file_links x JOIN project_files f ON f.id=x.file_id
  JOIN cards c ON c.id=x.card_id JOIN lists l ON l.id=c.list_id
  WHERE x.card_id=? AND x.hidden=0 AND f.board_id=l.board_id
  ORDER BY f.created_at DESC,f.id DESC`).all(cardId);
}
function taskFileCount(db,cardId){
 return db.prepare(`SELECT COUNT(*) n FROM task_file_links x
  JOIN project_files f ON f.id=x.file_id JOIN cards c ON c.id=x.card_id
  JOIN lists l ON l.id=c.list_id WHERE x.card_id=? AND x.hidden=0 AND f.board_id=l.board_id`).get(cardId).n;
}
function registerTaskFileRoutes(app,{db,requireAuth}){
 app.get('/api/cards/:id/files',requireAuth,(req,res)=>{
  if(!taskBoard(db,req.params.id))return res.status(404).json({error:'Task not found'});
  res.set('Cache-Control','private, no-store').json({files:listTaskFiles(db,req.params.id)});
 });
 app.post('/api/cards/:id/files',requireAuth,(req,res)=>{
  try{
   if(!Number.isSafeInteger(req.body?.file_id)||req.body.file_id<1)throw fail(400,'Choose a project file');
   res.status(201).json(linkTaskFile(db,req.params.id,req.body.file_id));
  }catch(e){res.status(e.status||400).json({error:e.message});}
 });
 app.delete('/api/cards/:id/files/:fileId',requireAuth,(req,res)=>{
  if(!taskBoard(db,req.params.id))return res.status(404).json({error:'Task not found'});
  db.prepare('UPDATE task_file_links SET hidden=1 WHERE card_id=? AND file_id=?').run(req.params.id,req.params.fileId);
  res.json({ok:true});
 });
}
module.exports={installTaskFiles,linkTaskFile,linkGeneratedFile,backfillTaskOutputs,listTaskFiles,taskFileCount,registerTaskFileRoutes};
