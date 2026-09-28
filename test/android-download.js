const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./member-fixture');
(async()=>{const f=await fixture({publicAccess:true});try{
 const route='/api/mobile/android';assert.equal((await fetch(f.base+route+'/release')).status,401);assert.equal((await fetch(f.base+route+'/apk')).status,401);
 assert.equal((await f.request(route+'/release',{user:'user_customer'})).status,503);
 const dir=path.join(f.root,'android-release');fs.mkdirSync(dir);const content=Buffer.from('isolated APK fixture'),file='Boardly-1.5.0.apk';fs.writeFileSync(path.join(dir,file),content);const metadata={version:'1.5.0',version_code:7,file,size:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')};fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(metadata));
 assert.equal((await f.api(route+'/release',{user:'user_customer'})).version,'1.5.0');const download=await f.request(route+'/apk',{user:'user_customer'});assert.equal(await download.text(),content.toString());assert.match(download.headers.get('cache-control'),/private/);
 metadata.file='../personal-ai.db';fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(metadata));assert.equal((await f.request(route+'/apk')).status,503);
 console.log('PASS: authenticated Android metadata/APK download, anonymous denial, missing release and unsafe manifest rejection.');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
