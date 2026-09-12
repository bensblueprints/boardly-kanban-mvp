const https = require('node:https');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const { Readable } = require('node:stream');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { XMLParser } = require('fast-xml-parser');
const fail = (status,message) => Object.assign(Error(message),{status});
const MAX_FILE = 25 * 1024 * 1024;
function publicAddress(address) { try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; } }
function endpoint(value) {
  let url; try { url = new URL(value); } catch { throw fail(400,'Enter the HTTPS address supplied by your storage provider.'); }
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443'||ipaddr.isValid(url.hostname.replace(/^\[|\]$/g,''))&&!publicAddress(url.hostname.replace(/^\[|\]$/g,''))) throw fail(400,'Use a public HTTPS storage address on port 443, without login details or query parameters.');
  return url;
}
function safeLookup(host, options, callback) {
  dns.lookup(host,{all:true},(error,addresses)=>{
    if(error)return callback(error);
    if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))return callback(fail(400,'Storage must use a public HTTPS address.'));
    if(options?.all)return callback(null,addresses);
    callback(null,addresses[0].address,addresses[0].family);
  });
}
async function request(url, { method='GET', headers={}, body, limit=MAX_FILE }={}) {
  endpoint(new URL(url).origin);
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method,headers,lookup:safeLookup,agent:false},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(fail(413,'This file or folder response is too large. Files are limited to 25 MB per transfer.'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    const timer=setTimeout(()=>req.destroy(fail(504,'The storage service took too long to respond.')),30000);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(body);
  });
}
function relativePath(value='', folder=false) {
  if(typeof value!=='string'||value.length>1000||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>p==='.'||p==='..')||/%(?:2f|5c|2e|00)/i.test(value))throw fail(400,'Choose a file or folder inside this storage connection.');
  const clean=value.replace(/\/+$/,''); return clean&&folder?clean+'/':clean;
}
function createProvider(config, secrets, transport=request) {
  const prefix=relativePath(config.prefix||'',true);
  if(config.provider==='s3') {
    const handler={handle:async(req)=>{
      const url=new URL(`${req.protocol}//${req.hostname}${req.port?':'+req.port:''}${req.path}`);
      for(const [key,value] of Object.entries(req.query||{}))for(const item of [value].flat())url.searchParams.append(key,item??'');
      // Validate origin without rejecting the signed S3 query string.
      endpoint(url.origin);
      const result=await transport(url,{method:req.method,headers:req.headers,body:req.body,limit:MAX_FILE});
      return {response:{statusCode:result.status,headers:result.headers,body:Readable.from([result.body])}};
    }};
    const client=new S3Client({region:config.region,endpoint:config.endpoint,forcePathStyle:true,credentials:{accessKeyId:secrets.access_key,secretAccessKey:secrets.secret_key,...(secrets.session_token?{sessionToken:secrets.session_token}:{})},maxAttempts:1,requestHandler:handler,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
    return {
      async list(path='',cursor='') {
        const current=prefix+relativePath(path,true);
        const r=await client.send(new ListObjectsV2Command({Bucket:config.bucket,Prefix:current,Delimiter:'/',MaxKeys:100,ContinuationToken:cursor||undefined}));
        const files=(r.Contents||[]).filter(x=>x.Key?.startsWith(current)&&x.Key!==current).map(x=>({path:x.Key.slice(prefix.length),name:x.Key.slice(current.length),size:x.Size,modified:x.LastModified?.toISOString(),folder:false}));
        const folders=(r.CommonPrefixes||[]).filter(x=>x.Prefix?.startsWith(current)).map(x=>({path:x.Prefix.slice(prefix.length),name:x.Prefix.slice(current.length).replace(/\/$/,''),folder:true}));
        return {items:[...folders,...files],cursor:r.NextContinuationToken||null};
      },
      async get(path){const r=await client.send(new GetObjectCommand({Bucket:config.bucket,Key:prefix+relativePath(path)}));return{body:Buffer.from(await r.Body.transformToByteArray()),mime:r.ContentType||'application/octet-stream'};},
      async put(path,body,mime){await client.send(new PutObjectCommand({Bucket:config.bucket,Key:prefix+relativePath(path),Body:body,ContentType:mime,IfNoneMatch:'*'}));return{ok:true};}
    };
  }
  const base=new URL(config.endpoint.endsWith('/')?config.endpoint:config.endpoint+'/');
  const headers={Authorization:'Basic '+Buffer.from(secrets.username+':'+secrets.password).toString('base64')};
  function url(path,folder=false){return new URL((prefix+relativePath(path,folder)).split('/').map(encodeURIComponent).join('/'),base);}
  async function call(path,options){const r=await transport(url(path,options.method==='PROPFIND'),{...options,headers:{...headers,...options.headers}});if(r.status<200||r.status>=300)throw fail(r.status===404?404:r.status===412?409:502,r.status===412?'A file with that name already exists. Rename your upload.':'The storage service could not complete this request. Check its address and permissions.');return r;}
  return {
    async list(path='') {
      const current=url(path,true),r=await call(path,{method:'PROPFIND',headers:{Depth:'1','Content-Type':'application/xml'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',limit:4*1024*1024});
      if(/<!DOCTYPE|<!ENTITY/i.test(r.body.toString()))throw fail(502,'The storage folder response could not be read.');
      const parsed=new XMLParser({removeNSPrefix:true,ignoreAttributes:true,parseTagValue:false,processEntities:true,isArray:name=>['response','propstat'].includes(name)}).parse(r.body.toString());
      const rows=parsed?.multistatus?.response;if(!Array.isArray(rows))throw fail(502,'This address did not return a WebDAV folder.');
      if(rows.length>2001)throw fail(413,'This WebDAV folder has more than 2,000 items. Choose a smaller folder as your connection root.');
      const items=[];
      for(const row of rows){const href=new URL(String(row.href||''),current);if(href.origin!==current.origin||!href.pathname.startsWith(current.pathname)||href.pathname===current.pathname)continue;
        const tail=decodeURIComponent(href.pathname.slice(current.pathname.length));if(!tail||tail.replace(/\/$/,'').includes('/'))continue;
        const prop=row.propstat?.find(p=>/ 200 /.test(p.status))?.prop;if(!prop)continue;const folder=prop.resourcetype&&typeof prop.resourcetype==='object'&&Object.hasOwn(prop.resourcetype,'collection');
        const name=tail.replace(/\/$/,'');const itemPath=relativePath(path,true)+name+(folder?'/':'');relativePath(itemPath);
        items.push({path:itemPath,name,folder:!!folder,size:Number(prop.getcontentlength)||0,modified:prop.getlastmodified||null});
      }return{items,cursor:null};
    },
    async get(path){const r=await call(path,{});return{body:r.body,mime:r.headers['content-type']||'application/octet-stream'};},
    async put(path,body,mime){await call(path,{method:'PUT',headers:{'Content-Type':mime,'If-None-Match':'*'},body});return{ok:true};}
  };
}
module.exports={createProvider,request,relativePath,endpoint,publicAddress,safeLookup,MAX_FILE};
