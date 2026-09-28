const {readCloudConfig}=require('/app/server/cloud');
const {createBilling}=require('/app/server/customer-billing');
const Database=require('/app/node_modules/better-sqlite3');
const config=readCloudConfig(),db=new Database(':memory:');
const billing=createBilling({db,config});
console.log(JSON.stringify({ready:billing.ready(),origin:config.origin,portal_configured:!!config.billing.portalConfiguration,live_secret:config.billing.secretKey?.startsWith('sk_live_'),webhook_configured:!!config.billing.webhookSecret,paid_ai_enabled:!!config.openaiApiKey,account_return_url:config.origin+'/app#/account'}));
db.close();
