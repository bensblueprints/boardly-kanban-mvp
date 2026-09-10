#!/usr/bin/env node
// Offline preview only. Does not create a product, subscription or charge.
const {COMPUTER_PLAN:p}=require('../server/project-computers');
console.log(JSON.stringify({action:'preview_only',product:{name:'Boardly project computer — 8 GB RAM / 150 GB storage',metadata:{application:'boardly',kind:'project_computer',plan:p.id}},price:{currency:p.currency,unit_amount:p.monthly_cents,recurring:{interval:'month',usage_type:'licensed'}},activation_requires:['Verified physical capacity and isolated desktop template','Configured Stripe account, computer price, signed webhook and hosted checkout','Atomic capacity reservations and paid subscription-to-computer reconciliation','Test purchase, renewal, cancellation, failed payment and desktop revocation']},null,2));
