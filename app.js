import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { db, handler } from './server.js';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const WALLET = '0x5e8685a52afe9bbe8e70e118816802672c74d3e1';
const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://facilitator.xpay.sh';
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({url:facilitatorUrl}))
  .register('eip155:8453', new ExactEvmScheme());
resourceServer.onAfterSettle(async ctx => {
  // The SDK fires this hook only after a successful, verified onchain settlement.
  const tx = String(ctx.result?.transaction || '');
  if (!/^0x[a-fA-F0-9]{64}$/.test(tx)) return;
  const amount = String(ctx.requirements?.amount || '0');
  if (!/^\d+$/.test(amount) || ctx.requirements?.network !== 'eip155:8453') return;
  try {
    db.prepare('INSERT OR IGNORE INTO paid_requests(transaction_hash,network,amount_atomic,payer,settled_at) VALUES(?,?,?,?,?)')
      .run(tx,'eip155:8453',amount,String(ctx.result?.payer||''),Date.now());
  } catch(error) { console.error('Payment ledger recording failed:',error); }
});

app.disable('x-powered-by');
app.use(paymentMiddleware({
  'GET /api/paid-search':{
    accepts:[{scheme:'exact',price:'$0.05',network:'eip155:8453',payTo:WALLET}],
    description:'Premium structured AI catalogue search with ranked tool metadata',
    mimeType:'application/json',
  }
},resourceServer));

function search(req,res) {
  const query=String(req.query.q||'').trim().slice(0,100).toLowerCase();
  const category=String(req.query.category||'').trim().slice(0,70).toLowerCase();
  const limit=Math.max(1,Math.min(10,Number.parseInt(req.query.limit,10)||10));
  const rows=db.prepare('SELECT name,slug,category,summary,description,website_url,pricing,tags FROM listings WHERE active=1').all();
  const terms=query.split(/\s+/).filter(Boolean).slice(0,12);
  const hits=rows.filter(r=>!category || r.category.toLowerCase()===category).map(r=>{
    const fields=[r.name,r.summary,r.description,r.category,r.tags].map(x=>String(x).toLowerCase());
    const score=terms.length ? terms.reduce((a,t)=>a+(fields[0].includes(t)?8:0)+(fields[1].includes(t)?5:0)+(fields[2].includes(t)?2:0)+(fields[3].includes(t)?3:0)+(fields[4].includes(t)?4:0),0):1;
    return {r,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.r.name.localeCompare(b.r.name)).slice(0,limit).map(x=>({...x.r,match_score:x.score}));
  res.set('Cache-Control','no-store').json({query,category,results:hits,count:hits.length,paid:true,currency:'USDC',network:'Base',priceUSD:'0.05',source:'Agent Index catalogue'});
}
app.get('/api/paid-search',search);
app.use((req,res)=>handler(req,res));
app.listen(PORT,'0.0.0.0',async () => {
  console.log(`AI catalogue + x402 on port ${PORT}`);
  if (process.env.DISCOVERY_SELF_TEST === '1') {
    const checks=[
      ['/','html'],['/agents','html'],['/robots.txt','text'],['/llms.txt','text'],
      ['/sitemap.xml','xml'],['/openapi.json','openapi'],
      ['/.well-known/x402','manifest'],['/api/categories','categories'],
      ['/api/catalogue?q=agent&limit=5','catalogue']
    ];
    for (const [route,type] of checks) {
      try {
        const response=await fetch(`http://127.0.0.1:${PORT}${route}`,{signal:AbortSignal.timeout(7000)});
        const body=await response.text();
        let valid=response.ok;
        if(type==='openapi'){const v=JSON.parse(body);valid=valid&&!!v.openapi&&!!v.paths?.['/api/paid-search']?.get?.['x-payment-info'];}
        if(type==='manifest'){const v=JSON.parse(body);valid=valid&&v.resources?.some(x=>x.includes('/api/paid-search'));}
        if(type==='catalogue'){const v=JSON.parse(body);valid=valid&&Array.isArray(v.results)&&v.total>=20;}
        if(type==='categories'){const v=JSON.parse(body);valid=valid&&Array.isArray(v.categories);}
        if(type==='html'){valid=valid&&body.includes('Agent Index')&&body.includes('<meta name="description"');}
        if(type==='text'){valid=valid&&body.length>20;}
        if(type==='xml'){valid=valid&&body.includes('<urlset');}
        console.log(`DISCOVERY_SELF_TEST route=${route} status=${response.status} valid=${valid}`);
      } catch(error) {console.error(`DISCOVERY_SELF_TEST route=${route} error=${error.message}`);}
    }
  }
  if (process.env.PAYMENT_SELF_TEST === '1') {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/paid-search?q=security`, {
        headers: { accept: 'application/json', 'user-agent': 'AgentIndex-Payment-SelfTest/1.0' },
        signal: AbortSignal.timeout(12000),
      });
      const hasPaymentHeader = Boolean(response.headers.get('payment-required'));
      const body = await response.text();
      console.log(`PAYMENT_SELF_TEST status=${response.status} payment_required_header=${hasPaymentHeader} body_has_payment_requirements=${body.includes('paymentRequirements') || body.includes('accepts')}`);
    } catch (error) {
      console.error('PAYMENT_SELF_TEST error:', error.message);
    }
  }
});
