const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { clerkMiddleware, getAuth } = require('@clerk/express');
const { createApp } = require('./app');

// Resolve workspaces only from Clerk's verified subject, never from request IDs.
function workspacePath(root, userId) {
  if (typeof userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(userId)) {
    throw new Error('A valid Clerk user ID is required');
  }
  return path.join(root, 'workspaces', crypto.createHash('sha256').update(userId).digest('hex'));
}

function readCloudConfig(env = process.env) {
  for (const name of ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'BOARDLY_OWNER_USER_ID', 'BOARDLY_ORIGIN']) {
    if (!env[name]) throw new Error(`Missing required cloud setting: ${name}`);
  }
  const url = new URL(env.BOARDLY_ORIGIN);
  if (url.origin !== env.BOARDLY_ORIGIN || url.username || url.password) {
    throw new Error('BOARDLY_ORIGIN must be an origin without a path or credentials');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && env.NODE_ENV !== 'production')) {
    throw new Error('Cloud Boardly requires HTTPS (HTTP is allowed only for local development)');
  }
  if (env.BOARDLY_OWNER_ONLY && !['true', 'false'].includes(env.BOARDLY_OWNER_ONLY)) {
    throw new Error('BOARDLY_OWNER_ONLY must be true or false');
  }
  const planSlugs = (env.BOARDLY_PAID_PLAN_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (planSlugs.some(slug => !/^[a-zA-Z0-9_-]+$/.test(slug))) throw new Error('Invalid paid plan slug');
  const ownerOnly = env.BOARDLY_OWNER_ONLY !== 'false';
  const storageLimitBytes = Number(env.BOARDLY_CUSTOMER_STORAGE_BYTES || 1073741824);
  if (!Number.isSafeInteger(storageLimitBytes) || storageLimitBytes < 1) throw new Error('Customer storage limit must be a positive byte count');
  const dataDir = path.resolve(env.CLOUD_DATA_DIR || path.join(__dirname, '..', 'cloud-data'));
  workspacePath(dataDir, env.BOARDLY_OWNER_USER_ID);
  return {
    computeruseOrigin: require('./computeruse-connections').trustedOrigin(env.COMPUTERUSE_API_ORIGIN || ''),
    dataDir, origin: url.origin, ownerId: env.BOARDLY_OWNER_USER_ID, ownerOnly, planSlugs,
    publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY || undefined,
    storageLimitBytes, freeEnabled: true, openaiApiKey: env.BOARDLY_OPENAI_API_KEY || '',
    audio: { url: env.BOARDLY_AUDIO_URL || '', token: env.BOARDLY_AUDIO_TOKEN_FILE ? fs.readFileSync(env.BOARDLY_AUDIO_TOKEN_FILE, 'utf8').trim() : env.BOARDLY_AUDIO_TOKEN || '' },
    chatgpt: { url: env.BOARDLY_CHATGPT_URL || '', token: env.BOARDLY_CHATGPT_TOKEN_FILE ? fs.readFileSync(env.BOARDLY_CHATGPT_TOKEN_FILE, 'utf8').trim() : '' },
    billing:{portalConfiguration:env.STRIPE_PORTAL_CONFIGURATION_ID,planPortalConfiguration:env.STRIPE_PLAN_PORTAL_CONFIGURATION_ID,seatPortalConfiguration:env.STRIPE_SEAT_PORTAL_CONFIGURATION_ID,secretKey:env.STRIPE_SECRET_KEY,webhookSecret:env.STRIPE_WEBHOOK_SECRET,serialPrice:env.STRIPE_SERIAL_PRICE_ID,agencyPrice:env.STRIPE_AGENCY_PRICE_ID,seatPrice:env.STRIPE_SEAT_PRICE_ID,aiPrice:env.STRIPE_AI_PRICE_ID,meterEvent:env.STRIPE_AI_METER_EVENT},
  };
}

function accessFor(auth, config) {
  if (!auth?.userId || !auth.isAuthenticated) return { status: 401, error: 'Sign in to continue' };
  if (auth.userId === config.ownerId) return { status: 200, plan: 'owner' };
  if (config.ownerOnly) return { status: 403, error: 'Boardly is currently available to its owner only' };
  // Clerk Billing's has() reads verified session claims. Neither request bodies
  // nor user-editable metadata can grant a plan or bypass the launch gate.
  if (config.freeEnabled && !config.ownerOnly) return {status:200,plan:require('./account-plans').planFor(auth,config).slug};
  const plan = config.planSlugs.find(slug => auth.has({ plan: `u:${slug}` }));
  return plan ? { status: 200, plan } : { status: 403, error: 'An active Boardly subscription is required' };
}

