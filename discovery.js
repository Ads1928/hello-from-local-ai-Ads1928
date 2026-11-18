// Public, read-only discovery surfaces. No payment credentials or secrets are exposed.
const WALLET = '0x5e8685a52afe9bbe8e70e118816802672c74d3e1';

function send(res, status, contentType, body, cache='public, max-age=300') {
  res.writeHead(status, {
    'Content-Type':contentType,
    'Cache-Control':cache,
    'X-Content-Type-Options':'nosniff',
    'Access-Control-Allow-Origin':'*',
  });
  res.end(body);
}
function json(res, value, status=200) {
  send(res,status,'application/json; charset=utf-8',JSON.stringify(value));
}
function countApi(db,route) {
  try {
    const day=new Date().toISOString().slice(0,10);
    db.prepare('INSERT INTO api_usage(day,route,calls) VALUES (?,?,1) ON CONFLICT(day,route) DO UPDATE SET calls=calls+1').run(day,route);
  } catch(error) { console.error('API usage counter failed:',error); }
}
function openApi(host,title) {
  return {
    openapi:'3.1.0',
    info:{
      title:`${title} — AI tool discovery API`,
      version:'1.0.0',
      description:'Independent directory of AI agents, APIs, models and automation tools. Browse summaries for free, or pay $0.05 USDC on Base via x402 for ranked, detailed premium search results.'
    },
    servers:[{url:host}],
    'x-discovery':{ownershipProofs:[WALLET]},
    paths:{
      '/api/catalogue':{
        get:{
          summary:'Free catalogue discovery',
          operationId:'listCatalogue',
          description:'Find publicly listed AI tools. No payment or authentication is needed.',
          parameters:[
            {name:'q',in:'query',schema:{type:'string',maxLength:100},description:'Optional search terms'},
            {name:'category',in:'query',schema:{type:'string'},description:'Optional category'},
            {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}},
            {name:'offset',in:'query',schema:{type:'integer',minimum:0,default:0}}
          ],
          responses:{'200':{description:'Public listings with pagination',content:{'application/json':{schema:{type:'object'}}}}}
        }
      },
      '/api/categories':{
        get:{summary:'Browse tool categories',operationId:'listCategories',responses:{'200':{description:'Category counts'}}}
      },
      '/api/paid-search':{
        get:{
          summary:'Premium ranked AI-tool search (x402)',
          operationId:'premiumAgentSearch',
          description:'Search and rank AI tools with detailed descriptions, tags, official URLs and matching scores. Pay only when you choose to use this endpoint.',
          parameters:[
            {name:'q',in:'query',schema:{type:'string',maxLength:100},description:'Search terms, e.g. website automation'},
            {name:'category',in:'query',schema:{type:'string'},description:'Optional category filter'},
            {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:10,default:10}}
          ],
          'x-payment-info':{
            protocols:['x402'],
            price:{mode:'fixed',currency:'USD',amount:'0.05'},
            network:'eip155:8453',asset:'USDC',payTo:WALLET
          },
          responses:{
            '200':{description:'Detailed ranked search results after payment'},
            '402':{description:'Payment Required — inspect the payment-required header for the x402 v2 payment challenge',headers:{'payment-required':{description:'Base64-encoded x402 payment requirements',schema:{type:'string'}}}}
          }
        }
      },
      '/api/paid-search/info':{
        get:{summary:'Read-only payment information',operationId:'paymentInfo',responses:{'200':{description:'Current paid search configuration'}}}
      }
    }
  };
}
export function discoveryRoute(req,res,{db,siteName,publicUrl}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const u = new URL(req.url,'http://localhost');
  const pathname=u.pathname;
  if (pathname==='/robots.txt') {
    send(res,200,'text/plain; charset=utf-8',`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/\nSitemap: ${publicUrl}/sitemap.xml\n`);
    return true;
  }
  if (pathname==='/llms.txt') {
    send(res,200,'text/plain; charset=utf-8',`# ${siteName}\n\nIndependent directory of AI agents, models, tools and APIs.\n\n## Read-only, free discovery\n- ${publicUrl}/api/catalogue — paginated JSON catalogue. Query with q, category, limit and offset.\n- ${publicUrl}/api/categories — category counts.\n- ${publicUrl}/sitemap.xml — indexable public directory pages.\n\n## Optional premium agent service\n- ${publicUrl}/api/paid-search — ranked and detailed results. Costs $0.05 USDC per successful payment on Base (x402 v2).\n- ${publicUrl}/openapi.json — canonical API specification with pricing.\n- ${publicUrl}/.well-known/x402 — paid-resource discovery manifest.\n- ${publicUrl}/api/paid-search/info — payment information.\n\nNo payment is needed to browse listings or use the free catalogue API. Agents should not assume an x402 payment will be approved by their operator. Prices and features of third-party tools should be verified with the official providers.\n`);
    return true;
  }
  if (pathname==='/openapi.json') {
    json(res,openApi(publicUrl,siteName));
    return true;
  }
  if (pathname==='/.well-known/x402') {
    json(res,{version:1,resources:[`${publicUrl}/api/paid-search`],ownershipProofs:[WALLET]});
    return true;
  }
  if (pathname==='/api/categories') {
    countApi(db,'categories');
    const rows=db.prepare('SELECT category, COUNT(*) AS count FROM listings WHERE active=1 GROUP BY category ORDER BY category').all();
    json(res,{categories:rows,updatedAt:new Date().toISOString()});
    return true;
  }
  if (pathname==='/api/catalogue') {
    countApi(db,'catalogue');
    const q=String(u.searchParams.get('q')||'').trim().toLowerCase().slice(0,100);
    const category=String(u.searchParams.get('category')||'').trim().slice(0,70);
    const limit=Math.max(1,Math.min(50,Number.parseInt(u.searchParams.get('limit'),10)||20));
    const offset=Math.max(0,Math.min(10000,Number.parseInt(u.searchParams.get('offset'),10)||0));
    let where='active=1',args=[];
    if (q) {
      where+=' AND (LOWER(name) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(tags) LIKE ?)';
      const v=`%${q}%`;args.push(v,v,v);
    }
    if (category) {where+=' AND category=?';args.push(category);}
    const total=db.prepare(`SELECT COUNT(*) AS count FROM listings WHERE ${where}`).get(...args).count;
    const results=db.prepare(`SELECT name,slug,category,summary,pricing,updated_at FROM listings WHERE ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args,limit,offset)
      .map(r=>({name:r.name,slug:r.slug,category:r.category,summary:r.summary,pricing:r.pricing,url:`${publicUrl}/tools/${encodeURIComponent(r.slug)}`,updatedAt:new Date(r.updated_at).toISOString()}));
    json(res,{name:siteName,query:q,category,offset,limit,total,results,hasMore:offset+results.length<total,premiumSearch:`${publicUrl}/api/paid-search`,openapi:`${publicUrl}/openapi.json`});
    return true;
  }
  return false;
}
