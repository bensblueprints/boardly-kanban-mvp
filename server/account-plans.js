const GiB = 1024 ** 3;
const PLANS = {
  basic: { slug:'basic', name:'Basic Free', monthly_price:0, companies:1, users:1, storage_bytes:2*GiB },
  serial_entrepreneur: { slug:'serial_entrepreneur', name:'Serial Entrepreneur', monthly_price:79, companies:3, users:5, storage_bytes:10*GiB },
  agency: { slug:'agency', name:'Agency', monthly_price:299, companies:100, users:300, storage_bytes:1024*GiB },
};
const OWNER = {slug:'owner',name:'Owner',monthly_price:0,companies:null,users:null,storage_bytes:null};
function planFor(auth,config) {
  if(auth.userId===config.ownerId)return OWNER;
  for(const slug of ['agency','serial_entrepreneur'])if(auth.has?.({plan:`u:${slug}`}))return PLANS[slug];
  return PLANS.basic;
}
function createPlanService(config,identity) {
  const cached=new Map();
  async function sponsored(ownerId) {
    if(ownerId===config.ownerId)return OWNER;
    if(config.ownerOnly)return null;
    const found=cached.get(ownerId);if(found&&found.until>Date.now())return found.value;
    try {
      const subscription=await identity.billing.getUserBillingSubscription(ownerId);
      const now=Date.now();
      const slugs=(subscription.subscriptionItems||[]).filter(i=>['active','free_trialing'].includes(i.status)&&(!i.periodEnd||i.periodEnd>now)).map(i=>i.plan?.slug);
      const value=slugs.includes('agency')?PLANS.agency:slugs.includes('serial_entrepreneur')?PLANS.serial_entrepreneur:PLANS.basic;
      cached.set(ownerId,{until:now+30000,value});return value;
    } catch(e) {if(e.status===404)return PLANS.basic;throw Object.assign(Error('Could not verify the sponsoring account plan. Try again shortly.'),{status:503});}
  }
  return {sponsored};
}
module.exports={PLANS,OWNER,planFor,createPlanService};