function createCloudApp(config = readCloudConfig(), { emailConnector, identityClient, providerRequest, githubRequest, computeruseRequest } = {}) {
  const { createConnections } = require('./connections');
  const { createSyncHub } = require('./sync/hub');
  const { createProjectChat } = require('./project-chat');
  const { createProjectAssets } = require('./project-assets');
  const { createProjectPayments } = require('./project-payments');
  const { loadKey, createProjectEnvironment } = require('./project-environment');
  const { createBoardlyServer } = require('../mcp/tools');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const tenants = new Map(), identities = new WeakMap();
  const connections = createConnections(config.dataDir);
  const projectKey = loadKey(config.dataDir);
  const identity = identityClient || require('@clerk/backend').createClerkClient({secretKey:config.secretKey,publishableKey:config.publishableKey});
  const memberships = require('./memberships').createMemberships(config.dataDir);
  const {planFor,createPlanService,PLANS} = require('./account-plans');
  const planService = createPlanService(config,identity);
  const personal=require('./personal-ai').createPersonalAI({config,key:projectKey,request:providerRequest});
  const chatgpt=require('./chatgpt').createChatGPT(config.chatgpt,personal);
  const tailnet=require('./tailnet').createTailnet(config.tailnet||{url:process.env.BOARDLY_TAILNET_URL,token:process.env.BOARDLY_TAILNET_TOKEN_FILE?fs.readFileSync(process.env.BOARDLY_TAILNET_TOKEN_FILE,'utf8').trim():undefined});
  app.use(personal.billing.webhook);
  const dist = path.join(__dirname, '..', 'dist');
  // The public homepage is independent of Clerk availability and sessions.
  app.get('/', (req, res, next) => {
    const landing = path.join(dist, 'landing', 'index.html');
    if (!fs.existsSync(landing)) return next();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(landing);
  });
  app.use('/landing', express.static(path.join(dist, 'landing'), { index: false, maxAge: '1h' }));
  app.get('/site.webmanifest', (req, res) => res.sendFile(path.join(dist, 'site.webmanifest')));
  app.get(['/favicon.ico', '/favicon.svg'], (req, res) => res.sendFile(path.join(dist, 'favicon.svg')));
  const clerk = clerkMiddleware({ publishableKey: config.publishableKey, secretKey: config.secretKey,
    jwtKey: config.jwtKey, authorizedParties: [config.origin] });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, no-store');
    const match = /^Bearer (bdly_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    if (!match) return clerk(req, res, next);
    const connection = connections.authenticate(match[1]);
    // Personal connections are owner-only during this initial launch. Paid
    // customers need their own revocation/entitlement integration before enablement.
    if (!connection || connection.user_id !== config.ownerId) return res.status(401).json({ error: 'Connection key expired or revoked' });
    req.boardlyConnection = connection;
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/auth-config', (req, res) => res.json({ mode: 'clerk', publishableKey: config.publishableKey, ownerOnly: config.ownerOnly }));

  function tenantFor(ownerId,plan) {
    connections.rememberWorkspace(ownerId);
    let tenant=tenants.get(ownerId);
    if(!tenant){
      if(tenants.size>=32){const idle=[...tenants.entries()].filter(([,t])=>!t.active).sort((a,b)=>a[1].used-b[1].used)[0];if(!idle)throw Object.assign(Error('Please retry shortly'),{status:503});idle[1].chat.hosted.close();idle[1].subscription.close();idle[1].app.stopSync();idle[1].app.db.close();tenants.delete(idle[0]);}
      const dataDir=workspacePath(config.dataDir,ownerId);
      const local=createApp({dataDir,externalAuth:r=>identities.get(r)===ownerId,maxUploadMb:25,storageQuotaBytes:plan.storage_bytes});local.stopSync();
      tenant={active:0,used:Date.now(),app:local,uploadsDir:path.join(dataDir,'uploads')};
      tenant.hub=createSyncHub({db:local.db,uploadsDir:tenant.uploadsDir,engine:local.syncEngine,connections});
      tenant.environment=createProjectEnvironment({db:local.db,key:projectKey,namespace:ownerId});
      tenant.payments=createProjectPayments({db:local.db,key:projectKey,namespace:ownerId});
      tenant.email=require('./company-email').createCompanyEmail({db:local.db,key:projectKey,namespace:ownerId,connector:emailConnector});
      tenant.ssh=require('./ssh-connections').createSshConnections({db:local.db,key:projectKey,namespace:ownerId,tailnet,members:()=>memberships.db.prepare("SELECT id,user_id,email,name,status FROM account_members WHERE owner_id=? AND status!='provisioning'").all(ownerId)});
      tenant.computeruse=require('./computeruse-connections').createComputerUseConnections({db:local.db,key:projectKey,namespace:ownerId,origin:config.computeruseOrigin,request:computeruseRequest});
      tenant.github=require('./github-connections').createGithubConnections({db:local.db,key:projectKey,namespace:ownerId,request:githubRequest});
      tenant.teamChat=require('./company-chat').createCompanyChat(local.db);
      tenant.chat=createProjectChat({db:local.db,connections,userId:ownerId,uploadsDir:tenant.uploadsDir,environment:tenant.environment,payments:tenant.payments,email:tenant.email,ssh:tenant.ssh,github:tenant.github,canUseGithub:(actor,id)=>actor===ownerId||require('./member-access').accessForMember(local.db,memberships.grants(ownerId,actor)).capabilities('project',id).includes('github'),canUseSsh:(actor,id)=>actor===ownerId||require('./member-access').accessForMember(local.db,memberships.grants(ownerId,actor)).capabilities('project',id).includes('ssh')});
      const canEdit=(actor,id)=>actor===ownerId||require('./member-access').accessForMember(local.db,memberships.grants(ownerId,actor)).project(id)==='editor';
      tenant.subscription=require('./subscription-ai').createSubscriptionAI({db:local.db,ownerId,canEdit,connections});
      const funded={...personal,authorize:async(actor)=>{
        if(ownerId===config.ownerId&&personal.account(ownerId).mode==='none')return{user_id:ownerId,actor_id:actor,mode:'subscription',model:personal.account(ownerId).model};
        if(personal.account(ownerId).mode==='chatgpt')return chatgpt.authorize(ownerId);
        return personal.authorize(ownerId);
      },respond:(a,id,payload)=>a.mode==='subscription'?tenant.subscription.respond(a.actor_id,id,payload):a.mode==='chatgpt'?chatgpt.respond(a,id,payload):personal.respond(a,id,payload)};
      tenant.chat.hosted=require('./hosted-ai').createHostedAI({db:local.db,uploadsDir:tenant.uploadsDir,personal:funded,canEdit:(actor,id)=>actor===ownerId||require('./member-access').accessForMember(local.db,memberships.grants(ownerId,actor)).project(id)==='editor',canUse:(actor,id,scope)=>actor===ownerId||require('./member-access').accessForMember(local.db,memberships.grants(ownerId,actor)).capabilities('project',id).includes(scope),retain:()=>tenant.active++,release:()=>tenant.active--,storageLimit:()=>tenant.plan.storage_bytes,organization:tenant.chat.organization,ssh:tenant.ssh,github:tenant.github,computeruse:tenant.computeruse});
      tenant.chat.organization.router.enqueueApi=()=>tenant.chat.hosted.enqueue();
      tenant.assets=createProjectAssets({db:local.db,uploadsDir:tenant.uploadsDir,limitBytes:plan.storage_bytes});
      tenants.set(ownerId,tenant);
    }
    tenant.plan=plan;memberships.prune(ownerId,tenant.app.db);return tenant;
  }
  app.use(async (req,res,next)=>{
    if(!/^\/(api|uploads|mcp)(\/|$)/i.test(req.path))return next();
    try{
      const auth=req.boardlyConnection?{userId:req.boardlyConnection.user_id,isAuthenticated:true}:getAuth(req,{acceptsToken:'session_token'});
      const access=accessFor(auth,config),route=req.path.toLowerCase();
      if(!auth.isAuthenticated){if(route==='/api/me')return res.json({authed:false,allowed:false,error:'Sign in to continue'});return res.status(401).json({error:'Sign in to continue'});}
      if(req.headers.origin&&req.headers.origin!==config.origin)return res.status(403).json({error:'Request origin is not allowed'});
      if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!req.headers.origin&&!/^Bearer /i.test(req.headers.authorization||''))return res.status(403).json({error:'An origin or session bearer token is required'});
      const own=access.status===200,shared=req.boardlyConnection?[]:memberships.accounts(auth.userId),choices=[];
      if(own)choices.push({owner_id:auth.userId,name:'My account',owner:true});
      for(const item of shared)if(item.owner_id!==auth.userId)choices.push({...item,owner:false});
      const requested=req.boardlyConnection?auth.userId:req.headers['x-boardly-workspace'];
      let chosen=choices.find(c=>c.owner_id===requested)||(requested&&route!=='/api/me'?null:choices[0]);
      if(!chosen){if(route==='/api/me')return res.json({authed:true,allowed:false,userId:auth.userId,error:access.error||'No shared projects are available',workspaces:[]});return res.status(403).json({error:'This account has not shared any work with you'});}
      let plan;
      if(personal.billing.ready()){const billed=await personal.billing.state(chosen.owner_id);plan={...billed.plan,extra_users:billed.extra_users,users:billed.plan.users===null?null:billed.plan.users+billed.extra_users};}
      else plan=chosen.owner?planFor(auth,config):await planService.sponsored(chosen.owner_id);
      if(!plan)throw Object.assign(Error('The sponsoring account is unavailable'),{status:403});
      if(chosen.owner&&!config.freeEnabled&&auth.userId!==config.ownerId)plan={...plan,storage_bytes:config.storageLimitBytes||1073741824};
      if(req.boardlyConnection){const allowed=req.boardlyConnection.scope==='mcp'?route==='/mcp':req.boardlyConnection.scope==='sync'?/^\/api\/sync\/(push|pull|attachments\/[a-f0-9-]+)$/.test(route)||route==='/api/account/status':req.boardlyConnection.scope==='worker'&&/^\/api\/worker\//.test(route);if(!allowed)return res.status(403).json({error:'This connection key does not permit that action'});}
      else if(route.startsWith('/api/worker/'))return res.status(403).json({error:'A worker connection is required'});
      if((route.startsWith('/api/connections')||route==='/mcp'||route.startsWith('/api/sync/')||route==='/api/account/status')&&(!chosen.owner||auth.userId!==config.ownerId))return res.status(403).json({error:'This integration is currently available to the owner'});
      if(/^\/api\/(mcp|coach|login|logout)(\/|$)/i.test(req.path))return res.status(404).json({error:'Local desktop control is not available in cloud mode'});
      req.cloudUserId=auth.userId;req.workspaceOwnerId=chosen.owner_id;req.workspaceIsOwner=chosen.owner;req.accountPlan=plan;
      const tenant=tenantFor(chosen.owner_id,plan);req.tenant=tenant;
      if(!chosen.owner&&!memberships.grants(chosen.owner_id,auth.userId).length)throw Object.assign(Error('Your shared access has been removed'),{status:403});
      memberships.touch(auth.userId);
      if(route==='/api/me'&&req.method==='GET') {
        const workspaces=choices.map(choice=>choice.owner?choice:{...choice,companies:require('./shared-companies').sharedCompanies(path.join(workspacePath(config.dataDir,choice.owner_id),'app.db'),memberships.grants(choice.owner_id,auth.userId))});
        return res.json({authed:true,allowed:true,userId:auth.userId,plan:plan.slug,error:null,maxUploadMb:25,cloud:true,workspaceId:chosen.owner_id,workspaceOwner:chosen.owner,workspaces});
      }
      identities.set(req,chosen.owner_id);tenant.active++;tenant.used=Date.now();let released=false;const release=()=>{if(!released){tenant.active--;released=true;}};res.once('finish',release);res.once('close',release);
      next();
    }catch(e){res.status(e.status||503).json({error:e.status?e.message:'Boardly could not check account access. Please try again.'});}
  });
  app.use(tailnet.router);
  app.use(personal.router);
  app.use(chatgpt.router);
  app.use(require('./onboarding').createOnboarding(personal.db));
  app.get('/api/billing/status',async(req,res,next)=>{try{const state=await personal.billing.state(req.cloudUserId);res.setHeader('cache-control','no-store');res.json({ready:state.ready,ai_active:state.ai,extra_users:state.extra_users,paid_extra_users:state.paid_extra_users,complimentary_users:state.complimentary_users,subscriptions:req.workspaceIsOwner?(state.subscriptions||[]).filter(s=>!['canceled','incomplete_expired'].includes(s.status)).map(s=>({id:s.id,status:s.status,kind:s.metadata?.kind||'subscription',cancel_at_period_end:!!s.cancel_at_period_end,period_end:s.cancel_at||s.current_period_end||Math.max(...s.items.data.map(i=>i.current_period_end||0)),scheduled_change:!!s.schedule})):[]});}catch(e){next(e);}});
  app.post('/api/billing/portal',async(req,res,next)=>{try{res.json(await personal.billing.portal(req.cloudUserId));}catch(e){next(e);}});
  app.post('/api/billing/checkout',express.json({limit:'4kb'}),async(req,res,next)=>{try{if(!req.workspaceIsOwner)throw Object.assign(Error('Only the account owner can purchase the workspace plan or additional users'),{status:403});if(!['serial_entrepreneur','agency','extra_users'].includes(req.body?.kind))throw Object.assign(Error('Choose a plan or additional users'),{status:400});res.json(await personal.billing.checkout(req.cloudUserId,req.body.kind,req.body.quantity));}catch(e){next(e);}});
  app.use(async(req,res,next)=>{try{
    if(!req.tenant)return next();
    const payer=req.workspaceOwnerId,mode=personal.account(payer).mode;
    const subscription=payer===config.ownerId&&mode==='none';
    req.aiRuntime=req.workspaceIsOwner&&subscription?'codex':'api';
    req.aiFunding=subscription?'owner_subscription':mode==='chatgpt'?'owner_chatgpt':'owner_api';
    req.personalAiAllowed=subscription?req.tenant.subscription.online():mode==='chatgpt'?chatgpt.configured:mode==='key'||(mode==='card'&&personal.summary(payer).billing_ready);
    if(req.aiRuntime==='api'&&req.method==='POST'&&(/^\/api\/chat\/threads\/[^/]+\/messages$/.test(req.path)||/^\/api\/boards\/\d+\/agent$/.test(req.path)||/^\/api\/agents\/(company|board)\/\d+\/swarms$/.test(req.path)||/^\/api\/discussions\/threads\/[^/]+\/messages$/.test(req.path)||/^\/api\/audio\/(project|company|board)\/\d+\/work$/.test(req.path))){
      if(subscription&&!req.personalAiAllowed)throw Object.assign(Error('The company owner’s subscription worker is offline. Ask the owner to reconnect it.'),{status:503});
      if(!subscription)try{await(mode==='chatgpt'?chatgpt.authorize(payer):personal.authorize(payer));}catch(e){if(!req.workspaceIsOwner)throw Object.assign(Error('Company AI funding is unavailable. Ask the company owner to check Account & AI.'),{status:e.status||503});throw e;}
    }
    next();
  }catch(e){next(e);}});

  app.get('/api/account/plan',(req,res)=>res.json({plan:req.accountPlan,owner:req.workspaceIsOwner,usage:{...memberships.usage(req.workspaceOwnerId),companies:req.tenant.app.db.prepare('SELECT COUNT(*) AS n FROM companies').get().n,storage_bytes:require('./project-assets').storageUsage(req.tenant.app.db).usedBytes},plans:Object.values(PLANS),billing_ready:personal.billing.ready(),extra_user_monthly_price:9,company_limit:req.accountPlan.companies,user_limit:req.accountPlan.users}));
  app.use(require('./member-routes').createMemberRoutes({memberships,identity,origin:config.origin}));
  app.use(require('./company-chat').createCompanyChatRoutes({memberships}));
  app.use(require('./audio').createAudioRoutes({config:config.audio, memberships}));
  app.use(require('./computeruse-connections').createComputerUseRoutes({memberships}));
  app.use(require('./project-computers').createComputerRoutes({memberships}));
  app.use((req,res,next)=>{
    if(!req.tenant||req.workspaceIsOwner)return next();
    require('./member-access').memberGuard({db:req.tenant.app.db,memberships,ownerId:req.workspaceOwnerId,userId:req.cloudUserId})(req,res,next);
  });
  app.use((req,res,next)=>{
    next();
  });

  app.get('/api/connections', (req, res) => res.json({ connections: connections.list(req.cloudUserId), origin: config.origin }));
  app.post('/api/connections', express.json({ limit: '4kb' }), (req, res) => {
    const name = req.body?.name, scope = req.body?.scope;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || !['mcp', 'sync', 'worker'].includes(scope)) return res.status(400).json({ error: 'Enter a connection name and type' });
    if (connections.list(req.cloudUserId).filter(c => !c.revoked_at && c.expires_at > Date.now()).length >= 30) return res.status(400).json({ error: 'Revoke an unused connection before adding another' });
    res.status(201).json(connections.issue(req.cloudUserId, name.trim(), scope));
  });
  app.delete('/api/connections/:id', (req, res) => {
    if (!connections.revoke(req.cloudUserId, req.params.id)) return res.status(404).json({ error: 'Connection not found' });
    res.json({ ok: true });
  });
  app.post('/mcp', express.json({ limit: '4mb' }), async (req, res, next) => {
    const server = createBoardlyServer({ db: req.tenant.app.db, uploadsDir: req.tenant.uploadsDir });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { next(error); }
  });
  app.all('/mcp', (req, res) => res.status(405).json({ error: 'Use Streamable HTTP POST' }));
  app.use((req, res, next) => {
    if (!req.tenant) return next();
    if (/^\/api\/(chat|worker|agents|swarms|discussions)(\/|$)/i.test(req.path) || /^\/api\/boards\/\d+\/(chat\/|agent$)/i.test(req.path)) return req.tenant.subscription.router(req,res,err=>err?next(err):req.tenant.chat(req, res, next));
    if(/^\/api\/account\/github(?:\/|$)/.test(req.path))return req.tenant.github.router(req,res,next);
    if(/^\/api\/account\/ssh(?:\/|$)/.test(req.path))return req.tenant.ssh.router(req,res,next);
    if (/^\/api\/(sync|account)(\/|$)/i.test(req.path)) return req.tenant.hub(req, res, () => res.status(404).json({ error: 'Sync endpoint not found' }));
    if(/^\/api\/(companies|projects)\/\d+\/ssh(?:\/|$)/.test(req.path))return req.tenant.ssh.router(req,res,next);
    if(/^\/api\/(companies|projects)\/\d+\/github(?:\/|$)/.test(req.path))return req.tenant.github.router(req,res,next);
    req.tenant.email.router(req, res, err => err ? next(err) : req.tenant.payments.router(req, res, err => err ? next(err) : req.tenant.environment.router(req, res, err => err ? next(err) : req.tenant.assets(req, res, err => err ? next(err) : req.tenant.app(req, res, next)))));
  });
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api(?:\/|$)|uploads(?:\/|$)|auth(?:\/|$)|mcp(?:\/|$)).*/i, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status >= 400 && err.status < 600 ? err.status : err.code === 'LIMIT_FILE_SIZE' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status !== 500 && err.status && status !== 413 ? err.message : status === 413 ? 'Upload is too large' : status === 400 ? 'Invalid JSON' : 'Request could not be completed' });
  });
  let cloudClosed=false,recoveringCloud=false;
  const recoverCloud=async()=>{if(cloudClosed||recoveringCloud)return;recoveringCloud=true;try{for(const ownerId of connections.workspaceOwners()){
    if(cloudClosed)break;if(tenants.has(ownerId)){tenants.get(ownerId).chat.hosted.enqueue();continue;}
    const file=path.join(workspacePath(config.dataDir,ownerId),'app.db');if(!fs.existsSync(file))continue;
    const db=new(require('better-sqlite3'))(file,{readonly:true});let pending=false;try{pending=!!db.prepare("SELECT 1 FROM chat_jobs WHERE runtime='api' AND (status='queued' OR (mode='work' AND status='running')) LIMIT 1").get();}catch{}finally{db.close();}if(!pending)continue;
    let plan;if(personal.billing.ready()){const billed=await personal.billing.state(ownerId);plan={...billed.plan,extra_users:billed.extra_users,users:billed.plan.users===null?null:billed.plan.users+billed.extra_users};}else plan=await planService.sponsored(ownerId);
    if(!cloudClosed&&plan)tenantFor(ownerId,plan).chat.hosted.enqueue();
  }}catch{/* Retry recovery after transient provider/storage failures. */}finally{recoveringCloud=false;}};
  const recoveryTimer=setInterval(recoverCloud,15000);recoveryTimer.unref();queueMicrotask(recoverCloud);
  app.closeWorkspaces = () => {cloudClosed=true;clearInterval(recoveryTimer);

    for (const tenant of tenants.values()) { tenant.chat.hosted.close();tenant.subscription.close();tenant.app.stopSync(); tenant.app.db.close(); }
    tenants.clear(); connections.close(); memberships.close(); personal.close();
  };
  return app;
}

module.exports = { createCloudApp, readCloudConfig, workspacePath, accessFor };
