const assert=require('node:assert/strict'),Database=require('better-sqlite3'),{createBilling}=require('../server/customer-billing');
(async()=>{const db=new Database(':memory:'),config={ownerId:'owner',origin:'https://boardly.example.com',billing:{secretKey:'fixture',webhookSecret:'fixture',serialPrice:'serial',agencyPrice:'agency',seatPrice:'seat',aiPrice:'ai'}};
 const sessions=new Map(),keys=new Map();let count=0,subs=[],loseResponse=false,failExpire=false;
 const request=async(url,opts)=>{const u=new URL(url),route=u.pathname.slice(4),body=new URLSearchParams(opts.body||'');
  if(route==='customers')return Response.json({id:'cus_'+body.get('metadata[boardly_user]')});
  if(route==='subscriptions')return Response.json({data:subs,has_more:false});
  if(route==='billing_portal/sessions')return Response.json({url:'https://billing.stripe.com/fixture'});
  if(route==='checkout/sessions'){
   const key=opts.headers['Idempotency-Key'];let s=keys.get(key);
   if(!s){count++;s={id:'cs_'+count,status:'open',url:'https://checkout.stripe.com/'+count,kind:body.get('subscription_data[metadata][kind]')};sessions.set(s.id,s);keys.set(key,s);}
   if(loseResponse){loseResponse=false;throw Error('Simulated lost response');}return Response.json(s);
  }
  const [, ,id,action]=route.split('/'),s=sessions.get(id);assert.ok(s,route);
  if(action==='expire'){if(failExpire)return Response.json({error:{}},{status:503});s.status='expired';}return Response.json(s);
 };
 let billing=createBilling({db,config,request});
 const same=await Promise.all(Array.from({length:10},()=>billing.checkout('user','serial_entrepreneur')));assert.equal(count,1);assert.ok(same.every(s=>s.id===same[0].id));
 await billing.checkout('user','agency');assert.equal(count,2);assert.equal(sessions.get('cs_1').status,'expired');
 failExpire=true;await assert.rejects(()=>billing.checkout('user','serial_entrepreneur'),{status:503});assert.equal(count,2);failExpire=false;
 sessions.get('cs_2').status='expired';await billing.checkout('user','agency');assert.equal(count,3);
 loseResponse=true;await assert.rejects(()=>billing.checkout('other','extra_users',2),/lost response/);assert.equal(count,4);
 billing=createBilling({db,config,request});await billing.checkout('other','extra_users',2);assert.equal(count,4,'Restart retry uses persisted idempotency key');
 sessions.get('cs_3').status='complete';await assert.rejects(()=>billing.checkout('user','agency'),{status:409});assert.equal(count,4);
 sessions.get('cs_3').subscription='sub_old';subs=[{id:'sub_old',status:'canceled',items:{data:[{price:{id:'agency'}}]}}];await billing.checkout('user','serial_entrepreneur');assert.equal(count,5,'Cancelled customer can resubscribe');
 db.close();console.log('PASS: concurrent duplicate checkout, plan-switch expiration, failed expiration fails closed, expired links, restart/lost-response recovery, processing protection, resubscribe after cancellation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
