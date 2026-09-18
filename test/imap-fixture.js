// Local TLS IMAP fixture. No external mailbox or real credentials are used.
const tls=require('node:tls'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {ImapFlow}=require('imapflow');
const {connectMailbox}=require('../server/company-email');
async function createImapFixture(root){
 const keyPath=path.join(root,'imap.key'),certPath=path.join(root,'imap.crt');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=mail.fixture.test','-addext','subjectAltName=DNS:mail.fixture.test'],{stdio:'ignore'});
 const cert=fs.readFileSync(certPath),code='835194',password='synthetic-imap-app-password',commands=[];
 const date=new Date(),source=Buffer.from(`From: login@example.com\r\nTo: ops@example.com\r\nSubject: Your verification code\r\nDate: ${date.toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code is ${code}.\r\n`);
 const sockets=new Set();
 const server=tls.createServer({key:fs.readFileSync(keyPath),cert},socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
   socket.write('* OK [CAPABILITY IMAP4rev1] Synthetic inbox ready\r\n');let buffer='';
   socket.on('data',chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){
     const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);
     const match=line.match(/^(\S+) (\S+)(?: (.*))?$/);if(!match)continue;const [,tag,verb,args='']=match;
     commands.push(verb==='UID'?'UID '+args.split(' ')[0]:verb);
     const ok=()=>socket.write(`${tag} OK completed\r\n`);
     if(verb==='CAPABILITY'){socket.write('* CAPABILITY IMAP4rev1\r\n');ok();}
     else if(verb==='LOGIN'){if(line.includes(password))ok();else socket.write(`${tag} NO auth failed\r\n`);}
     else if(verb==='LIST'){socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');ok();}
     else if(verb==='EXAMINE'){socket.write('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 81] Valid\r\n* OK [UIDNEXT 10] Next\r\n');socket.write(`${tag} OK [READ-ONLY] INBOX\r\n`);}
     else if(verb==='FETCH'||verb==='UID'&&args.startsWith('FETCH')){
       if(/BODY\.PEEK\[\]/i.test(args)){
         socket.write(`* 1 FETCH (UID 9 BODY[]<0> {${source.length}}\r\n`);socket.write(source);socket.write(')\r\n');
       }else{
         const internal=`${date.getUTCDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]}-${date.getUTCFullYear()} ${date.toISOString().slice(11,19)} +0000`;
         socket.write(`* 1 FETCH (UID 9 RFC822.SIZE ${source.length} INTERNALDATE "${internal}" ENVELOPE ("${date.toUTCString()}" "Your verification code" ((NIL NIL "login" "example.com")) NIL NIL ((NIL NIL "ops" "example.com")) NIL NIL NIL "<fixture@example.com>"))\r\n`);
       }ok();
     }else if(verb==='LOGOUT'){socket.write('* BYE closed\r\n');ok();socket.end();}
     else if(['NOOP','CLOSE'].includes(verb))ok();
     else socket.write(`${tag} BAD unsupported fixture command\r\n`);
   }});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 // Production DNS and TLS policy remain exercised; only the socket destination
 // and trust root are adapted to our ephemeral local certificate.
 class FixtureClient extends ImapFlow{constructor(options){if(options.tls.rejectUnauthorized!==true)throw Error('TLS verification required');super({...options,host:'127.0.0.1',port:server.address().port,tls:{...options.tls,ca:cert}});}}
 const connector=(config,operation)=>connectMailbox(config,operation,{resolve:async()=>[{address:'8.8.8.8',family:4}],Client:FixtureClient});
 return {connector,code,password,date,commands,async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
module.exports={createImapFixture};
