import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const SITE_NAME = process.env.SITE_NAME || 'Agent Index';
const DB_PATH = path.resolve(root, process.env.DB_PATH || './data/catalogue.sqlite');
const SECRET = process.env.APP_SECRET || 'unsafe-development-only-secret';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
if (process.env.NODE_ENV === 'production' && (SECRET.length < 32 || ADMIN_PASSWORD.length < 12)) {
  throw new Error('Set APP_SECRET (at least 32 characters) and ADMIN_PASSWORD (at least 12 characters) in Render environment variables.');
}
if (SECRET === 'unsafe-development-only-secret') console.warn('APP_SECRET not set; for local development only.');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS listings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 slug TEXT NOT NULL UNIQUE,
 category TEXT NOT NULL,
 summary TEXT NOT NULL,
 description TEXT NOT NULL,
 website_url TEXT NOT NULL,
 pricing TEXT NOT NULL DEFAULT 'See provider',
 tags TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 total_views INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS views (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
 visitor_hash TEXT NOT NULL,
 bucket INTEGER NOT NULL,
 viewed_at INTEGER NOT NULL,
 UNIQUE(listing_id, visitor_hash, bucket)
);
CREATE INDEX IF NOT EXISTS views_by_date ON views(viewed_at);
CREATE INDEX IF NOT EXISTS views_by_listing ON views(listing_id, viewed_at);
CREATE TABLE IF NOT EXISTS searches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 query TEXT NOT NULL,
 searched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_by_date ON searches(searched_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paid_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 transaction_hash TEXT NOT NULL UNIQUE,
 network TEXT NOT NULL,
 amount_atomic TEXT NOT NULL,
 payer TEXT NOT NULL,
 settled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_requests_by_date ON paid_requests(settled_at);`);
if (!db.prepare('PRAGMA table_info(listings)').all().some(x=>x.name==='total_views')) {
  db.exec('ALTER TABLE listings ADD COLUMN total_views INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE listings SET total_views=(SELECT COUNT(*) FROM views v WHERE v.listing_id=listings.id)');
}

const starters = [
 ['ChatGPT','AI assistants','Conversational AI for writing, analysis, learning and everyday tasks.','ChatGPT is an AI assistant from OpenAI. Explore its current capabilities and plans on the official website.','https://chatgpt.com','See provider','chat,assistant,writing'],
 ['Claude','AI assistants','AI assistant for writing, coding and working with information.','Claude is an AI assistant created by Anthropic. Visit its official website for current product details.','https://claude.ai','See provider','assistant,coding,writing'],
 ['Google Gemini','AI assistants','Google AI assistant for research, ideas and everyday productivity.','Gemini is Google’s AI assistant. Visit the official website for the current product and availability.','https://gemini.google.com','See provider','assistant,google,research'],
 ['Perplexity','Research & search','Search and answer tool focused on finding and explaining information.','Perplexity provides AI-assisted search and research. Verify available plans with the provider.','https://www.perplexity.ai','See provider','search,research,answers'],
 ['Ollama','Developer tools','Run and manage supported AI models locally.','Ollama provides tools for working with AI models on your own computer.','https://ollama.com','See provider','local-llm,models,developer'],
 ['OpenRouter','APIs & models','Access a range of AI models through a unified API.','OpenRouter provides developer access to different models. Pricing and availability vary by provider.','https://openrouter.ai','See provider','api,models,developer'],
 ['Hugging Face','APIs & models','Discover AI models, datasets and community tools.','Hugging Face hosts models, datasets and resources for machine learning practitioners.','https://huggingface.co','See provider','models,datasets,community'],
 ['Replicate','APIs & models','Run machine-learning models using an API.','Replicate provides hosted models and APIs for AI developers.','https://replicate.com','See provider','api,inference,models'],
 ['n8n','Automation','Build workflows and connect tools through visual automation.','n8n is a workflow automation platform with AI integrations.','https://n8n.io','See provider','workflow,automation,agents'],
 ['ElevenLabs','Audio & voice','Tools for AI-generated speech and voice applications.','ElevenLabs provides AI voice and audio tools.','https://elevenlabs.io','See provider','voice,audio,speech'],
 ['LangChain','Developer tools','Frameworks and tools for building applications using language models.','LangChain provides tools for developing language-model applications and agents.','https://www.langchain.com','See provider','agents,framework,developer'],
 ['Zapier','Automation','Connect apps and automate repetitive tasks.','Zapier provides automation tools for businesses and individuals.','https://zapier.com','See provider','workflow,automation,integration']
];
function slugify(str) { return str.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'listing'; }
if (!db.prepare("SELECT value FROM settings WHERE key='seeded'").get()) {
  if (db.prepare("SELECT COUNT(*) AS n FROM listings").get().n===0) {
  const insert = db.prepare('INSERT INTO listings (name,slug,category,summary,description,website_url,pricing,tags,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)');
  for (const [name, category, summary, description, url, pricing, tags] of starters) {
    const now=Date.now(); insert.run(name,slugify(name),category,summary,description,url,pricing,tags,now,now);
  }
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('seeded','1')").run();
}

const esc = (value='') => String(value ?? '').replace(/[&<>"']/g, x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const number = value => Number(value || 0).toLocaleString('en-GB');
const niceDate = ms => new Date(Number(ms)).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'});
const age = ms => { const min = Math.max(0, Math.floor((Date.now()-Number(ms))/60000)); return min<2?'just now':min<60?`${min}m ago`:min<1440?`${Math.floor(min/60)}h ago`:`${Math.floor(min/1440)}d ago`; };
const categories = () => db.prepare('SELECT DISTINCT category FROM listings WHERE active=1 ORDER BY category').all().map(x=>x.category);
const calcCookie = (payload) => `${payload}.${crypto.createHmac('sha256',SECRET).update(payload).digest('base64url')}`;
const sessionCookieName='agent_admin';
function signedSession(req) {
  const item=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(sessionCookieName+'='));
  if (!item) return null;
  const value=item.slice(sessionCookieName.length+1), i=value.lastIndexOf('.');
  if(i===-1) return null;
  const payload=value.slice(0,i), actual=value.slice(i+1), expected=crypto.createHmac('sha256',SECRET).update(payload).digest('base64url');
  if(actual.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) return null;
  try { const data=JSON.parse(Buffer.from(payload,'base64url').toString()); return data.exp>Date.now()?data:null; } catch {return null;}
}
function tokenFor(s) { return crypto.createHmac('sha256',SECRET).update('csrf-'+s.nonce).digest('hex'); }
function matchCsrf(s,form) { const a=String(form._csrf||''), b=tokenFor(s); return a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)); }
function cookie(value,maxAge=12*3600) { return `${sessionCookieName}=${value}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`; }
function hashVisitor(req) {
  const day=new Date().toISOString().slice(0,10);
  const peer = process.env.RENDER ? (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim() : req.socket.remoteAddress;
  return crypto.createHmac('sha256',SECRET).update(`${day}|${peer}|${req.headers['user-agent']||''}`).digest('hex');
}
function isHuman(req) {const ua=req.headers['user-agent']||''; return !!ua && !/(bot|crawl|spider|slurp|facebookexternalhit|preview|headless|curl|wget|python|postman|lighthouse|uptime|monitor|google|bing|yandex)/i.test(ua) && req.headers.purpose!=='prefetch' && req.headers['sec-purpose']!=='prefetch';}
function countView(req,id) {
  if(!isHuman(req) || signedSession(req)) return;
  const now=Date.now();
  const inserted=db.prepare('INSERT OR IGNORE INTO views (listing_id,visitor_hash,bucket,viewed_at) VALUES (?,?,?,?)').run(id,hashVisitor(req),Math.floor(now/(30*60000)),now);
  if (inserted.changes) db.prepare('UPDATE listings SET total_views=total_views+1 WHERE id=?').run(id);
}
function recordSearch(req,q) {
  if(!isHuman(req) || !q || signedSession(req)) return;
  db.prepare('INSERT INTO searches (query,searched_at) VALUES (?,?)').run(q.toLowerCase().slice(0,100),Date.now());
}
function cleanOldEvents() { const cutoff=Date.now()-90*86400000; db.prepare('DELETE FROM views WHERE viewed_at < ?').run(cutoff); db.prepare('DELETE FROM searches WHERE searched_at < ?').run(cutoff); }
cleanOldEvents();
const maintenance=setInterval(cleanOldEvents,24*3600000); maintenance.unref();
function response(res,body,status=200,headers={}) {
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",...headers});
  res.end(body);
}
function redirect(res,to,headers={}) { res.writeHead(303,{Location:to,...headers}); res.end(); }
function layout(title,content,admin=false) {
  const header=admin?`<header class="topbar"><a class="logo" href="/admin"><span class="logo-mark">◈</span>${esc(SITE_NAME)}<span class="tag">ADMIN</span></a><div class="nav"><a href="/admin" class="${title==='Dashboard'?'selected':''}">Overview</a><a href="/admin/listings" class="${title==='Manage listings'?'selected':''}">Listings</a><a href="/admin/earnings" class="${title==='AI payments'?'selected':''}">AI payments</a><a href="/" target="_blank" rel="noopener">View website ↗</a><form action="/admin/logout" method="post" class="inline"><button class="linkbutton" type="submit">Sign out</button></form></div></header>`
  :`<header class="topbar"><a class="logo" href="/"><span class="logo-mark">◈</span>${esc(SITE_NAME)}</a><div class="nav"><a href="/">Discover</a><a href="/api/paid-search/info">Agent API</a><a href="/privacy">Privacy</a></div></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a1119"><meta name="description" content="Discover and compare AI agents, models, APIs and automation tools"><title>${esc(title)} · ${esc(SITE_NAME)}</title><link rel="stylesheet" href="/public/styles.css"></head><body>${header}<main class="shell">${content}</main><footer><div class="shell foot"><span>${esc(SITE_NAME)} <span class="muted">· Working title</span></span><span class="muted">Independent directory · Product details should be checked with providers</span></div></footer></body></html>`;
}
const categoryIcon={'AI assistants':'✳','Research & search':'⌕','Developer tools':'⌘','APIs & models':'▣','Automation':'↗','Audio & voice':'♫'};
function listingCard(x) { return `<a href="/tools/${encodeURIComponent(x.slug)}" class="listing-card"><div class="card-head"><span class="app-icon">${esc(categoryIcon[x.category]||'◈')}</span><span class="chevron">↗</span></div><h3>${esc(x.name)}</h3><p>${esc(x.summary)}</p><div class="card-bottom"><span class="tiny-pill">${esc(x.category)}</span><span class="muted tiny">${esc(x.pricing)}</span></div></a>`; }
function cataloguePage(q='',cat='') {
  let sql='SELECT * FROM listings WHERE active=1'; let params=[];
  if(q) {sql+=' AND (name LIKE ? OR summary LIKE ? OR description LIKE ? OR tags LIKE ?)'; let term=`%${q}%`; params.push(term,term,term,term);}
  if(cat) {sql+=' AND category=?';params.push(cat);}
  sql+=' ORDER BY name COLLATE NOCASE'; const list=db.prepare(sql).all(...params);
  const filters=`<form class="search" method="get" action="/search"><div class="search-box"><span class="glass">⌕</span><input type="search" name="q" value="${esc(q)}" placeholder="Search AI agents, APIs and tools…" maxlength="100" aria-label="Search catalogue"><button type="submit" class="primary">Search</button></div><div class="filters"><label for="cat">Category</label><select name="category" id="cat"><option value="">All categories</option>${categories().map(c=>`<option value="${esc(c)}" ${cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select><span class="results">${number(list.length)} tools</span></div></form>`;
  return layout('Discover',`<section class="hero"><div class="eyebrow"><span class="dot"></span> INDEPENDENT AI DIRECTORY</div><h1>Find the right <em>AI tool</em><br>for whatever's next.</h1><p class="lede">A useful, searchable catalogue of AI agents, tools and APIs. No noise, just places to start exploring.</p></section>${filters}<div class="section-head"><div><div class="eyebrow soft">EXPLORE THE DIRECTORY</div><h2>${q||cat?'Search results':'Browse all tools'}</h2></div><p class="muted">${number(list.length)} listings</p></div>${list.length?`<section class="cards">${list.map(listingCard).join('')}</section>`:`<div class="empty"><h3>No matches found</h3><p>Try a different search or category.</p><a class="button outline" href="/">Clear filters</a></div>`}`);
}
function detailPage(x) {
  const other=db.prepare('SELECT * FROM listings WHERE active=1 AND category=? AND id!=? LIMIT 3').all(x.category,x.id);
  return layout(x.name,`<div class="breadcrumbs"><a href="/">Directory</a> <span>/</span> ${esc(x.category)} <span>/</span> ${esc(x.name)}</div><section class="detail"><div class="detail-main"><span class="app-icon large">${esc(categoryIcon[x.category]||'◈')}</span><div class="eyebrow">${esc(x.category)}</div><h1>${esc(x.name)}</h1><p class="lede">${esc(x.summary)}</p><div class="action-row"><a class="button primary" href="${esc(x.website_url)}" rel="noopener noreferrer" target="_blank">Visit official website ↗</a><span class="tiny-pill">${esc(x.pricing)}</span></div><section class="description"><h2>About this tool</h2><p>${esc(x.description)}</p></section>${x.tags?`<div class="tags">${x.tags.split(',').map(t=>`<span class="tiny-pill">${esc(t.trim())}</span>`).join('')}</div>`:''}</div><aside class="detail-side"><div class="eyebrow soft">AT A GLANCE</div><div class="side-row"><span>Category</span><b>${esc(x.category)}</b></div><div class="side-row"><span>Pricing</span><b>${esc(x.pricing)}</b></div><div class="side-row"><span>Website</span><a href="${esc(x.website_url)}" rel="noopener noreferrer" target="_blank">Official link ↗</a></div><p class="side-note">Listings are informational. Check product features and prices directly with each provider.</p></aside></section>${other.length?`<section class="related"><div class="section-head"><h2>Similar tools</h2></div><div class="cards">${other.map(listingCard).join('')}</div></section>`:''}`);
}
function metric(label,value,description,icon) {return `<div class="metric"><div class="metric-top"><span>${esc(label)}</span><span class="metric-icon">${icon}</span></div><strong>${number(value)}</strong><small>${esc(description)}</small></div>`;}
function graph(days) {
  const max=Math.max(1,...days.map(x=>x.count));
  const coordinates=days.map((x,i)=>`${Math.round(i*800/(days.length-1))},${Math.round(160-x.count/max*135)}`).join(' ');
  const fill=`0,176 ${coordinates} 800,176`;
  return `<div class="chart-outer"><svg class="chart" viewBox="0 0 800 190" role="img" aria-label="Daily views over the last fourteen days"><line x1="0" y1="160" x2="800" y2="160" class="axis"/><line x1="0" y1="90" x2="800" y2="90" class="axis"/><line x1="0" y1="20" x2="800" y2="20" class="axis"/><polygon points="${fill}" class="chart-fill"/><polyline points="${coordinates}" class="chart-line"/>${days.map((x,i)=>`<circle cx="${Math.round(i*800/(days.length-1))}" cy="${Math.round(160-x.count/max*135)}" r="3" class="chart-dot"><title>${esc(x.date)}: ${number(x.count)} views</title></circle>`).join('')}</svg><div class="chart-labels"><span>${esc(days[0].date.slice(5))}</span><span>${esc(days[6].date.slice(5))}</span><span>${esc(days[13].date.slice(5))}</span></div></div>`;
}
function dashboard(session) {
  const now=Date.now(), start7=now-7*86400000, start30=now-30*86400000;
  const stats={
    total:db.prepare('SELECT COUNT(*) AS n FROM listings').get().n,
    views:db.prepare('SELECT COUNT(*) AS n FROM views WHERE viewed_at>=?').get(start30).n,
    unique:db.prepare('SELECT COUNT(DISTINCT visitor_hash) AS n FROM views WHERE viewed_at>=?').get(start30).n,
    searches:db.prepare('SELECT COUNT(*) AS n FROM searches WHERE searched_at>=?').get(start30).n
  };
  const top=db.prepare(`SELECT l.id,l.name,l.slug,l.category,
    SUM(CASE WHEN v.viewed_at>=? THEN 1 ELSE 0 END) AS views7,
    SUM(CASE WHEN v.viewed_at>=? THEN 1 ELSE 0 END) AS views30,
    l.total_views AS viewsall
    FROM listings l LEFT JOIN views v ON l.id=v.listing_id GROUP BY l.id
    ORDER BY views30 DESC, viewsall DESC, l.name LIMIT 10`).all(start7,start30);
  const terms=db.prepare('SELECT query, COUNT(*) AS count FROM searches WHERE searched_at>=? GROUP BY query ORDER BY count DESC, query LIMIT 6').all(start30);
  const recent=db.prepare('SELECT l.name,l.slug,v.viewed_at FROM views v JOIN listings l ON l.id=v.listing_id ORDER BY v.viewed_at DESC LIMIT 8').all();
  const rawDays=db.prepare('SELECT strftime(\'%Y-%m-%d\',viewed_at/1000,\'unixepoch\') AS d, COUNT(*) AS n FROM views WHERE viewed_at>=? GROUP BY d').all(now-14*86400000);
  const lookup=Object.fromEntries(rawDays.map(x=>[x.d,x.n])); const days=Array.from({length:14},(_,i)=>{ const d=new Date(Date.now()-(13-i)*86400000).toISOString().slice(0,10); return {date:d,count:lookup[d]||0}; });
  const pay=db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_atomic AS INTEGER)),0) AS atomic FROM paid_requests').get();
  const earnings=`<section class="panel" style="margin-top:22px"><div class="panel-heading"><div><span class="eyebrow soft">AGENT PAYMENTS</span><h2>Paid API requests</h2></div><a href="/admin/earnings">View transactions ↗</a></div><div style="padding:18px 22px"><div class="strong" style="font-size:29px">$${(pay.atomic/1000000).toFixed(2)} USDC</div><p class="muted">${number(pay.n)} successful settlements logged · Base network · on free hosting, these statistics reset on redeploy</p></div></section>`;
  const maxTop=Math.max(1,...top.map(x=>x.views30));
  return layout('Dashboard',`<section class="admin-intro"><div><div class="eyebrow"><span class="dot"></span> PRIVATE ADMIN AREA</div><h1>Dashboard<span class="period">.</span></h1><p class="muted">A simple view of what people are exploring in your catalogue.</p></div><a class="button primary" href="/admin/listings/new">+ Add a listing</a></section><div class="metrics">${metric('Live listings',stats.total,'Published or draft entries','▤')}${metric('Listing views',stats.views,'Last 30 days · repeat visits limited','◉')}${metric('Visitor-days',stats.unique,'Approximate unique visitor-days · 30d','♙')}${metric('Searches',stats.searches,'Human searches · last 30 days','⌕')}</div><div class="dashboard-grid"><section class="panel wide"><div class="panel-heading"><div><span class="eyebrow soft">TRAFFIC TREND</span><h2>Views over time</h2></div><span class="period-pill">Last 14 days</span></div>${graph(days)}</section><section class="panel"><div class="panel-heading"><div><span class="eyebrow soft">MOST POPULAR</span><h2>Top listings</h2></div><a href="/admin/export.csv">Export CSV ↗</a></div><div class="scroll-table"><table><thead><tr><th>Listing</th><th class="right">7 days</th><th class="right">30 days</th><th class="right">All time</th></tr></thead><tbody>${top.map((l,i)=>`<tr><td><span class="rank">${i+1}</span><a class="table-link" href="/tools/${encodeURIComponent(l.slug)}" target="_blank" rel="noopener">${esc(l.name)}</a><div class="rank-bar"><meter min="0" max="100" value="${Math.round(l.views30/maxTop*100)}"></meter></div></td><td class="right">${number(l.views7)}</td><td class="right strong">${number(l.views30)}</td><td class="right">${number(l.viewsall)}</td></tr>`).join('')}</tbody></table></div></section><section class="panel half"><div class="panel-heading"><div><span class="eyebrow soft">USER INTERESTS</span><h2>Popular searches</h2></div><span class="period-pill">Last 30 days</span></div>${terms.length?`<div class="search-terms">${terms.map(x=>`<div class="term"><span>⌕ &nbsp;${esc(x.query)}</span><b>${number(x.count)}</b></div>`).join('')}</div>`:'<div class="empty-small">Search terms will appear here once people start using the site.</div>'}</section><section class="panel half"><div class="panel-heading"><div><span class="eyebrow soft">RECENT ACTIVITY</span><h2>Latest views</h2></div><span class="period-pill">Live</span></div>${recent.length?`<div class="activity">${recent.map(x=>`<div class="activity-row"><span class="activity-dot"></span><div><a href="/tools/${encodeURIComponent(x.slug)}" target="_blank" rel="noopener">${esc(x.name)}</a><small>Listing viewed</small></div><time title="${esc(niceDate(x.viewed_at))}">${esc(age(x.viewed_at))}</time></div>`).join('')}</div>`:'<div class="empty-small">No eligible views recorded yet.</div>'}</section></div>${earnings}<p class="privacy-note">Traffic analytics exclude recognised bots and admin visits, and limit repeat counts for the same listing within a 30-minute window. Visitor-days are estimates, not verified individual people. Events are automatically deleted after 90 days.</p>`,true);
}
function listingTable(session) {
  const list=db.prepare('SELECT l.*, l.total_views AS views FROM listings l ORDER BY l.updated_at DESC').all();
  return layout('Manage listings',`<section class="admin-intro"><div><div class="eyebrow"><span class="dot"></span> CONTENT MANAGEMENT</div><h1>Listings<span class="period">.</span></h1><p class="muted">Edit the catalogue without touching code.</p></div><a class="button primary" href="/admin/listings/new">+ Add a listing</a></section><section class="panel"><div class="panel-heading"><h2>${number(list.length)} listings</h2></div><div class="scroll-table"><table><thead><tr><th>Tool</th><th>Category</th><th>Status</th><th class="right">Views</th><th class="right">Manage</th></tr></thead><tbody>${list.map(x=>`<tr><td><div class="strong">${esc(x.name)}</div><div class="muted tiny">${esc(x.website_url)}</div></td><td>${esc(x.category)}</td><td><span class="status ${x.active?'published':'draft'}">${x.active?'Published':'Draft'}</span></td><td class="right">${number(x.views)}</td><td class="right"><a href="/admin/listings/${x.id}/edit">Edit ↗</a></td></tr>`).join('')}</tbody></table></div></section>`,true);
}
function editForm(item,csrf,error='') {
  const isEdit=!!item.id, id=item.id;
  const field=(label,key,kind='input',placeholder='')=>`<label class="form-field"><span>${label}</span>${kind==='textarea'?`<textarea name="${key}" rows="${key==='description'?5:3}" placeholder="${esc(placeholder)}" maxlength="${key==='description'?2000:350}" required>${esc(item[key])}</textarea>`:`<input name="${key}" type="${kind==='url'?'url':'text'}" value="${esc(item[key])}" placeholder="${esc(placeholder)}" maxlength="${key==='name'?100:350}" ${key==='pricing'||key==='tags'?'':'required'}>`}</label>`;
  return layout(isEdit?'Edit listing':'Add listing',`<section class="admin-intro"><div><a class="back" href="/admin/listings">← All listings</a><h1>${isEdit?'Edit listing':'New listing'}<span class="period">.</span></h1><p class="muted">Keep descriptions clear and check URLs before publishing.</p></div></section><section class="form-panel"><form action="${isEdit?`/admin/listings/${id}/save`:'/admin/listings/new'}" method="post"><input type="hidden" name="_csrf" value="${csrf}">${error?`<div class="form-error">${esc(error)}</div>`:''}<div class="form-grid">${field('Tool name','name')}${field('Category','category')}${field('Summary','summary','textarea','A short introduction')}${field('Official website URL','website_url','url','https://example.com')}${field('Detailed description','description','textarea')}${field('Pricing label','pricing','input','See provider')}${field('Tags (comma separated)','tags','input','automation, agents, api')}</div><label class="checkbox-line"><input type="checkbox" name="active" value="1" ${item.active?'checked':''}> Publish this listing</label><div class="actions"><button class="button primary" type="submit">${isEdit?'Save changes':'Create listing'}</button><a class="button outline" href="/admin/listings">Cancel</a></div></form>${isEdit?`<form action="/admin/listings/${id}/delete" method="post" class="delete-form"><input type="hidden" name="_csrf" value="${csrf}"><button class="danger" type="submit">Delete listing permanently</button><span class="muted tiny">This also deletes this listing's view history.</span></form>`:''}</section>`,true);
}
function loginPage(error='') {return layout('Admin sign in',`<section class="login-wrapper"><div class="login-box"><div class="eyebrow"><span class="dot"></span> RESTRICTED AREA</div><h1>Admin sign in<span class="period">.</span></h1><p class="muted">Use the admin password configured in Render.</p>${error?`<div class="form-error">${esc(error)}</div>`:''}<form method="post" action="/admin/login"><label class="form-field"><span>Password</span><input type="password" name="password" required autocomplete="current-password" autofocus></label><button class="button primary" type="submit">Sign in →</button></form></div></section>`);}
function readForm(req) {return new Promise((resolve,reject)=>{let chunks='', size=0;req.on('data',buf=>{size+=buf.length;if(size>30000){reject(new Error('Form is too large'));req.destroy();}else chunks+=buf.toString();});req.on('end',()=>resolve(Object.fromEntries(new URLSearchParams(chunks))));req.on('error',reject);});}
function validate(data){ const f={...data}; for(const k of ['name','category','summary','description','website_url','pricing','tags'])f[k]=String(f[k]||'').trim();
  if(!f.name || f.name.length>100 || !f.category || f.category.length>70 || !f.summary || f.summary.length>350 || !f.description || f.description.length>2000) return 'Please complete all required fields within the character limits.';
  try {const url=new URL(f.website_url);if(url.protocol!=='https:' || !url.hostname.includes('.'))return 'Website URL must be a valid HTTPS address.';}catch{return 'Enter a valid HTTPS website URL.';}
  if(f.tags.length>350 || f.pricing.length>100) return 'Tags or pricing text is too long.';
  return '';
}
const rates=new Map();
function allowedLogin(req){const ip=req.socket.remoteAddress||'local', now=Date.now(),data=rates.get(ip)||{count:0,until:now+15*60000};if(data.until<now){rates.set(ip,{count:1,until:now+15*60000});return true;}data.count++;rates.set(ip,data);return data.count<=7;}
const sameOrigin = req => { const origin=req.headers.origin; if(!origin)return true;try {return new URL(origin).host===req.headers.host;}catch{return false;} };
function start(res,session) {const payload=Buffer.from(JSON.stringify(session)).toString('base64url');redirect(res,'/admin',{'Set-Cookie':cookie(calcCookie(payload))});}
function csvCell(x){return `"${String(x??'').replace(/"/g,'""')}"`;}

export const handler=async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');const p=url.pathname;const admin=signedSession(req);
    if(p==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:true}));return;}
    if(p==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('User-agent: *\nDisallow: /admin\n');return;}
    if(p==='/sitemap.xml'){const host=publicUrl;const slugs=db.prepare('SELECT slug FROM listings WHERE active=1').all();res.writeHead(200,{'Content-Type':'application/xml'});res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(host)}/</loc></url>${slugs.map(x=>`<url><loc>${esc(host)}/tools/${esc(x.slug)}</loc></url>`).join('')}</urlset>`);return;}
    if(p==='/public/styles.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'public, max-age=600','X-Content-Type-Options':'nosniff'});fs.createReadStream(path.join(root,'public','styles.css')).pipe(res);return;}
    if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(req.method==='GET' && p==='/'){response(res,cataloguePage());return;}
    if(req.method==='GET' && p==='/search'){const q=(url.searchParams.get('q')||'').trim().slice(0,100),cat=(url.searchParams.get('category')||'').trim().slice(0,70);recordSearch(req,q);response(res,cataloguePage(q,cat));return;}
    if(req.method==='GET' && p.startsWith('/tools/')){const slug=p.slice(7);const item=db.prepare('SELECT * FROM listings WHERE slug=? AND active=1').get(slug);if(!item){response(res,layout('Not found','<div class="empty"><h2>Listing not found</h2><a href="/">Back to catalogue</a></div>'),404);return;}countView(req,item.id);response(res,detailPage(item));return;}
    if(req.method==='GET' && p==='/api/paid-search/info') {
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({name:SITE_NAME,description:'Paid structured AI tool catalogue search',endpoint:'/api/paid-search',method:'GET',query:{q:'search terms',category:'optional filter',limit:'1-10'},priceUSD:'0.05',currency:'USDC',network:'Base mainnet',networkId:'eip155:8453',paymentProtocol:'x402 v2',wallet:'0x5e8685a52afe9bbe8e70e118816802672c74d3e1',note:'Requires an x402-compatible paying client. Public website is free.'}));return;
    }
    if(req.method==='GET' && p==='/privacy'){response(res,layout('Privacy',`<section class="privacy-page"><div class="eyebrow">OUR APPROACH</div><h1>Privacy and analytics<span class="period">.</span></h1><p>We count catalogue page views and searches to understand which listings are useful. Recognised bots and logged-in administrators are excluded when possible.</p><p>To limit repeated views, our server creates a keyed, one-way daily hash from the network address and browser user-agent. We do not store raw IP addresses in our analytics database. The same person on different days may count more than once. View and search events are kept for up to 90 days.</p><p>Admin authentication uses a security cookie. Ordinary visitors are not given a tracking cookie by this website.</p><p>This is starter privacy text, not a substitute for a privacy-policy review before public launch.</p></section>`));return;}
    if(p==='/admin/login' && req.method==='GET'){if(admin){redirect(res,'/admin');return;}response(res,loginPage());return;}
    if(p==='/admin/login' && req.method==='POST'){
      if(!sameOrigin(req)){response(res,loginPage('Invalid request origin.'),403);return;}
      if(!ADMIN_PASSWORD){response(res,loginPage('Set ADMIN_PASSWORD in the app environment before logging in.'),503);return;}
      if(!allowedLogin(req)){response(res,loginPage('Too many attempts. Try again in 15 minutes.'),429);return;}
      const form=await readForm(req),input=crypto.createHash('sha256').update(String(form.password||'')).digest(),wanted=crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
      if(!crypto.timingSafeEqual(input,wanted)){response(res,loginPage('Incorrect password.'),401);return;}
      start(res,{exp:Date.now()+12*3600000,nonce:crypto.randomBytes(24).toString('hex')});return;
    }
    if(p.startsWith('/admin')) {
      if(!admin){if(req.method==='GET'){redirect(res,'/admin/login');return;}response(res,'Forbidden',403);return;}
      if(req.method==='POST' && !sameOrigin(req)){response(res,'Invalid origin',403);return;}
      if(p==='/admin/logout' && req.method==='POST'){redirect(res,'/admin/login',{'Set-Cookie':cookie('',0)});return;}
      if(req.method==='GET' && p==='/admin'){response(res,dashboard(admin));return;}
      if(req.method==='GET' && p==='/admin/listings'){response(res,listingTable(admin));return;}
      if(req.method==='GET' && p==='/admin/earnings'){
        const pays=db.prepare('SELECT transaction_hash,network,amount_atomic,payer,settled_at FROM paid_requests ORDER BY settled_at DESC LIMIT 100').all();
        const total=db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_atomic AS INTEGER)),0) AS v FROM paid_requests').get();
        const rows=pays.map(x=>`<tr><td><a href="https://basescan.org/tx/${encodeURIComponent(x.transaction_hash)}" rel="noopener noreferrer" target="_blank">${esc(x.transaction_hash.slice(0,12))}… ↗</a></td><td>${esc(x.payer.slice(0,10))}…</td><td class="right">$${(Number(x.amount_atomic)/1000000).toFixed(4)}</td><td>${esc(niceDate(x.settled_at))}</td></tr>`).join('');
        response(res,layout('AI payments',`<section class="admin-intro"><div><div class="eyebrow"><span class="dot"></span> VERIFIED SETTLEMENTS</div><h1>AI payments<span class="period">.</span></h1><p class="muted">Only successfully settled x402 payments are included. Figures are USDC (not GBP).</p></div></section><div class="metrics">${metric('Successful payments',total.n,'Total settled requests','▤')}${metric('USDC cents',Math.round(total.v/10000),'USDC cents received · approximate','◉')}</div><section class="panel"><div class="panel-heading"><h2>Transaction history</h2></div><div class="scroll-table"><table><thead><tr><th>Base transaction</th><th>Payer</th><th class="right">USDC</th><th>Date</th></tr></thead><tbody>${rows||'<tr><td colspan="4">No payments yet.</td></tr>'}</tbody></table></div></section><p class="privacy-note">Free Render storage is temporary. This ledger can reset, so use Coinbase Wallet or BaseScan as the source of truth for money received.</p>`,true));return;
      }

      if(req.method==='GET' && p==='/admin/listings/new'){response(res,editForm({name:'',category:'',summary:'',description:'',website_url:'',pricing:'See provider',tags:'',active:1},tokenFor(admin)));return;}
      if(req.method==='GET' && p==='/admin/export.csv') {
        const rows=db.prepare('SELECT name,category,website_url,total_views AS views FROM listings ORDER BY total_views DESC').all();
        const csv=[['Tool','Category','URL','All-time views'].join(','),...rows.map(x=>[x.name,x.category,x.website_url,x.views].map(csvCell).join(','))].join('\r\n');
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="catalogue-views.csv"','Cache-Control':'no-store'});res.end(csv);return;
      }
      const edit=p.match(/^\/admin\/listings\/(\d+)\/edit$/);
      if(req.method==='GET' && edit){const item=db.prepare('SELECT * FROM listings WHERE id=?').get(Number(edit[1]));if(!item){response(res,'Not found',404);return;}response(res,editForm(item,tokenFor(admin)));return;}
      if(req.method==='POST') {
        const form=await readForm(req);if(!matchCsrf(admin,form)){response(res,'Invalid security token',403);return;}
        if(p==='/admin/listings/new'){const error=validate(form);const item={...form,active:form.active==='1'?1:0};if(error){response(res,editForm(item,tokenFor(admin),error),422);return;}
          const base=slugify(form.name);let slug=base,n=2;while(db.prepare('SELECT id FROM listings WHERE slug=?').get(slug)){slug=`${base}-${n++}`;}
          const now=Date.now();db.prepare('INSERT INTO listings (name,slug,category,summary,description,website_url,pricing,tags,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(form.name,slug,form.category,form.summary,form.description,form.website_url,form.pricing||'See provider',form.tags,item.active,now,now);redirect(res,'/admin/listings');return;}
        const action=p.match(/^\/admin\/listings\/(\d+)\/(save|delete)$/);
        if(action){const id=Number(action[1]),what=action[2],original=db.prepare('SELECT * FROM listings WHERE id=?').get(id);if(!original){response(res,'Not found',404);return;}
          if(what==='delete'){db.prepare('DELETE FROM listings WHERE id=?').run(id);redirect(res,'/admin/listings');return;}
          const error=validate(form);const item={...original,...form,active:form.active==='1'?1:0};if(error){response(res,editForm(item,tokenFor(admin),error),422);return;}
          db.prepare('UPDATE listings SET name=?,category=?,summary=?,description=?,website_url=?,pricing=?,tags=?,active=?,updated_at=? WHERE id=?').run(form.name,form.category,form.summary,form.description,form.website_url,form.pricing||'See provider',form.tags,item.active,Date.now(),id);redirect(res,'/admin/listings');return;
        }
      }
    }
    response(res,layout('Not found','<div class="empty"><h2>Page not found</h2><a href="/">Back to catalogue</a></div>'),404);
  } catch(e){console.error('Request error:',e);response(res,layout('Error','<div class="empty"><h2>Something went wrong.</h2><p>Please try again.</p></div>'),500);}
};
const server=http.createServer(handler);

if (process.env.START_SERVER!=='false') server.listen(PORT,'0.0.0.0',()=>console.log(`${SITE_NAME} listening at http://localhost:${PORT}`));
export {db,server};
