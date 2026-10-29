/* DeepSeek Generative UI protocol v1. Pure, dependency-free; no execution/dispatch. */
(function (root) {
  'use strict';
  if (root.__sdGenUIProtocol) return;
  var MAX = 400000, MAX_STREAM = 1024000, MAX_BLOCKS = 16;
  var KINDS = ['ui','svg','html-app','mcp-app','tool-result','document','code','mermaid','react']
  var KIND_ALIASES = {html:'html-app',htm:'html-app',app:'html-app',website:'html-app',webpage:'html-app',web:'html-app',page:'html-app',game:'html-app',interactive:'html-app',dashboard:'html-app',visualization:'html-app',visual:'html-app',chart:'html-app',tool:'html-app','html-application':'html-app',application:'html-app',
    markdown:'document',md:'document',doc:'document',text:'document',article:'document',report:'document',essay:'document',note:'document',notes:'document',
    jsx:'react',tsx:'react',component:'react','react-component':'react',
    diagram:'mermaid',flowchart:'mermaid',graph:'mermaid',
    image:'svg',illustration:'svg',vector:'svg',icon:'svg',
    widget:'ui',json:'ui','mcp':'mcp-app','toolresult':'tool-result','tool_result':'tool-result'}, TOOL_VIEWS = ['auto','table','chart','cards','json'];
  var HEADER_KEYS = ['version','id','kind','title','revision','presentation','name','view','server','resource','language','type'];
  var CODE_LANGS = /^(python|py|javascript|js|typescript|ts|java|kotlin|kt|swift|go|rust|rs|c|cpp|c\+\+|csharp|cs|c#|php|ruby|rb|bash|sh|shell|sql|css|scss|yaml|yml|toml|dart|lua|r|scala|perl|haskell|elixir|zig|csv|tsv|jsonl|json5|ini|env|dotenv|properties|conf|config|graphql|gql|proto|protobuf|dockerfile|makefile|ipynb|txt|log|diff|ps1|powershell|groovy|gradle|kts|bat|batch)$/;
  function slugId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?![a-z])/, 'a-').slice(0, 64) || 'artifact'; }
  /** Infer a kind from the body when the header is missing or unknown. */
  function inferKind(body) {
    var b = String(body || '').replace(/^\s+/, '');
    if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i.test(b)) return 'svg';
    if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype html|<html[\s>])/i.test(b) || /^<(?:div|main|section|body|canvas|style|script|header|article|table|form|h[1-6]|p)[\s>]/i.test(b)) return 'html-app';
    if (/^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|xychart-beta)\b/.test(b)) return 'mermaid';
    if (/(?:^|\n)\s*import\s+[^\n]*from\s+['"]react['"]|export\s+default\s+function|\breturn\s*\(\s*<[A-Za-z]/.test(b)) return 'react';
    if (/^\{[\s\S]*"components"\s*:/.test(b)) return 'ui';
    return 'document';
  }
  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function checkTree(v, depth) {
    if (depth > 24) throw Error('Nesting limit exceeded');
    if (!v || typeof v !== 'object') return;
    Object.keys(v).forEach(function(k) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') throw Error('Reserved key');
      checkTree(v[k], depth + 1);
    });
  }
  function validate(input) {
    try {
      if (typeof input !== 'string' || input.length > MAX) throw Error('Payload size limit');
      var v = JSON.parse(input); checkTree(v, 0);
      if (!object(v) || v.version !== 1) throw Error('Unsupported protocol version');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.id || '')) throw Error('Invalid block id');
      if (KINDS.indexOf(v.kind) < 0) throw Error('Unsupported content kind');
      if (!object(v.payload)) throw Error('Missing payload');
      if (v.title !== undefined && (typeof v.title !== 'string' || v.title.length > 160)) throw Error('Invalid title');
      if (v.presentation !== undefined && ['inline','expanded','artifact'].indexOf(v.presentation) < 0) throw Error('Invalid presentation');
      if (v.revision !== undefined && (!Number.isSafeInteger(v.revision) || v.revision < 1)) throw Error('Invalid revision');
      if (v.kind === 'svg' && (typeof v.payload.svg !== 'string' || !v.payload.svg.trim() || v.payload.svg.length > 300000)) throw Error('Invalid SVG');
      if (v.kind === 'html-app') {
        ['html','css','js'].forEach(function(k) { if (v.payload[k] !== undefined && typeof v.payload[k] !== 'string') throw Error('Invalid application field'); });
        if (typeof v.payload.html !== 'string' || v.payload.html.length > 120000 || (v.payload.css || '').length > 24000 || (v.payload.js || '').length > 40000) throw Error('Application size limit');
      }
      if (v.kind === 'html-app' && v.payload.source !== undefined && (typeof v.payload.source !== 'string' || v.payload.source.length > 300000)) throw Error('Application size limit');
      if (v.kind === 'document' && (typeof v.payload.markdown !== 'string' || !v.payload.markdown.trim() || v.payload.markdown.length > 120000)) throw Error('Invalid document');
      if (v.kind === 'code' && (typeof v.payload.code !== 'string' || !v.payload.code.trim() || v.payload.code.length > 300000 || (v.payload.language !== undefined && !/^[A-Za-z0-9_+#.-]{0,24}$/.test(v.payload.language)))) throw Error('Invalid code');
      if ((v.kind === 'mermaid' || v.kind === 'react') && (typeof v.payload.source !== 'string' || !v.payload.source.trim() || v.payload.source.length > 120000)) throw Error('Invalid ' + v.kind + ' source');
      if (v.kind === 'ui' && !object(v.payload.spec)) throw Error('Invalid component specification');
      if (v.kind === 'mcp-app') {
        if (typeof v.payload.resourceUri !== 'string' || v.payload.resourceUri.length > 900 ||
            !/^(?:ui:\/\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})(?:\/[A-Za-z0-9_-][A-Za-z0-9._~-]{0,119})*|https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9_-][A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,499})$/.test(v.payload.resourceUri)) throw Error('Invalid MCP resource URI');
        if (typeof v.payload.serverUrl !== 'string' || v.payload.serverUrl.length > 400 ||
            !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,300})?$/.test(v.payload.serverUrl)) throw Error('Invalid MCP server URL');
        if ((v.payload.view !== undefined && ['app','home'].indexOf(v.payload.view) < 0) || (v.view !== undefined && ['app','home'].indexOf(v.view) < 0)) throw Error('Invalid MCP view');
      }
      if (v.kind === 'tool-result') {
        if (v.payload.name !== undefined && (typeof v.payload.name !== 'string' || v.payload.name.length > 120)) throw Error('Invalid tool name');
        if (v.payload.view !== undefined && TOOL_VIEWS.indexOf(v.payload.view) < 0) throw Error('Invalid tool-result view');
        if (v.payload.result === undefined) throw Error('Missing tool result');
        if (JSON.stringify(v.payload.result).length > 80000) throw Error('Tool result too large');
      }
      // Return a detached allowlisted envelope; model-authored permissions are never granted.
      var payload = v.kind === 'html-app' ? { html:v.payload.html, css:v.payload.css || '', js:v.payload.js || '', source: typeof v.payload.source === 'string' ? v.payload.source : '' } :
        v.kind === 'document' ? {markdown:v.payload.markdown} :
        v.kind === 'code' ? {code:v.payload.code, language:String(v.payload.language || '').toLowerCase()} :
        (v.kind === 'mermaid' || v.kind === 'react') ? {source:v.payload.source} :
        v.kind === 'svg' ? {svg:v.payload.svg} :
        v.kind === 'mcp-app' ? {resourceUri:v.payload.resourceUri,serverUrl:v.payload.serverUrl,view:v.payload.view || v.view || 'app'} :
        v.kind === 'tool-result' ? {name:v.payload.name || '',view:v.payload.view || 'auto',result:v.payload.result} : {spec:v.payload.spec};
      return {ok:true, block:{version:1,id:v.id,kind:v.kind,title:v.title || 'Artifact',presentation:v.presentation || 'inline',revision:v.revision || 1,payload:payload}};
    } catch(e) { return {ok:false,error:String(e.message || e).slice(0,200)}; }
  }
  /* Header format (preferred for models: no JSON-escaping of HTML):
       id: my-app
       kind: html-app
       title: Title
       revision: 1
       ---
       <body>
     Headers end at a line '---' or the first blank line. Unknown keys are
     ignored for forward compatibility; duplicates are rejected. The result is
     converted to the JSON envelope and passed through validate(), so both
     formats share exactly one security gate. */
  function splitHeaders(source) {
    var lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/), i = 0, headers = Object.create(null), n = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    for (; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*---\s*$/.test(line) || !line.trim()) { i++; break; }
      var m = /^\s*([A-Za-z][A-Za-z_-]{0,31})\s*:\s?(.*)$/.exec(line);
      // Lenient: the first line that is not a header starts the body (models
      // often omit the --- separator or the headers altogether).
      if (!m || /^\s*</.test(line)) break;
      var key = m[1].toLowerCase();
      if (++n > 24) break;
      if (HEADER_KEYS.indexOf(key) < 0) continue;
      if (Object.prototype.hasOwnProperty.call(headers, key)) continue; // first wins
      headers[key] = m[2].trim().replace(/^["'`]|["'`]$/g, '').slice(0, 1000);
    }
    return { headers: headers, body: lines.slice(i).join('\n') };
  }
  function splitHtml(body) {
    var css = [], js = [], html = String(body);
    html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, function (_, c) { css.push(c); return ''; });
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, function (_, attrs, c) {
      // External scripts are dropped: generated apps are offline by policy.
      if (!/\bsrc\s*=/i.test(attrs) && !/type\s*=\s*["']?(?!text\/javascript|module|application\/javascript)[a-z]/i.test(attrs)) js.push(c);
      return '';
    });
    html = html.replace(/<!doctype[^>]*>/gi, '').replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
      .replace(/<\/?(?:html|body)\b[^>]*>/gi, '').replace(/<(?:meta|link|base|title)\b[^>]*>(?:[^<]*<\/title>)?/gi, '');
    return { html: html.trim(), css: css.join('\n').trim(), js: js.join('\n;\n').trim() };
  }
  /** Repair common JSON-envelope slips (missing version, odd id, aliased kind,
   *  body fields at the top level) and re-serialize for validate(). */
  function lenientEnvelope(source) {
    var v; try { v = JSON.parse(source); } catch (_) { return null; }
    if (!object(v)) return null;
    if (v.version === undefined || v.version === '1') v.version = 1;
    if (typeof v.kind === 'string') { var k = v.kind.toLowerCase(); v.kind = KINDS.indexOf(k) >= 0 ? k : (KIND_ALIASES[k] || k); }
    if (!object(v.payload)) {
      var p = {};
      ['html', 'css', 'js', 'source', 'svg', 'markdown', 'code', 'language', 'spec', 'result', 'name', 'view', 'serverUrl', 'resourceUri'].forEach(function (f) { if (v[f] !== undefined) p[f] = v[f]; });
      if (v.components && !p.spec) p.spec = { components: v.components, title: v.title };
      v.payload = p;
    }
    if (v.kind === 'html-app' && typeof v.payload.html !== 'string') { v.payload.source = v.payload.source || ''; v.payload.html = ''; }
    if (KINDS.indexOf(v.kind) < 0) v.kind = v.payload.svg ? 'svg' : v.payload.markdown ? 'document' : v.payload.spec ? 'ui' : v.payload.code ? 'code' : 'html-app';
    if (typeof v.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.id)) v.id = slugId(v.id || v.title || v.kind);
    if (v.revision !== undefined && !(Number.isSafeInteger(v.revision) && v.revision >= 1)) delete v.revision;
    if (v.presentation !== undefined && ['inline', 'expanded', 'artifact'].indexOf(v.presentation) < 0) delete v.presentation;
    if (typeof v.title === 'string') v.title = v.title.slice(0, 160);
    return JSON.stringify(v);
  }
  function parseBlock(source) {
    try {
      if (typeof source !== 'string' || source.length > MAX) throw Error('Payload size limit');
      if (/^\s*\{/.test(source)) {
        var direct = validate(source);
        if (direct.ok) return direct;
        var fixed = lenientEnvelope(source);
        return fixed ? validate(fixed) : direct;
      }
      var parts = splitHeaders(source), h = parts.headers, body = parts.body;
      if (h.kind) {
        var k0 = h.kind.toLowerCase().replace(/\s+/g, '-');
        h.kind = KINDS.indexOf(k0) >= 0 ? k0 : (KIND_ALIASES[k0] || (CODE_LANGS.test(k0) ? (h.language = h.language || k0, 'code') : ''));
      }
      if (KINDS.indexOf(h.kind) < 0) h.kind = inferKind(body);
      if (h.kind === 'document' && /^\s*\{/.test(body)) { try { var j0 = JSON.parse(body); if (j0 && j0.components) h.kind = 'ui'; } catch (_) {} }
      if (h.id === undefined || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(h.id)) h.id = slugId(h.id || h.title || h.name || h.kind);
      var env = { version: 1, id: h.id, kind: h.kind, payload: {} };
      if (!h.title) { var tm = /<title>([^<]{1,120})<\/title>/i.exec(body) || /^\s*#\s+(.{1,120})$/m.exec(body); if (tm) h.title = tm[1].trim(); }
      if (h.title !== undefined) env.title = String(h.title).slice(0, 160);
      if (h.presentation !== undefined && ['inline', 'expanded', 'artifact'].indexOf(h.presentation.toLowerCase()) >= 0) env.presentation = h.presentation.toLowerCase();
      if (h.revision !== undefined && /^\d{1,9}$/.test(h.revision) && Number(h.revision) >= 1) env.revision = Number(h.revision);
      if (h.kind === 'html-app') { if (!body.trim()) throw Error('Missing application body'); env.payload = { html: '', css: '', js: '', source: body.trim() }; }
      else if (h.kind === 'document') env.payload = { markdown: body.replace(/^\n+|\s+$/g, '') };
      else if (h.kind === 'code') env.payload = { code: body.replace(/^\n+|\s+$/g, ''), language: h.language || h.type || '' };
      else if (h.kind === 'mermaid' || h.kind === 'react') env.payload = { source: body.trim() };
      else if (h.kind === 'svg') env.payload = { svg: body.trim() };
      else if (h.kind === 'ui') { try { env.payload = { spec: JSON.parse(body) }; } catch (e) { throw Error('Invalid component JSON'); } }
      else if (h.kind === 'tool-result') {
        var result; try { result = JSON.parse(body); } catch (_) { result = body.trim(); }
        if (result === '') throw Error('Missing tool result');
        env.payload = { result: result };
        if (h.name !== undefined) env.payload.name = h.name;
        if (h.view !== undefined) env.payload.view = h.view;
      } else if (h.kind === 'mcp-app') {
        env.payload = { serverUrl: h.server || '', resourceUri: h.resource || '' };
        if (h.view !== undefined) env.payload.view = h.view;
      }
      return validate(JSON.stringify(env));
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
  }
  /* Incremental fenced stream. Only a newline-terminated closing fence seals a block.
     finish() may seal the final closing fence at EOF. No side effects; duplicates are
     occurrences, not actions. A fresh parser is needed for a new response. */
  function Stream() { this.buffer=''; this.offset=0; this.parts=[]; this.done=false; }
  Stream.prototype.push=function(chunk, final) {
    if (this.done) throw Error('Stream already closed');
    if (typeof chunk !== 'string') throw Error('Chunk must be text');
    if (this.buffer.length + chunk.length > MAX_STREAM) { this.done=true; throw Error('Stream size limit'); }
    this.buffer += chunk;
    var text=this.buffer, pos=this.offset, re=/^```sds-genui[^\S\r\n]*\r?\n/gm, m;
    re.lastIndex=pos;
    while ((m=re.exec(text))) {
      if (this.parts.filter(function(p){return p.type==='visual';}).length >= MAX_BLOCKS) { this.done=true; throw Error('Block count limit'); }
      var close=/^```[^\S\r\n]*(?:\r?\n|$)/gm; close.lastIndex=re.lastIndex;
      var end=close.exec(text);
      if (!end || (!final && end.index + end[0].length === text.length && !end[0].endsWith('\n'))) break;
      if(m.index>pos) this.parts.push({type:'text',text:text.slice(pos,m.index)});
      var source=text.slice(re.lastIndex,end.index), parsed=parseBlock(source);
      this.parts.push({type:'visual',source:source,result:parsed,index:this.parts.length});
      pos=end.index+end[0].length; re.lastIndex=pos;
    }
    this.offset=pos;
    if(final) { if(pos<text.length) this.parts.push({type:'text',text:text.slice(pos)}); this.done=true; }
    return this.parts.slice();
  };
  function documentFor(block, executable) {
    if (!block || block.kind !== 'html-app') throw Error('Not an application');
    // Sandbox attribute is supplied by the trusted host. Generated code never runs
    // in the chat WebView. Native execution is a separate bridge-free WebView.
    var csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    var p=block.payload;
    var css=p.css.replace(/<\/style/gi,'<\\/style');
    var js=p.js.replace(/<\/script/gi,'<\\/script');
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:16px;font:16px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}button,input,select{font:inherit;min-height:44px}svg,canvas,img{max-width:100%}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}'+css+'</style></head><body>'+p.html+(executable?'<script>'+js+'</script>':'')+'</body></html>';
  }
  var DEFAULT_HOSTS=['cdn.jsdelivr.net','unpkg.com','cdnjs.cloudflare.com','raw.githubusercontent.com','upload.wikimedia.org','images.unsplash.com','fonts.gstatic.com'];
  function allowedExternalUrl(url,hosts){
    if(typeof url!=='string'||!url||url.length>2000)return false;
    var u;try{u=new URL(url);}catch(e){return false;}
    if(u.protocol!=='https:')return false;
    if(u.username||u.password)return false;
    var host=String(u.hostname||'').toLowerCase();
    if(!host||host==='localhost'||host.endsWith('.local')||host.endsWith('.internal'))return false;
    if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))return false;
    var list=(Array.isArray(hosts)&&hosts.length)?hosts:DEFAULT_HOSTS;
    for(var i=0;i<list.length;i++){var h=String(list[i]).toLowerCase();if(host===h||host.slice(-(h.length+1))==='.'+h)return true;}
    return false;
  }
  root.__sdGenUIProtocol={version:1,kinds:KINDS.slice(),kindAliases:KIND_ALIASES,inferKind:inferKind,splitHeaders:splitHeaders,validate:validate,parseBlock:parseBlock,splitHtml:splitHtml,toolViews:TOOL_VIEWS.slice(),Stream:Stream,documentFor:documentFor,allowedExternalUrl:allowedExternalUrl,defaultExternalHosts:DEFAULT_HOSTS.slice(),limits:{payload:MAX,stream:MAX_STREAM,blocks:MAX_BLOCKS}};
})(window);
