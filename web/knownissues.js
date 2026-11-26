(function(){
  "use strict";
  var API = "/api/console/public";
  var TABS = [["games","Games"],["apps","Apps"],["session","Session"],["account","Account"]];
  var HAS_ENTITY = {games:1, apps:1};
  var state = { tab:"games", q:"", data:null, gameIds:{}, deepTitle:null, deepGid:null, sel:null };
  function shotUrls(r){ return ((r&&r.shots)||[]).map(httpUrl).filter(Boolean); }
  function narrow(){ return window.matchMedia && window.matchMedia("(max-width:760px)").matches; }

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  function httpUrl(u){ u=String(u||"").trim(); return /^https?:\/\//i.test(u)?u:""; }
  function linkify(t){
    // escape first, then turn bare http(s) URLs into safe links
    var e = esc(t);
    return e.replace(/(https?:\/\/[^\s<]+)/g, function(m){ return '<a href="'+m+'" target="_blank" rel="noopener noreferrer">'+m+'</a>'; });
  }
  function el(id){ return document.getElementById(id); }
  function toast(msg){ var t=el("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(function(){t.classList.remove("show");},2600); }

  function cat(c){ var d=(state.data&&state.data.categories)||{}; return d[c]||{has_entity:!!HAS_ENTITY[c],rows:[]}; }
  function tabLabel(c){ for(var i=0;i<TABS.length;i++){ if(TABS[i][0]===c) return TABS[i][1]; } return c; }
  // Same split as services/game_title.py so "Foo (Xbox)" -> {base:"foo",launcher:"xbox"} and each entity
  // resolves to its own platform's ID(s).
  function splitLauncher(t){ var s=String(t||"").trim().replace(/[™®©℠℗]/g,""); var launcher=""; var m=s.match(/\s*\(([^)]*)\)\s*$/); if(m){ launcher=m[1].trim().toLowerCase(); s=s.slice(0,m.index); } return {base:s.replace(/\s{2,}/g," ").trim().toLowerCase(),launcher:launcher}; }
  function normGameTitle(s){ return splitLauncher(s).base; }
  function gameMatchKey(s){ var x=splitLauncher(s); return x.base+"|"+x.launcher; }
  function idsFor(title){ var a=state.gameIds[gameMatchKey(title)]; return (a&&a.length)?a:null; }

  function listItems(c){
    var d=cat(c);
    if(d.has_entity){
      var map={}, order=[];
      (d.rows||[]).forEach(function(r){ var e=r.entity||"(unnamed)"; if(!map[e]){map[e]=[];order.push(e);} map[e].push(r); });
      return order.sort(function(a,b){return a.localeCompare(b);}).map(function(e){
        var blob=e+" "+map[e].map(function(r){return (r.problem||"")+" "+(r.solution||"")+" "+(r.canned||"");}).join(" ");
        var ids=idsFor(e); if(ids) blob+=" "+ids.join(" ");
        var nshots=map[e].reduce(function(n,r){ return n+shotUrls(r).length; },0);
        return {key:e,title:e,count:map[e].length,ids:ids,shots:nshots,search:blob.toLowerCase()};
      });
    }
    return (d.rows||[]).map(function(r,i){
      return {key:String(i),title:r.problem||"(untitled)",sub:r.solution||"",shots:shotUrls(r).length,
        search:((r.problem||"")+" "+(r.solution||"")+" "+(r.canned||"")).toLowerCase()};
    });
  }

  var CAM='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 8"/></svg>';
  var CHEV='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

  function searching(){ return !!String(state.q||"").trim(); }
  // Header search = all categories. The list's own filter = only the open tab (ignored while the header
  // search is in use, since the list then shows every category).
  function matches(it){
    var ql=String(state.q||"").trim().toLowerCase();
    if(ql) return it.search.indexOf(ql)>=0;
    var lq=String(state.lq||"").trim().toLowerCase();
    return !lq || it.search.indexOf(lq)>=0;
  }
  var LQ_PH={games:"Filter games",apps:"Filter apps",session:"Filter session issues",account:"Filter account issues"};
  function syncLocalSearch(){
    var box=el("lsearch-box"), inp=el("lsearch"); if(!box) return;
    box.hidden=searching();
    inp.placeholder=LQ_PH[state.tab]||"Filter";
    if(inp.value!==(state.lq||"")) inp.value=state.lq||"";
  }
  // While searching, each tab shows how many matches it has; clicking it jumps to that group.
  function renderTabs(){
    var q=searching();
    el("tabs").innerHTML = TABS.map(function(t){
      var items=listItems(t[0]), n=q ? items.filter(matches).length : items.length, on=!q && t[0]===state.tab;
      return '<button class="stab'+(on?" active":"")+(q&&!n?" none":"")+'" role="tab" aria-selected="'+(on?"true":"false")+'" data-tab="'+t[0]+'">'+esc(t[1])+'<span class="tc">'+n+'</span></button>';
    }).join("");
  }
  function itemBtn(c, it, grouped, letter){
    var on = state.selCat===c && state.sel===it.key;
    return '<button class="gi '+(grouped?"one":"two")+(on?" active":"")+'" data-cat="'+c+'" data-key="'+esc(it.key)+'" title="'+esc(it.title)+'">'+
      '<span class="gt">'+esc(it.title)+'</span><span class="meta">'+(it.count!=null?'<span class="cnt">'+it.count+'</span>':'')+'</span></button>';
  }
  function renderGrid(){
    var q=searching(), cats=q ? TABS.map(function(t){ return t[0]; }) : [state.tab];
    var html="", shown=0, total=0;
    cats.forEach(function(c){
      var items=listItems(c), grouped=cat(c).has_entity, vis=items.filter(matches), letter="";
      total+=items.length; shown+=vis.length;
      if(q){
        if(!vis.length) return;
        html+='<div class="cat-h" data-cat-h="'+c+'">'+esc(tabLabel(c))+'<span class="num">'+vis.length+'</span></div>';
        vis.forEach(function(it){ html+=itemBtn(c, it, grouped, ""); });
        return;
      }
      vis.forEach(function(it){
        if(grouped){
          var L=(it.title.charAt(0)||"#").toUpperCase(); if(!/[A-Z]/.test(L)) L="#";
          if(L!==letter){ letter=L; html+='<div class="letter">'+esc(L)+'</div>'; }
        }
        html+=itemBtn(c, it, grouped, letter);
      });
    });
    var empty = q ? '<div class="empty">Nothing found for \u201c'+esc(String(state.q).trim())+'\u201d.</div>'
      : (total ? '<div class="empty">Nothing found for “'+esc(String(state.lq||"").trim())+'” in '+esc(tabLabel(state.tab))+'.</div>' : '<div class="empty">No published issues in '+esc(tabLabel(state.tab))+'.</div>');
    el("grid").innerHTML = (shown ? html : empty) + '<div id="other"></div>';
    searchOther(q ? state.q : state.lq);
    syncLocalSearch();
  }
  function refreshList(){ renderTabs(); renderGrid(); }
  // Right side: keep the open issue if it is still in the list, else open the first one (wide screens).
  function ensureSelection(){
    if(narrow()){ if(!state.sel) el("detail").innerHTML=""; return; }
    var cur=state.sel!=null && el("grid").querySelector('.gi[data-cat="'+state.selCat+'"][data-key="'+String(state.sel).replace(/"/g,'\\"')+'"]');
    if(cur) return;
    var first=el("grid").querySelector(".gi:not(.nogame)");
    if(first) openDetail(first.getAttribute("data-cat"), first.getAttribute("data-key"));
    else if(searching()) el("detail").innerHTML=nothere(state.tab, "");
    else if(!listItems(state.tab).length) el("detail").innerHTML=nothere(state.tab, "");   // empty category: offer to suggest
    else el("detail").innerHTML='<div class="nothere"><span style="flex:1">Nothing matches the filter.</span></div>';
  }

  // ---- games with no issues: found through the Game List so they can still be suggested ----
  var LN={steam:"Steam",epic:"Epic","epic games":"Epic",xbox:"Xbox",gog:"GOG",ubisoft:"Ubisoft","ea app":"EA app",ea:"EA app","battle.net":"Battle.net"};
  function launcherName(p){ p=String(p||"").trim(); if(!p) return ""; return LN[p.toLowerCase()]||(p.charAt(0).toUpperCase()+p.slice(1)); }
  function lch(g){ var n=launcherName(g.launcher); if(!n) return ""; var t=String(g.title||"").trim().toLowerCase(); if(t.slice(-(n.length+2))==="("+n.toLowerCase()+")") return ""; return '<span class="lch">'+esc(n)+'</span>'; }
  var _gcache={};
  function fetchGames(q, cb){
    q=String(q||"").trim().toLowerCase(); if(q.length<2){ cb([]); return; }
    if(_gcache[q]){ cb(_gcache[q]); return; }
    fetch(API+"/games?q="+encodeURIComponent(q)).then(function(r){ return r.ok?r.json():{games:[]}; })
      .then(function(d){ var g=(d&&d.games)||[]; _gcache[q]=g; cb(g); }).catch(function(){ cb([]); });
  }
  var _otherT=null, _otherQ="";
  function searchOther(q){
    var box=el("other"); if(!box) return;
    q=String(q||"").trim();
    if((!searching() && state.tab!=="games") || q.length<2){ box.innerHTML=""; _otherQ=""; return; }
    _otherQ=q; clearTimeout(_otherT);
    _otherT=setTimeout(function(){
      fetchGames(q, function(list){
        if(_otherQ!==q || !el("other")) return;
        var have={}; (cat("games").rows||[]).forEach(function(r){ have[normGameTitle(r.entity)]=1; });
        var rest=list.filter(function(g){ return !have[normGameTitle(g.title)]; });
        el("other").innerHTML = rest.length ? '<div class="other-h">Other games</div>'+
          rest.map(function(g){ return '<button class="gi nogame" data-nogame="'+esc(g.title)+'"><span class="gt">'+esc(g.title)+'</span>'+lch(g)+'</button>'; }).join("") : "";
      });
    }, 220);
  }

  // ---- game picker under the Game field of the suggest form ----
  var _acT=null;
  function acRender(list){
    var ac=el("f-entity-ac"); if(!ac) return;
    var v=(el("f-entity").value||"").trim();
    if(v.length<2){ ac.classList.remove("open"); ac.innerHTML=""; return; }
    ac.innerHTML = list.length ? list.map(function(g,i){ return '<button type="button" data-pick="'+esc(g.title)+'"'+(i===0?' class="hl"':'')+'><span class="gt">'+esc(g.title)+'</span>'+lch(g)+'</button>'; }).join("")
      : '<div class="ac-empty">Not in our game list. Press Enter to add it.</div>';
    ac.classList.add("open");
  }
  function acInput(){
    var v=(el("f-entity").value||"").trim(); clearTimeout(_acT);
    _acT=setTimeout(function(){ fetchGames(v, function(list){ if(el("f-entity") && el("f-entity").value.trim()===v) acRender(list); }); }, 180);
  }
  function acKey(ev){
    var ac=el("f-entity-ac");
    var typed=(el("f-entity").value||"").trim();
    // Enter with no list option highlighted: add the game as typed (it may not be in our Game List)
    if(ev.key==="Enter" && typed && (!ac || !ac.classList.contains("open") || !ac.querySelector("button.hl"))){ ev.preventDefault(); clearTimeout(_acT); addEnt(typed); if(ac) ac.classList.remove("open"); return; }
    if(!ac||!ac.classList.contains("open")) return;
    if(ev.key==="Escape"){ ev.stopPropagation(); ac.classList.remove("open"); return; }
    var opts=ac.querySelectorAll("button[data-pick]"); if(!opts.length) return;
    var i=Array.prototype.indexOf.call(opts, ac.querySelector("button.hl"));
    if(ev.key==="ArrowDown"||ev.key==="ArrowUp"){ ev.preventDefault(); i=(i+(ev.key==="ArrowDown"?1:-1)+opts.length)%opts.length; Array.prototype.forEach.call(opts,function(o,j){o.classList.toggle("hl",j===i);}); opts[i].scrollIntoView({block:"nearest"}); }
    else if(ev.key==="Enter"&&i>=0){ ev.preventDefault(); addEnt(opts[i].getAttribute("data-pick")); ac.classList.remove("open"); }
  }
  // Several games per suggestion: picked games become chips, the input stays free for the next one.
  var _ents=[];
  function renderEnts(){
    var box=el("f-ents"); if(!box) return;
    box.innerHTML=_ents.map(function(g,i){ return '<span class="ent-chip">'+esc(g)+'<button type="button" data-unent="'+i+'" aria-label="Remove '+esc(g)+'">&times;</button></span>'; }).join("");
    box.hidden=!_ents.length;
    var fe=el("f-entity"); if(fe) fe.placeholder=_ents.length?"Add another game (optional)":"Start typing a game, e.g. Grand Theft Auto V";
  }
  function addEnt(g){
    g=String(g||"").trim(); if(!g) return;
    if(_ents.map(function(x){return x.toLowerCase();}).indexOf(g.toLowerCase())<0 && _ents.length<10) _ents.push(g);
    var fe=el("f-entity"); if(fe){ fe.value=""; fe.focus(); }
    renderEnts();
  }

  // ---- screenshots on a suggestion: shrunk in the browser, uploaded after the suggestion is created ----
  var SUG_SHOT_MAX=3, _sugShots=[];
  function shrinkImage(file){
    return new Promise(function(ok, fail){
      if(!file || !/^image\//.test(file.type||"")){ fail("Only images can be attached."); return; }
      var rd=new FileReader();
      rd.onerror=function(){ fail("Could not read the image."); };
      rd.onload=function(){
        var img=new Image();
        img.onerror=function(){ fail("This image format is not supported."); };
        img.onload=function(){
          var w=img.naturalWidth, h=img.naturalHeight, k=Math.min(1, 1920/Math.max(w,h,1));
          var c=document.createElement("canvas"); c.width=Math.max(1,Math.round(w*k)); c.height=Math.max(1,Math.round(h*k));
          c.getContext("2d").drawImage(img,0,0,c.width,c.height);
          var preview=c.toDataURL("image/jpeg",0.6);
          c.toBlob(function(b){
            if(b && b.type==="image/webp"){ ok({blob:b,preview:preview}); return; }
            c.toBlob(function(j){ if(j) ok({blob:j,preview:preview}); else fail("Could not compress the image."); },"image/jpeg",0.82);
          },"image/webp",0.82);
        };
        img.src=rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  function renderSugShots(){
    var box=el("f-shots"); if(!box) return;
    box.innerHTML=_sugShots.map(function(it,i){ return '<span class="pick"><img src="'+esc(it.preview)+'" alt="Screenshot '+(i+1)+'"><button type="button" data-unshot="'+i+'" aria-label="Remove screenshot '+(i+1)+'">&times;</button></span>'; }).join("")+
      (_sugShots.length<SUG_SHOT_MAX?'<label class="pick-add"><input type="file" id="f-shot-input" accept="image/png,image/jpeg,image/webp" multiple hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add</span></label>':'');
  }
  function addSugShots(files){
    var room=SUG_SHOT_MAX-_sugShots.length, arr=Array.prototype.slice.call(files||[],0,Math.max(0,room));
    if(files && files.length>arr.length) toast("Max "+SUG_SHOT_MAX+" screenshots.");
    arr.reduce(function(p,f){ return p.then(function(){ return shrinkImage(f).then(function(it){ _sugShots.push(it); renderSugShots(); }, function(e){ toast(String(e)); }); }); }, Promise.resolve());
  }
  function uploadSugShots(id, token){
    var list=_sugShots.slice(), done=0, err="";
    return list.reduce(function(p,it){
      return p.then(function(){
        var fd=new FormData(); fd.append("token",token); fd.append("file",it.blob,"screenshot."+(it.blob.type==="image/webp"?"webp":"jpg"));
        return fetch(API+"/known-issues-suggest/"+encodeURIComponent(id)+"/shots",{method:"POST",body:fd})
          .then(function(r){ return r.json(); }).then(function(j){ if(j&&j.ok) done++; else err=(j&&j.error)||"upload failed"; }, function(){ err="upload failed"; });
      });
    }, Promise.resolve()).then(function(){ return {done:done, err:err}; });
  }

  // ---- feedback about the page (lands in the console Feedback list) ----
  function toggleFeedback(force){
    var p=el("fb-panel"); if(!p) return;
    var open = force==null ? !p.classList.contains("open") : !!force;
    p.classList.toggle("open", open);
    if(open){ var c=p.querySelector(".fb-cat.on")||p.querySelector(".fb-cat"); if(c) setTimeout(function(){ c.focus(); },20); }
  }
  function fbCount(){ var n=(el("fb-msg").value||"").length; el("fb-count").textContent=n+" / 2000"; el("fb-bar").style.width=Math.min(100,n/20)+"%"; }
  function fbReset(){
    el("fb-msg").value=""; fbCount();
    Array.prototype.forEach.call(document.querySelectorAll(".fb-cat"), function(b){ b.classList.remove("on"); b.setAttribute("aria-checked","false"); });
  }
  var SEND_LABEL='Send feedback';
  function submitFeedback(btn){
    if((el("fb-website").value||"").trim()){ toggleFeedback(false); return; }
    var on=document.querySelector(".fb-cat.on");
    if(!on){ toast("Pick a category."); return; }
    var v={ category:on.getAttribute("data-fbcat"), message:(el("fb-msg").value||"").trim(), name:(el("fb-name").value||"").trim(), website:"" };
    if(!v.message){ toast("Please write a message."); el("fb-msg").focus(); return; }
    var label=btn.lastChild; btn.disabled=true; label.textContent="Sending";
    fetch(API+"/feedback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        btn.disabled=false; label.textContent=SEND_LABEL;
        if(res.ok){ fbReset(); toggleFeedback(false); toast("Feedback sent."); }
        else { toast((res.j&&res.j.error)||"Could not send. Please try again."); }
      })
      .catch(function(){ btn.disabled=false; label.textContent=SEND_LABEL; toast("Could not send. Please try again."); });
  }

  function issueCard(r, hideProblem, idx){
    var link = httpUrl(r.link) ? '<a class="btn sm" href="'+esc(httpUrl(r.link))+'" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>Open ticket</a>' : '';
    var miss = missingParts(r);
    var sug = miss.length ? '<button class="btn sm sugg" data-addsug="'+(idx||0)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Suggest '+miss.join(" or ")+'</button>' : '';
    var edit = (r.problem||r.solution||r.canned) ? '<button class="btn sm sugg" data-editsug="'+(idx||0)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13 7l4 4"/></svg>Suggest edit</button>' : '';
    var foot = (link||sug||edit) ? '<div class="foot">'+link+sug+edit+'</div>' : '';
    var canned = r.canned ? '<div class="canned"><div class="canned-head"><span class="canned-label">Canned message</span><button class="btn copybtn" data-copy><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg><span>Copy</span></button></div><div class="canned-body">'+esc(r.canned)+'</div></div>' : '';
    return '<article class="card">'+
      ((!hideProblem && r.problem)?'<h3 class="problem">'+esc(r.problem)+'</h3>':'')+
      (r.solution?'<div class="solution">'+linkify(r.solution)+'</div>':'')+
      canned+shotsHtml(r, idx||0)+foot+'</article>';
  }
  function missingParts(r){
    var m=[];
    if(!String(r.canned||"").trim()) m.push("canned message");
    if(!shotUrls(r).length && state.data && state.data.shots_enabled) m.push("screenshot");
    return m;
  }
  // Suggest a change to what is already written (problem, solution, canned message) -> admin approval.
  function openEditSuggest(idx){
    var r=(state.rows||[])[idx]; if(!r) return;
    var c=state.selCat||state.tab;
    state.editTarget={category:c, entity:r.entity||"", problem:r.problem||""};
    var body='<div class="modal-body">'+
      '<div class="note">Your suggestion will be added after admin approves it.</div>'+
      '<input type="text" class="hp" id="f-website" tabindex="-1" autocomplete="off" aria-hidden="true">'+
      '<div class="field"><label for="e-problem">Problem</label><input id="e-problem" maxlength="200" value="'+esc(r.problem||"")+'"></div>'+
      '<div class="field"><label for="e-solution">Solution or explanation</label><textarea id="e-solution" maxlength="4000">'+esc(r.solution||"")+'</textarea></div>'+
      '<div class="field"><label for="e-canned">Canned message</label><textarea id="e-canned" maxlength="4000">'+esc(r.canned||"")+'</textarea></div>'+
      '</div>'+
      '<div class="modal-foot"><button class="btn primary" id="f-edit-send">Send for review</button><button class="btn ghost" data-close>Cancel</button></div>';
    openScrim(modalShell("Suggest edit: "+(r.problem||"this issue"), body));
    var f=el("e-solution"); if(f) f.focus();
  }
  function submitEditSuggest(btn){
    if((el("f-website").value||"").trim()){ closeScrim(); return; }
    var t=state.editTarget||{};
    var v={category:t.category, entity:t.entity, problem:t.problem, website:"",
           new_problem:el("e-problem").value.trim(), new_solution:el("e-solution").value.trim(), new_canned:el("e-canned").value.trim()};
    if(!v.new_problem){ toast("The problem can not be empty."); return; }
    btn.disabled=true; btn.textContent="Sending";
    function fail(msg){ btn.disabled=false; btn.textContent="Send for review"; toast(msg||"Could not send. Please try again."); }
    fetch(API+"/known-issues-suggest-edit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){ if(!res.ok) return fail(res.j&&res.j.error); closeScrim(); toast("Suggestion sent."); }, function(){ fail(); });
  }
  // Suggest what an existing issue is missing (canned message and/or screenshots) -> admin approval.
  function openAddition(idx){
    var r=(state.rows||[])[idx]; if(!r) return;
    var miss=missingParts(r); if(!miss.length) return;
    var c=state.selCat||state.tab, needCanned=miss.indexOf("canned message")>=0, needShots=miss.indexOf("screenshot")>=0;
    state.addTarget={category:c, entity:r.entity||"", problem:r.problem||""};
    _sugShots=[];
    var body='<div class="modal-body">'+
      '<div class="note">Your suggestion will be added after admin approves it.</div>'+
      '<input type="text" class="hp" id="f-website" tabindex="-1" autocomplete="off" aria-hidden="true">'+
      (needCanned?'<div class="field"><label for="f-canned">Canned message</label><textarea id="f-canned" maxlength="4000"></textarea></div>':'')+
      (needShots?'<div class="field"><label>Screenshots</label><div class="picks" id="f-shots"></div><div class="hint">PNG, JPEG or WebP, max 3</div></div>':'')+
      '</div>'+
      '<div class="modal-foot"><button class="btn primary" id="f-add-send">Send for review</button><button class="btn ghost" data-close>Cancel</button></div>';
    openScrim(modalShell("Suggest for: "+(r.problem||"this issue"), body));
    if(needShots) renderSugShots();
    var f=el("f-canned"); if(f) f.focus();
  }
  function submitAddition(btn){
    if((el("f-website").value||"").trim()){ closeScrim(); return; }
    var t=state.addTarget||{}, canned=el("f-canned")?el("f-canned").value.trim():"", n=_sugShots.length;
    if(!canned && !n){ toast(el("f-canned")&&el("f-shots")?"Add a canned message or a screenshot.":(el("f-canned")?"Write the canned message.":"Add a screenshot.")); return; }
    btn.disabled=true; btn.textContent="Sending";
    var v={category:t.category, entity:t.entity, problem:t.problem, canned:canned, with_shots:n, website:""};
    function fail(msg){ btn.disabled=false; btn.textContent="Send for review"; toast(msg||"Could not send. Please try again."); }
    fetch(API+"/known-issues-suggest-addition",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(!res.ok) return fail(res.j&&res.j.error);
        if(n && res.j && res.j.id && res.j.upload_token){
          return uploadSugShots(res.j.id, res.j.upload_token).then(function(u){
            _sugShots=[]; closeScrim(); toast(u.err ? "Suggestion sent, "+u.done+" of "+n+" screenshots attached." : "Suggestion sent.");
          });
        }
        closeScrim(); toast("Suggestion sent.");
      }, function(){ fail(); });
  }
  /* Screenshots are a small strip under the text (solution and canned message come first); a click opens
     the full-size viewer. */
  function shotsHtml(r, idx){
    var urls=shotUrls(r);
    if(!urls.length) return '';
    var alt=esc((r.problem||"Issue")+" screenshot");
    return '<div class="shots'+(urls.length===1?' single inline':'')+'">'+urls.map(function(u,i){
      return '<button class="shot" data-shot="'+idx+'" data-i="'+i+'" aria-label="Open screenshot '+(i+1)+' of '+urls.length+'"><img src="'+esc(u)+'" alt="'+alt+'" loading="'+(urls.length===1?"eager":"lazy")+'" decoding="async" referrerpolicy="no-referrer"></button>';
    }).join('')+'</div>';
  }
  // One screenshot is shown enlarged and centred in the card (decided in the markup, so nothing jumps
  // after the image loads); several screenshots stay a strip of thumbnails.
  // ---- screenshot viewer ----
  var _lb={list:[],i:0,title:""};
  function lbShow(){
    var u=_lb.list[_lb.i]; if(!u) return;
    el("lb-img").src=u; el("lb-open").href=u; el("lb-title").textContent=_lb.title;
    el("lb-count").textContent=_lb.list.length>1?(_lb.i+1)+" of "+_lb.list.length:"";
    Array.prototype.forEach.call(document.querySelectorAll("[data-lb-step]"), function(b){ b.style.visibility=_lb.list.length<2?"hidden":""; });   // keep their grid slots, so the image stays centred
  }
  function lbOpen(r,i){ _lb={list:shotUrls(r),i:i||0,title:r.problem||""}; el("lb").hidden=false; document.body.style.overflow="hidden"; lbShow(); var c=el("lb").querySelector("[data-lb-close]"); if(c) c.focus(); }
  function lbClose(){ el("lb").hidden=true; el("lb-img").removeAttribute("src"); document.body.style.overflow=""; }
  function lbStep(d){ if(_lb.list.length<2) return; _lb.i=(_lb.i+d+_lb.list.length)%_lb.list.length; lbShow(); }

  function openScrim(html){ el("modal").innerHTML=html; el("scrim").classList.add("open"); }
  function closeScrim(){ el("scrim").classList.remove("open"); el("modal").innerHTML=""; }

  function showDetail(html){
    var backTo = searching() ? "Results" : "All "+tabLabel(state.selCat||state.tab).toLowerCase();
    el("detail").innerHTML='<button class="btn sm back" data-back><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>'+esc(backTo)+'</button>'+html;
    document.body.classList.add("show-detail");
    Array.prototype.forEach.call(el("grid").querySelectorAll(".gi:not(.nogame)"), function(b){ b.classList.toggle("active", b.getAttribute("data-key")===state.sel && b.getAttribute("data-cat")===state.selCat); });
    if(narrow()) window.scrollTo(0,0);
  }
  function nothere(c, entity){
    return '<div class="nothere"><span style="flex:1"><b>Not here?</b> Suggest an issue'+(entity?' for '+esc(entity):'')+'.</span>'+
      '<button class="btn sm" data-suggest data-cat="'+esc(c)+'" data-entity="'+esc(entity||"")+'">Suggest issue</button></div>';
  }
  function openDetail(c, key){
    var d=cat(c), title, cards, entity="", sub="";
    if(d.has_entity){
      // Exact name: "Alan Wake 2 (Epic)" and "Alan Wake 2" are separate entries (launcher-only issues),
      // as are "Desktop (Windows)" and "Desktop (Windows Latest)". Deep links resolve by game ID (afterLoad).
      var rows=(d.rows||[]).filter(function(r){return (r.entity||"(unnamed)")===key;});
      if(!rows.length) return;
      title=key; entity=key;
      var ids=idsFor(key);
      sub=ids?'<span>Game ID <span class="num">'+esc(ids.join(", "))+'</span></span>':'';
      state.rows=rows;
      cards=rows.map(function(r,i){return issueCard(r,false,i);}).join("");
    } else {
      var r0=(d.rows||[])[parseInt(key,10)];
      if(!r0) return;
      title=r0.problem||"Issue"; sub='<span>'+esc(tabLabel(c))+'</span>';
      state.rows=[r0];
      cards=issueCard(r0,true,0);
    }
    state.sel=key; state.selCat=c;
    showDetail('<div class="dhead"><h2>'+esc(title)+'</h2>'+(sub?'<div class="dsub">'+sub+'</div>':'')+'</div>'+cards);   // "Suggest issue" stays in the page header
  }

  function modalShell(title, inner){
    return '<div class="modal-head"><h2>'+esc(title)+'</h2><button class="modal-x" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>'+inner;
  }

  // Empty state for a deep-linked game that has no published issues yet.
  // Empty state for a deep-linked game that has no published issues yet.
  function openGameEmpty(title){
    state.sel=null; state.selCat=null;
    Array.prototype.forEach.call(el("grid").querySelectorAll(".gi"), function(b){ b.classList.toggle("active", b.getAttribute("data-nogame")===title); });
    showDetail('<div class="dhead"><h2>'+esc(title)+'</h2><div class="dsub"><span>No known issues yet</span></div></div>'+
      nothere("games", title));
  }

  function openSuggest(preCat, preEntity){
    var c = preCat || state.tab;
    if(!HAS_ENTITY[c] && c!=="session" && c!=="account") c="games";
    var hasEnt = !!HAS_ENTITY[c];
    _ents = (c==="games" && preEntity) ? [preEntity] : [];
    var entRow = hasEnt ? '<div class="field"><label for="f-entity">'+(c==="games"?"Games":"Application")+' <span class="req">*</span></label>'+(c==="games"?'<div class="ent-chips" id="f-ents" hidden></div>':'')+'<input id="f-entity" value="'+esc(c==="games"?"":(preEntity||""))+'" placeholder="'+(c==="games"?"Start typing a game, e.g. Grand Theft Auto V":"Application name")+'" autocomplete="off"'+(c==="games"?' role="combobox" aria-autocomplete="list" aria-controls="f-entity-ac"':'')+'>'+(c==="games"?'<div class="ac" id="f-entity-ac" role="listbox"></div>':'')+'</div>' : '';
    var body='<div class="modal-body">'+
      '<div class="note">Your suggestion will be added after admin approves it.</div>'+
      '<input type="text" class="hp" id="f-website" tabindex="-1" autocomplete="off" aria-hidden="true">'+
      entRow+
      '<div class="field"><label>Problem <span class="req">*</span></label><input id="f-problem" placeholder="Short problem title"></div>'+
      '<div class="field"><label>Solution or explanation</label><textarea id="f-solution" placeholder="How to resolve or explain it"></textarea></div>'+
      '<div class="field"><label>Link (optional)</label><input id="f-link" placeholder="https://"></div>'+
      '<div class="field"><label>Canned message (optional)</label><textarea id="f-canned" placeholder="A ready-to-send reply for the user"></textarea></div>'+
      (state.data&&state.data.shots_enabled ? '<div class="field"><label>Screenshots (optional)</label><div class="picks" id="f-shots"></div><div class="hint">PNG, JPEG or WebP, max 3</div></div>' : '')+
      '</div>'+
      '<div class="modal-foot"><button class="btn primary" id="f-send" data-cat="'+esc(c)+'" data-hasent="'+(hasEnt?1:0)+'">Send for review</button><button class="btn ghost" data-close>Cancel</button></div>';
    _sugShots=[];
    openScrim(modalShell("Suggest known issue in "+tabLabel(c), body));
    renderSugShots();
    var fe = el("f-entity");
    if(fe && c==="games"){ fe.addEventListener("input", acInput); fe.addEventListener("keydown", acKey); renderEnts(); }
    var pf = (fe && !fe.value) ? fe : el("f-problem"); if(pf) pf.focus();
  }

  function submitSuggest(btn){
    if((el("f-website").value||"").trim()){ closeScrim(); return; }   // honeypot
    var c=btn.getAttribute("data-cat"), hasEnt=btn.getAttribute("data-hasent")==="1";
    var v={ category:c,
      entity: (hasEnt && c!=="games") ? (el("f-entity")?el("f-entity").value.trim():"") : "",
      entities: (hasEnt && c==="games") ? _ents.concat((el("f-entity")&&el("f-entity").value.trim())?[el("f-entity").value.trim()]:[]) : [],
      problem: el("f-problem").value.trim(),
      solution: el("f-solution").value.trim(),
      link: el("f-link").value.trim(),
      canned: el("f-canned").value.trim(),
      website: "" };
    if(hasEnt && !v.entity && !v.entities.length){ toast("Please enter the "+(c==="games"?"game":"application")+" name."); return; }
    if(!v.problem){ toast("Please enter the problem."); return; }
    btn.disabled=true; btn.textContent="Sending";
    fetch(API+"/known-issues-suggest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(res.ok){
          if(_sugShots.length && res.j && res.j.id && res.j.upload_token){
            btn.textContent="Sending"; var list_n=_sugShots.length;
            uploadSugShots(res.j.id, res.j.upload_token).then(function(r){
              _sugShots=[]; closeScrim();
              toast(r.err ? "Suggestion sent, "+r.done+" of "+list_n+" screenshots attached." : "Suggestion sent.");
            });
            return;
          }
          closeScrim(); toast("Suggestion sent.");
        }
        else { btn.disabled=false; btn.textContent="Send for review"; toast((res.j&&res.j.error)||"Could not send. Please try again."); }
      })
      .catch(function(){ btn.disabled=false; btn.textContent="Send for review"; toast("Could not send. Please try again."); });
  }

  // ---- events ----
  document.addEventListener("click", function(ev){
    var t=ev.target.closest("[data-tab]"); if(t){
      var tc=t.getAttribute("data-tab");
      if(searching()){   // a tab jumps to its group of results instead of dropping the search
        var h=el("grid").querySelector('[data-cat-h="'+tc+'"]'); if(h){ document.body.classList.remove("show-detail"); h.scrollIntoView({block:"start", behavior:"smooth"}); }
        return;
      }
      state.tab=tc; state.lq=""; state.sel=null; state.selCat=null; document.body.classList.remove("show-detail"); refreshList(); ensureSelection(); return;
    }
    var ng=ev.target.closest("[data-nogame]"); if(ng){ openGameEmpty(ng.getAttribute("data-nogame")); return; }
    var pk=ev.target.closest("[data-pick]"); if(pk){ addEnt(pk.getAttribute("data-pick")); el("f-entity-ac").classList.remove("open"); return; }
    var ue=ev.target.closest("[data-unent]"); if(ue){ _ents.splice(+ue.getAttribute("data-unent"),1); renderEnts(); return; }
    var us=ev.target.closest("[data-unshot]"); if(us){ _sugShots.splice(+us.getAttribute("data-unshot"),1); renderSugShots(); return; }
    if(el("f-entity-ac") && !ev.target.closest(".field")) el("f-entity-ac").classList.remove("open");
    if(ev.target.closest("#fb-btn")){ toggleFeedback(); return; }
    if(ev.target.closest("#fb-close")){ toggleFeedback(false); return; }
    var fc=ev.target.closest("[data-fbcat]"); if(fc){ Array.prototype.forEach.call(fc.parentNode.children,function(b){ var on=b===fc; b.classList.toggle("on",on); b.setAttribute("aria-checked",on?"true":"false"); }); return; }
    var fs=ev.target.closest("#fb-send"); if(fs){ submitFeedback(fs); return; }
    var sh=ev.target.closest("[data-shot]"); if(sh){ var rr=(state.rows||[])[+sh.getAttribute("data-shot")]; if(rr) lbOpen(rr, +sh.getAttribute("data-i")); return; }
    var st=ev.target.closest("[data-lb-step]"); if(st){ lbStep(+st.getAttribute("data-lb-step")); return; }
    if(ev.target.closest("[data-lb-close]") || ev.target.id==="lb" || ev.target.classList.contains("lb-imgbox")){ lbClose(); return; }
    var gi=ev.target.closest(".gi"); if(gi){ openDetail(gi.getAttribute("data-cat")||state.tab, gi.getAttribute("data-key")); return; }
    if(ev.target.closest("[data-back]")){ document.body.classList.remove("show-detail"); if(narrow()) state.sel=null; return; }
    if(ev.target.closest("[data-close]")){ closeScrim(); return; }
    var sg=ev.target.closest("[data-suggest]"); if(sg){ openSuggest(sg.getAttribute("data-cat"), sg.getAttribute("data-entity")); return; }
    if(ev.target.id==="suggest-btn"||ev.target.closest("#suggest-btn")){ openSuggest(state.tab, ""); return; }
    var send=ev.target.closest("#f-send"); if(send){ submitSuggest(send); return; }
    var ads=ev.target.closest("[data-addsug]"); if(ads){ openAddition(+ads.getAttribute("data-addsug")); return; }
    var adsend=ev.target.closest("#f-add-send"); if(adsend){ submitAddition(adsend); return; }
    var eds=ev.target.closest("[data-editsug]"); if(eds){ openEditSuggest(+eds.getAttribute("data-editsug")); return; }
    var edsend=ev.target.closest("#f-edit-send"); if(edsend){ submitEditSuggest(edsend); return; }
    var cp=ev.target.closest("[data-copy]"); if(cp){
      var body=cp.closest(".canned").querySelector(".canned-body");
      var txt=body?body.textContent:"";
      var sel=function(){ try{ var r=document.createRange(); r.selectNodeContents(body); var w=window.getSelection(); w.removeAllRanges(); w.addRange(r); toast("Selected, press Ctrl+C"); }catch(e){} };
      var done=function(){   // the button itself confirms, for ~1.5 s
        cp.classList.add("copied"); cp.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg><span>Copied</span>';
        clearTimeout(cp._t); cp._t=setTimeout(function(){ cp.classList.remove("copied"); cp.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg><span>Copy</span>'; },1500);
      };
      if(navigator.clipboard){ navigator.clipboard.writeText(txt).then(done,sel); } else sel();
      return;
    }
    if(ev.target.id==="scrim" && !el("f-send") && !el("f-add-send") && !el("f-edit-send")){ closeScrim(); }   // the suggest form closes only via Cancel/X, so a stray click can't lose typed text
  });
  document.addEventListener("keydown", function(ev){
    if(!el("lb").hidden){ if(ev.key==="Escape") lbClose(); else if(ev.key==="ArrowRight") lbStep(1); else if(ev.key==="ArrowLeft") lbStep(-1); return; }
    if(ev.key==="Escape"){ if(el("fb-panel").classList.contains("open")) toggleFeedback(false); else closeScrim(); }
  });
  document.addEventListener("input", function(ev){ if(ev.target && ev.target.id==="fb-msg") fbCount(); });
  document.addEventListener("change", function(ev){ if(ev.target && ev.target.id==="f-shot-input"){ addSugShots(ev.target.files); ev.target.value=""; } });
  // paste a screenshot anywhere in the open suggest form
  document.addEventListener("paste", function(ev){
    if(!el("f-shots") || !ev.target.closest || !ev.target.closest(".modal")) return;
    var imgs=Array.prototype.filter.call((ev.clipboardData&&ev.clipboardData.files)||[], function(f){ return /^image\//.test(f.type||""); });
    if(imgs.length){ ev.preventDefault(); addSugShots(imgs); }
  });
  var _qT=null;
  el("search").addEventListener("input", function(){
    var v=this.value; clearTimeout(_qT);
    _qT=setTimeout(function(){
      state.q=v; if(narrow()) document.body.classList.remove("show-detail");
      refreshList(); ensureSelection();
    }, 90);
  });
  el("search").addEventListener("keydown", function(ev){ if(ev.key==="Escape" && this.value){ ev.stopPropagation(); this.value=""; state.q=""; refreshList(); ensureSelection(); } });
  var _lqT=null;
  el("lsearch").addEventListener("input", function(){
    var v=this.value; clearTimeout(_lqT);
    _lqT=setTimeout(function(){ state.lq=v; renderGrid(); ensureSelection(); }, 90);
  });
  el("lsearch").addEventListener("keydown", function(ev){ if(ev.key==="Escape" && this.value){ ev.stopPropagation(); this.value=""; state.lq=""; renderGrid(); ensureSelection(); } });

  // ---- deep link: /knownissues/<game-id> ----
  function parseGid(){
    var m=(location.pathname||"").match(/\/knownissues\/([^\/?#]+)/i);
    return m?decodeURIComponent(m[1]):null;
  }
  function afterLoad(){
    el("stage").style.display="none";
    refreshList();
    var gid=state.deepGid;
    if(!gid || state._deepDone){ if(state.sel!=null && state.selCat) openDetail(state.selCat, state.sel); else ensureSelection(); return; }   // resolve the deep link once (survives the background refresh re-render)
    state._deepDone=true;
    fetch(API+"/game/"+encodeURIComponent(gid)).then(function(r){ return r.ok?r.json():null; }).then(function(g){
      if(!g||!g.ok||!g.title){ ensureSelection(); return; }   // unknown id: just show the full page
      state.tab="games"; refreshList();
      var d=cat("games");
      // Open the entry this ID belongs to: an "(Epic)" entry for the Epic ID, a "(Steam)" one for the Steam
      // ID, else the plain name (which covers every launcher). Same-name entries are never merged.
      var ents=[], seen={};
      (d.rows||[]).forEach(function(r){ var e=r.entity||""; if(e && !seen[e]){ seen[e]=1; ents.push(e); } });
      var byId=ents.filter(function(e){ return (idsFor(e)||[]).indexOf(String(gid))>=0; });
      var withLauncher=byId.filter(function(e){ return !!splitLauncher(e).launcher; });
      var ngt=normGameTitle(g.title);
      var pick=withLauncher[0] || byId[0] ||
        ents.filter(function(e){ return normGameTitle(e)===ngt && !splitLauncher(e).launcher; })[0] ||
        ents.filter(function(e){ return normGameTitle(e)===ngt; })[0];
      if(pick) openDetail("games", pick); else openGameEmpty(g.title);
    }).catch(function(){ ensureSelection(); });
  }

  function fmtUpdated(iso){
    if(!iso) return "";
    var s=String(iso);
    var d=new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s)?s:s+"Z");   // stored as naive UTC
    if(isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"})+", "+d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
  }
  function renderUpdated(){
    var elu=el("updated"); if(!elu) return;
    var t=fmtUpdated(state.data&&state.data.updated_at);
    if(t){ elu.innerHTML='Last updated <span class="num">'+esc(t)+'</span>'; elu.hidden=false; } else { elu.hidden=true; }
  }
  function applyData(d){ state.data=d||{categories:{}}; state.gameIds=(d&&d.game_ids)||{}; renderUpdated(); afterLoad(); }

  state.deepGid=parseGid();
  // Stale-while-revalidate: paint the last cached copy INSTANTLY (the data changes only on the ~daily
  // sync), then fetch fresh in the background and update. Repeat visits feel instant.
  var _painted=false;
  try {
    var cached=localStorage.getItem("ki_cache");
    if(cached){ var cd=JSON.parse(cached); if(cd&&cd.categories){ applyData(cd); _painted=true; } }
  }catch(e){}
  fetch(API+"/known-issues").then(function(r){ return r.json(); }).then(function(d){
    if(!d||!d.categories) return;
    try{ localStorage.setItem("ki_cache", JSON.stringify(d)); }catch(e){}
    applyData(d);
  }).catch(function(){
    if(!_painted) el("stage").textContent="Could not load. Please refresh the page.";
  });
})();
