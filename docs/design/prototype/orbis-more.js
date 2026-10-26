(function(){
const M={};window.__orbisMore=M;
const B=(type,o)=>Object.assign({isH:false,isP:false,isProps:false,isCode:false,isNote:false,isFrame:false,isTree:false,isGraph:false,isRows:false,isText:false,isBtns:false,isComposer:false,isSearch:false,isItems:false,acts:[],rows:[],segs:[],lines:[],fs:'13px',mt:'0',meta:'',color:'var(--oe8e9eb)'},{['is'+type]:true},o||{});
const MONO="'JetBrains Mono',ui-monospace,Consolas,monospace";
function base(c,head,o){const {out,lang}=c;const L=(a,b)=>lang==='en'?b:a;out.head=head;out.hasTitle=true;Object.assign(out,o||{});return L;}
const g=(text,o)=>Object.assign({text,color:'inherit',bg:'transparent',pad:'0',font:'inherit',fs:'inherit',cursor:'default',ring:'none',on:null},o||{});
const link=(text,on)=>g(text,{color:'var(--o9cc3ff)',bg:'var(--tint-accent-12, rgba(127,176,250,.12))',pad:'0 4px',font:MONO,fs:'11px',cursor:'pointer',on});
const wl=(text,on)=>g(text,{color:'var(--o9cc3ff)',cursor:'pointer',on});
const pane=(blocks,o)=>Object.assign({blocks,bg:'transparent',pad:'0'},o||{});
const rr=(icon,label,meta,o)=>Object.assign({icon,hasIcon:!!icon,label,meta,icColor:'var(--o8b9098)',metaColor:'var(--o8b9098)',font:'inherit',hasAct:false,act:'',on:()=>{},dis:false,op:1},o||{});
function btn(c,label,o){return Object.assign({label,icon:null,tail:null,on:()=>{},dis:c.ro,tip:c.ro?(c.lang==='en'?'View only':'只能檢視'):'',bg:'var(--o22242a)',color:'var(--oe8e9eb)',fw:400,op:c.ro?0.45:1},o||{});}
const pri=o=>Object.assign({bg:'var(--obtn)',color:'var(--obtnfg)',fw:550},o||{});
function sw(c,on,toggle,dis){return {hasSw:true,swOn:on,sw:toggle,swDis:!!dis||c.ro,swOp:(dis||c.ro)?0.45:1,swBg:on?c.C.acc:'var(--o3d4047)',swKnob:on?'14px':'2px'};}
function docs(c,panes,cols){c.out.bDocs=c.body;const rep=/^repeat\((\d+),/.exec(cols);const tk=rep?Array(+rep[1]).fill('minmax(0,1fr)'):cols.split(/ (?![^(]*\))/);panes.forEach((p,i)=>{const k=tk[Math.min(i,tk.length-1)]||'minmax(0,1fr)';let f='1 1 320px';const px=/^(\d+)px$/.exec(k);const mx=/^minmax\(0,(\d+)px\)$/.exec(k);if(rep)f='1 1 240px';else if(px)f='0 1 '+px[1]+'px';else if(mx)f='0 1 '+mx[1]+'px';p.flex=c.narrow?'1 1 100%':f;});c.out.panes=panes;}
function exportMenu(c,L,id){c.menus[id]=[{label:'Markdown',sub:'report-2026-10-25.md',icon:'download',on:()=>c.flash(L('已下載 Markdown','Downloaded Markdown'))},{label:'CSV',sub:'report-2026-10-25.csv',icon:'download',on:()=>c.flash(L('已下載 CSV','Downloaded CSV'))},{sep:true},{label:L('存成 Wiki 頁…','Save as wiki page…'),icon:'book',on:()=>c.dlg('saveWiki')}];return e=>c.menu(e,id);}
function emptyAs(c,text,act){const o=c.out;o.emptyText=text;o.emptyHasAct=!!act;o.emptyAct=act||'';}
// 24 team overview
function repData(L){
  const T=(k,zh,en,d,o)=>Object.assign({k,t:L(zh,en),d},o||{});
  return {
    kashionz:{status:[L('已產生','Generated'),'ok'],stats:[6,3,0,4,6,18],gc:[5,1],daily:[3,5,2,6,4,0,1],
      hl:[[L('完成 Windows 換行修正與執行器長路徑支援，兩個合併請求已合併 ','Finished the Windows line-ending fix and runner long-path support; two pull requests merged '),'ORB-42','#128','#131'],[L('發票按比例計算卡在審查關卡，等待 mei-lin 回覆 ','Prorated invoices is waiting at the review gate for mei-lin '),'ORB-38'],[L('下一步：拆出退款流程，下週開始 ','Next: split out the refund flow and start it next week '),'ORB-62']],
      done:[T('ORB-42','修正 Windows 上的換行測試','Fix line-ending tests on Windows','10/24'),T('ORB-36','執行器長路徑支援','Long path support on runners','10/23'),T('ORB-26','匯入 CSV 欄位對應','CSV import field mapping','10/23'),T('ORB-33','工作樹路徑超過 260 字元時改用長路徑','Use long paths for worktrees over 260 chars','10/22'),T('ORB-30','登入頁改版','Login page refresh','10/21'),T('ORB-24','側欄搜尋快捷鍵','Sidebar search shortcut','10/20')],
      ip:[T('ORB-51','匯出 CSV 的編碼','CSV export encoding','',{st:[L('執行中','Running'),'acc']}),T('ORB-38','發票按比例計算','Prorated invoices','',{st:[L('審查關卡','Review gate'),'warn']}),T('ORB-60','帳務重構','Billing rework','',{st:[L('規劃中','Planning'),'muted']})],
      prs:[T('#131','feat: long paths','feat: long paths','10/24'),T('#128','fix: normalize EOL on read','fix: normalize EOL on read','10/23'),T('#125','feat: csv field mapping','feat: csv field mapping','10/23'),T('#122','feat: sidebar search shortcut','feat: sidebar search shortcut','10/20')],
      gates:[T('ORB-36','核准審查關卡','Approved the review gate','10/23',{ok:true}),T('ORB-47','退回審查關卡：缺少測試','Returned the review gate: missing tests','10/22',{ok:false}),T('ORB-33','核准計畫關卡','Approved the plan gate','10/21',{ok:true})],
      other:[[18,4,2,6]],note:L('ORB-38 等設計確認，下週一再排。','ORB-38 is waiting on design; I’ll pick it up Monday.'),
      cm:[['mei-lin',L('ORB-38 我今天下午看','I’ll review ORB-38 this afternoon'),L('10/25 10:12','Oct 25 10:12')]]},
    'mei-lin':{status:[L('1 個卡住','1 blocked'),'warn'],stats:[4,2,1,3,2,14],gc:[2,0],daily:[2,3,4,1,3,0,0],
      hl:[[L('完成帳單 PDF 版面並合併 ','Finished the invoice PDF layout and merged '),'ORB-29','#126'],[L('退回發票按比例計算的審查，要求補上邊界測試 ','Returned the prorated invoices review and asked for edge-case tests '),'ORB-38'],[L('卡住：等設計提供退款畫面 ','Blocked: waiting for design on the refund screen '),'ORB-62']],
      done:[T('ORB-29','帳單 PDF 版面','Invoice PDF layout','10/23'),T('ORB-28','發票編號規則','Invoice numbering rules','10/22'),T('ORB-25','稅率表匯入','Tax table import','10/21'),T('ORB-23','帳單寄送紀錄','Invoice delivery log','10/20')],
      ip:[T('ORB-62','退款流程','Refund flow','',{st:[L('卡住','Blocked'),'warn']}),T('ORB-63','稅率表','Tax tables','',{st:[L('執行中','Running'),'acc']})],
      prs:[T('#126','feat: invoice pdf','feat: invoice pdf','10/22'),T('#123','fix: tax rounding','fix: tax rounding','10/21'),T('#120','feat: invoice numbering','feat: invoice numbering','10/20')],
      gates:[T('ORB-38','退回審查關卡：需要邊界測試','Returned the review gate: needs edge-case tests','10/24',{ok:false}),T('ORB-29','核准審查關卡','Approved the review gate','10/23',{ok:true})],
      other:[[14,2,5,9]],note:'',cm:[]},
    'chen-yu':{status:[L('2 個卡住','2 blocked'),'warn'],stats:[3,4,2,2,3,10],gc:[1,2],daily:[1,2,2,3,1,0,0],
      hl:[[L('匯出 CSV 加上 BOM，修好 Excel 開啟亂碼 ','Added a BOM to CSV export so Excel opens it correctly '),'ORB-27'],[L('看板拖曳排序在等 ','Drag to reorder is waiting on '),'ORB-36'],[L('通知改成推送在等 ','Push notifications are waiting on '),'ORB-42']],
      done:[T('ORB-27','匯出 CSV 加上 BOM','Add BOM to CSV export','10/22'),T('ORB-21','執行器日誌輪替','Runner log rotation','10/21'),T('ORB-20','終端機字型設定','Terminal font setting','10/19')],
      ip:[T('ORB-45','看板拖曳排序','Drag to reorder on the board','',{st:[L('卡住','Blocked'),'warn']}),T('ORB-47','通知改成推送','Switch notifications to push','',{st:[L('卡住','Blocked'),'warn']}),T('ORB-52','執行器健康檢查','Runner health check','',{st:[L('執行中','Running'),'acc']}),T('ORB-53','通知中心分組','Group notifications in the inbox','',{st:[L('待辦','Backlog'),'muted']})],
      prs:[T('#124','chore: runner logs','chore: runner logs','10/19'),T('#121','feat: terminal font','feat: terminal font','10/19')],
      gates:[T('ORB-27','核准審查關卡','Approved the review gate','10/22',{ok:true}),T('ORB-52','退回審查關卡：健康檢查逾時','Returned the review gate: health check timed out','10/21',{ok:false}),T('ORB-21','退回計畫關卡','Returned the plan gate','10/20',{ok:false})],
      other:[[10,1,0,3]],note:'',cm:[['mei-lin',L('ORB-45 我會先合 ORB-36，明天應該可以動。','I’ll merge ORB-36 first; ORB-45 should be unblocked tomorrow.'),L('10/24 16:40','Oct 24 16:40')]]}};
}
const PILL={ok:['var(--tint-success, rgba(79,184,106,.12))','var(--o4fb86a)'],warn:['var(--tint-warn, rgba(217,168,69,.14))','var(--od9a845)'],acc:['var(--tint-accent-12, rgba(127,176,250,.12))','var(--o9cc3ff)'],muted:['var(--o22242a)','var(--o8b9098)']};
const pillOf=(label,k)=>({label,bg:PILL[k][0],c:PILL[k][1]});
M.reports=c=>{const {out,s,set,ro,isEmptyState,av,C,segOf,p,icn,narrow}=c;const L=base(c,c.lang==='en'?'Reports':'報告');
  const per=s.rp||'week',prj=s.rprj||'all',srt=s.rsort==='blocked'?'blocked':'done';
  out.headSegs=[segOf([['today',L('今天','Today')],['week',L('本週','This week')],['month',L('本月','This month')],['custom',L('自訂','Custom')]],per,v=>set({rp:v})),segOf([['all',L('全部專案','All projects')],['ORB','ORB'],['WEB','WEB']],prj,v=>set({rprj:v})),segOf([['done',L('依完成','By done')],['blocked',L('依卡住','By blocked')]],srt,v=>set({rsort:v}))];
  const PL={today:L('10/25','Oct 25'),week:L('10/19 – 10/25','Oct 19 – 25'),month:L('10/1 – 10/25','Oct 1 – 25'),custom:L('10/12 – 10/25','Oct 12 – 25')}[per];
  const m=(per==='today'?0.25:per==='month'?3.4:per==='custom'?1.8:1)*(prj==='WEB'?0.34:1);const sc=n=>Math.round(n*m);
  const D=repData(L);let names=Object.keys(D);if(ro)names=names.filter(w=>w==='kashionz');
  const k={done:0,blocked:2}[srt];names.sort((a,b)=>D[b].stats[k]-D[a].stats[k]);
  const days=L('一二三四五六日','MTWTFSS').split('');
  out.groups=[];out.headActs=[];out.bReps=!isEmptyState;out.isEmpty=!!isEmptyState;if(isEmptyState)emptyAs(c,L('這段期間沒有活動','No activity in this period'));
  out.rlCols=narrow?'minmax(0,1fr)':'repeat(auto-fill,minmax(260px,1fr))';out.rlNote=!!ro;out.rlNoteT=L('只看得到自己的週報','You can only see your own report');
  out.rl=names.map(w=>{const d=D[w];const st=d.stats.map(sc);const tot=st[0]+st[1]+st[2];const pct=tot?Math.round(st[0]/tot*100):0;const mx=Math.max.apply(null,d.daily);
    return {name:w,av:av(w,32),sub:(per==='week'?L('週報  ','Weekly report  '):'')+PL,status:pillOf(d.status[0],d.status[1]),aria:L('開啟 '+w+' 的報告','Open '+w+'’s report'),
      stats:[[L('完成','Done'),st[0],C.text],[L('進行中','In progress'),st[1],C.text],[L('卡住','Blocked'),st[2],st[2]?C.warn:C.muted],['PR',st[3],C.text]].map(([l,v,col])=>({l,v:String(v),c:col})),
      pct:pct+'%',pctL:pct+'%',compL:L('完成率','Completion'),hl:d.hl[0][0].trim()+' '+d.hl[0].slice(1).join(' '),
      spark:d.daily.map((n,i)=>({h:Math.max(2,Math.round(n/mx*22))+'px',bg:i>=5?'var(--o3d4047)':C.acc,tip:days[i]+'  '+n})),
      gates:L('審查 核准 '+sc(d.gc[0])+' · 退回 '+sc(d.gc[1]),'Reviews '+sc(d.gc[0])+' approved · '+sc(d.gc[1])+' returned'),openL:L('查看報告','View report'),icGo:icn('chevR',12),
      open:()=>{set({rpw:w});if(p.onOpenReport)p.onOpenReport(w);}};});
};
// 25 personal detail
M.report=c=>{const {out,s,set,ro,isEmptyState,flash,icn,C,lang,av,p,narrow}=c;const L=(a,b)=>lang==='en'?b:a;
  const D=repData(L);const w=D[s.rpw]?s.rpw:'kashionz';const d=D[w];
  out.hasTitle=false;out.hasHeadRow=false;out.head=L(w+' 的週報',w+'’s weekly report');
  const ver=s.rv||'v3';const VER=[['v3',L('最新','Latest'),L('10/25 09:00','Oct 25 09:00')],['v2',L('10/18 版','Oct 18'),L('10/18 09:00','Oct 18 09:00')],['v1',L('10/11 版','Oct 11'),L('10/11 09:00','Oct 11 09:00')]];
  c.menus.rver=[{head:true,label:L('重點的歷史版本','Highlights history')}].concat(VER.map(x=>({label:x[1],sub:x[2],icon:'clock',sel:x[0]===ver,on:()=>set({rv:x[0]})})));
  const act=(label,icon,on,o)=>Object.assign({label,icon:icn(icon,13),tail:null,hasTail:false,on,dis:false,op:1,tip:''},o||{});
  const keyOpen=k=>()=>{if(k.charAt(0)==='#'){flash(L('開啟合併請求 ','Opening pull request ')+k);return;}if(p.onOpenTask)p.onOpenTask(k);else flash(L('開啟 ','Open ')+k);};
  const segsOf=h=>[{t:h[0],isKey:false,plain:true,on:null}].concat(h.slice(1).reduce((a,k)=>a.concat([{t:k,isKey:true,plain:false,on:keyOpen(k)}]),[]));
  const row=(ic,icC,it,o)=>Object.assign({ic:icn(ic,14),icC,hasKey:!!it.k,k:it.k,onKey:keyOpen(it.k),t:it.t,d:it.d||'',hasPill:false,pill:'',pBg:'',pC:''},o||{});
  const E0=isEmptyState;const st=E0?[0,0,0,0,0,0]:d.stats;
  const days=L('一二三四五六日','MTWTFSS').split('');const mx=Math.max.apply(null,d.daily);const o4=d.other[0];
  out.bRep=c.body;
  out.rp={back:()=>{set({dtab:'reports'});if(p.onTab)p.onTab('dashboard');else flash(L('回到成員報告','Back to member reports'));},backL:L('成員報告','Member reports'),icBack:icn('chevL',14),
    av:av(w,40),title:L(w+' 的週報',w+'’s weekly report'),period:L('10/19 – 10/25','Oct 19 – 25'),status:pillOf(d.status[0],d.status[1]),
    meta:L((ver==='v3'?'10/25 09:00':VER.find(x=>x[0]===ver)[2])+' 更新','Updated '+(ver==='v3'?'Oct 25 09:00':VER.find(x=>x[0]===ver)[2])),
    acts:[act(L('版本  ','Version  ')+VER.find(x=>x[0]===ver)[1],'clock',e=>c.menu(e,'rver'),{tail:icn('chevD',12),hasTail:true,dis:E0,op:E0?0.45:1}),act(L('匯出','Export'),'download',exportMenu(c,L,'rexp'),{tail:icn('chevD',12),hasTail:true}),act(L('重新產生','Regenerate'),'rotate',()=>c.dlg('regen',{after:()=>set({rv:'v3'})}),{dis:E0||ro,op:E0||ro?0.45:1,tip:ro?L('只能檢視','View only'):''})],
    kpiCols:narrow?'repeat(2,minmax(0,1fr))':'repeat(4,minmax(0,1fr))',
    kpis:[[L('完成的任務','Tasks completed'),st[0],E0?'':L('比上週 +2','+2 vs last week'),C.ok],[L('進行中','In progress'),st[1],E0?'':(st[2]?L('其中 '+st[2]+' 個卡住',st[2]+' blocked'):L('沒有卡住','None blocked')),st[2]?C.warn:C.muted],[L('合併請求','Pull requests'),st[3],E0?'':L('全部已合併','All merged'),C.muted],[L('完成的審查','Reviews done'),st[4],E0?'':L('核准 '+d.gc[0]+'，退回 '+d.gc[1],d.gc[0]+' approved, '+d.gc[1]+' returned'),C.muted]].map(([l,v,dl,dc])=>({l,v:String(v),d:dl,dc})),
    cols:narrow?'minmax(0,1fr)':'minmax(0,1fr) 300px',
    hlH:L('本週重點','Highlights'),hlMeta:ver==='v3'?'':VER.find(x=>x[0]===ver)[1],hlNone:E0,hlNoneT:L('只有統計，沒有本週重點：沒有可用的團隊執行器','Stats only, no highlights: no team runner available'),icAlert:icn('alert',14),
    hl:E0?[]:d.hl.map((h,i)=>({n:String(i+1),segs:segsOf(h)})),
    cards:E0?[]:[
      {title:L('完成的任務','Completed tasks'),ic:icn('check',14),icC:C.ok,count:String(d.done.length),rows:d.done.map(it=>row('check',C.ok,it))},
      {title:L('進行中','In progress'),ic:icn('play',14),icC:C.warn,count:String(d.ip.length),rows:d.ip.map(it=>row('play',C.warn,it,{hasPill:true,pill:it.st[0],pBg:PILL[it.st[1]][0],pC:PILL[it.st[1]][1]}))},
      {title:L('合併請求','Pull requests'),ic:icn('gitMerge',14),icC:C.acc,count:String(d.prs.length),rows:d.prs.map(it=>row('gitMerge',C.acc,it,{hasPill:true,pill:L('已合併','Merged'),pBg:PILL.acc[0],pC:PILL.acc[1]}))},
      {title:L('審查與關卡','Reviews and gates'),ic:icn('shield',14),icC:C.muted,count:String(d.gates.length),rows:d.gates.map(it=>row(it.ok?'check':'x',it.ok?C.ok:C.warn,it))}],
    dayH:L('每日活動','Daily activity'),dayMeta:L('共 '+d.daily.reduce((a,b)=>a+b,0)+' 筆',d.daily.reduce((a,b)=>a+b,0)+' events'),
    days:d.daily.map((n,i)=>({l:days[i],h:E0?'2px':Math.max(3,Math.round(n/mx*56))+'px',bg:i>=5?'var(--o3d4047)':C.acc,tip:days[i]+'  '+(E0?0:n),n:String(E0?0:n)})),
    otherH:L('其他','Other activity'),other:[['play',L('代理執行','Agent runs'),o4[0],''],['msg',L('對話','Conversations'),o4[1],L('不顯示內容','Content not shown')],['book',L('Wiki 編輯','Wiki edits'),o4[2],''],['msg',L('留言','Comments'),o4[3],'']].map(([ic,l,v,sub])=>({ic:icn(ic,14),l,v:String(E0?0:v),sub,hasSub:!!sub})),
  };
  out.isEmpty=false;
};
function swOf(c,on,t,dis){return sw(c,on,t,dis);}
// 28 conversations
M.convs=c=>{const {out,s,set,row,grp,chip,pill,icn,C,isEmptyState,p}=c;const L=base(c,c.lang==='en'?'Conversations':'對話');
  const R=(id,t2,loc,time,unread)=>row({icon:icn('msg',14),title:t2,fw:unread?550:400,cursor:'pointer',click:()=>{if(p.onOpenConv)p.onOpenConv(id);},chips:[pill(loc)].concat(unread?[chip('',{icon:c.dot(C.acc,6)})]:[]),right:time});
  out.groups=[grp('',[R('c1',L('為什麼 CRLF 會讓解析器出錯','Why does CRLF break the parser'),L('工作樹 orbis','Worktree orbis'),L('5 分鐘前','5 min ago'),true),R('c2',L('整理 Q4 帳務需求','Draft Q4 billing requirements'),L('暫存資料夾','Scratch folder'),L('昨天','Yesterday'),false),R('c3',L('清理本機下載資料夾腳本','Clean up local downloads script'),'C:\\Users\\kash\\scripts',L('10/22','Oct 22'),false)])];
  out.headActs=[btn(c,L('新對話','New conversation'),pri({icon:icn('plus',14),dis:false,op:1,tip:'Ctrl N',on:()=>{if(p.onNewConv)p.onNewConv();}}))];
  emptyAs(c,L('還沒有對話','No conversations yet'),L('新對話','New conversation'));
};
M.newconv=c=>{const {out,s,set,icn,C,ro,flash,logo}=c;const L=base(c,c.lang==='en'?'New conversation':'新對話');
  const MODELS={'claude-code':['Opus 5.5','Sonnet 5.5','Haiku 5.5'],codex:['GPT-5 Codex','GPT-5','GPT-5 Mini'],'grok-build':['Grok 4','Grok Code Fast 1']};
  const nc=Object.assign({where:'local',agent:'claude-code',model:'Sonnet 5.5',effort:'std',pol:'yolo',loc:'wt',repo:'Kashionz/orbis',fold:'C:\\Users\\kash\\scripts',sk:['windows-path-fix','pr-description','eol-check','test-first']},s.nc||{});
  const up=o=>{const n=Object.assign({},nc,o);if(n.model==='Haiku 5.5')n.effort='fast';if(n.loc==='local')n.where='local';set({nc:n});};
  const PO=[['yolo',L('全部允許','Allow all'),L('所有動作都不再詢問（預設）','Never ask (default)')],['auto',L('自動','Auto'),L('讀取與工作樹內的編輯自動允許，其他問我','Reads and edits inside the worktree run; everything else asks')],['manual',L('逐一確認','Manual'),L('每個動作都先詢問','Ask before every action')]];
  c.menus.ncPol=PO.map(([k,l,sub])=>({label:l,sub,icon:'shield',sel:nc.pol===k,on:()=>up({pol:k})}));
  const F=s.dfl||['C:\\Users\\kash\\scripts','D:\\notes'];const pickF=['C:\\Users\\kash\\projects\\notes-app','D:\\work\\scratch'];
  const noEff=['Grok 4','Grok Code Fast 1'].indexOf(nc.model)>=0,fixEff=nc.model==='Haiku 5.5';
  const EF=[['fast',L('快速','Fast'),L('較快回覆，適合簡單修改','Quicker replies for simple edits')],['std',L('標準','Standard'),L('預設','Default')],['deep',L('深度','Deep'),L('花更多時間推理','Spends more time reasoning')]];
  const SK=['windows-path-fix','pr-description','docker-debug','notify-format','eol-check','test-first','csv-encoding','release-notes'];
  c.menus.ncModel=[].concat(...Object.keys(MODELS).map(a=>[{head:true,label:a}].concat(MODELS[a].map(m=>({label:m,icon:logo(a,14),sel:nc.agent===a&&nc.model===m,on:()=>up({agent:a,model:m})}))))).concat([{head:true,label:'antigravity'},{label:L('需要重新登入','Sign in again'),icon:logo('antigravity',14),dis:true,tip:L('到設定 → 代理重新登入','Sign in again in Settings → Agents')}]);
  c.menus.ncEff=EF.map(([k,l,sub])=>({label:l,sub,sel:nc.effort===k,dis:noEff||(fixEff&&k!=='fast'),tip:noEff?L('此模型不支援調整推理強度','This model doesn’t support reasoning effort'):(fixEff&&k!=='fast'?L('此模型固定為快速','This model is fixed to Fast'):''),on:()=>up({effort:k})}));
  c.menus.ncWhere=[{label:L('我的電腦','My computer'),sub:'KASH-DESKTOP',icon:'monitor',sel:nc.where==='local',on:()=>up({where:'local'})},{label:L('團隊執行器','Team runner'),sub:'team-runner-01',icon:'server',sel:nc.where==='team',dis:nc.loc==='local',tip:nc.loc==='local'?L('本機資料夾只能在我的電腦跑','Local folders only run on your computer'):'',on:()=>up({where:'team'})}];
  c.menus.ncLoc=[{head:true,label:L('儲存庫的新工作樹','New worktree from a repo')}].concat(['Kashionz/orbis','Kashionz/orbis-desktop'].map(r=>({label:r,mono:true,icon:'git',sel:nc.loc==='wt'&&nc.repo===r,on:()=>up({loc:'wt',repo:r})}))).concat([{sep:true},{head:true,label:L('本機資料夾','Local folder')}]).concat(F.map(f=>({label:f,mono:true,icon:'folder',sel:nc.loc==='local'&&nc.fold===f,on:()=>up({loc:'local',fold:f})}))).concat([{label:L('選擇資料夾…','Choose folder…'),icon:'plus',on:()=>{const p=pickF.find(x=>F.indexOf(x)<0)||pickF[0];set({dfl:F.indexOf(p)<0?F.concat([p]):F});up({loc:'local',fold:p});}},{sep:true},{label:L('空白的暫存資料夾','Empty scratch folder'),icon:'file',sel:nc.loc==='tmp',on:()=>up({loc:'tmp'})}]);
  c.menus.ncSk=[{head:true,label:L('技能','Skills')+'  '+nc.sk.length+' / 6'}].concat(SK.map(k=>({label:k,mono:true,icon:'zap',multi:true,keep:true,sel:nc.sk.indexOf(k)>=0,on:()=>up({sk:nc.sk.indexOf(k)>=0?nc.sk.filter(x=>x!==k):nc.sk.concat([k])})})));
  const MONOF="'JetBrains Mono',ui-monospace,Consolas,monospace";
  const ch=(id,label,aria,icon,o)=>Object.assign({label,aria,tip:aria,icon,hasIcon:!!icon,icColor:C.muted,font:'inherit',hasWarn:false,on:e=>{if(!ro)c.menu(e,id);}},o||{});
  const effL=noEff?L('不支援推理強度','No reasoning effort'):(EF.find(x=>x[0]===nc.effort)||[])[1];const polL=(PO.find(x=>x[0]===nc.pol)||[])[1];const host=nc.where==='local'?'KASH-DESKTOP':'team-runner-01';
  const chips=[ch('ncModel',nc.model,L('模型 ','Model ')+nc.agent+'  '+nc.model,logo(nc.agent,14)),ch('ncEff',effL,L('推理強度 ','Reasoning effort ')+effL,null),ch('ncPol',polL,L('權限策略 ','Permission policy ')+polL,icn('shield',13)),ch('ncWhere',host,L('執行位置 ','Runs on ')+host,icn(nc.where==='local'?'monitor':'server',13),{icColor:C.ok,font:MONOF}),ch('ncSk',String(nc.sk.length),L('技能 ','Skills ')+nc.sk.length,icn('zap',13),{hasWarn:nc.sk.length>6})];
  const locLabel=nc.loc==='wt'?nc.repo:nc.loc==='local'?nc.fold:L('空白的暫存資料夾','Empty scratch folder');
  const empty=!(s.ncQ||'').trim();
  const start=()=>{if(empty||ro)return;const v=Object.assign({},nc,{text:s.ncQ.trim()});set({ncQ:'',ncF:0});if(c.p.onStartConv)c.p.onStartConv(v);else flash(L('已開始對話','Conversation started'));};
  out.groups=[];out.headActs=[];
  if(!s.ncF&&!ro)setTimeout(()=>{const el=document.querySelector('textarea[data-composer]');if(el)el.focus();set({ncF:1});},60);
  docs(c,[pane([B('Composer',{value:s.ncQ||'',on:e=>set({ncQ:e.target.value}),key:e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();start();}},ph:L('輸入第一則訊息開始對話','Type the first message to start'),dis:ro,
    loc:{label:locLabel,icon:icn(nc.loc==='wt'?'git':nc.loc==='local'?'folder':'file',12),aria:L('工作位置 ','Location ')+locLabel,tip:L('工作位置','Location'),on:e=>{if(!ro)c.menu(e,'ncLoc');}},hasLocSub:nc.loc==='wt',locSub:L('新工作樹  orbis/conv-new','New worktree  orbis/conv-new'),locSubIcon:icn('gitPR',12),
    chips,send:start,sendDis:empty||ro,sendBg:empty?'var(--o2a2d33)':'var(--oe3e4e6)',sendColor:empty?C.muted:'var(--o16171a)',icSend:icn('arrowUp',16),sendLabel:L('開始','Start'),sendTip:'Enter'})].concat(nc.sk.length>6?[B('Note',{icon:icn('alert',14),icColor:C.warn,bg:'var(--tint-warn, rgba(217,168,69,.12))',text:L('一次載入太多技能，代理的上下文會變少','Too many skills; the agent has less context to work with')})]:[]))],'minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
M.convend=c=>{const {out,s,set,row,grp,icn,C,ro,flash}=c;const L=base(c,c.lang==='en'?'Wrap up':'收尾');
  const emb=!!c.p.conv;const loc=c.p.conv||s.ceLoc||'wt';
  if(emb){out.hasTitle=false;out.hasHeadRow=false;out.headSegs=[];}else out.headSegs=[c.segOf([['wt',L('工作樹','Worktree')],['local',L('本機資料夾','Local folder')],['tmp',L('暫存資料夾','Scratch folder')]],loc,v=>set({ceLoc:v}))];
  const cid=c.p.convId||loc;const dAll=s.ceDone||{};const done=dAll[cid]||{};const mark=k=>set({ceDone:Object.assign({},dAll,{[cid]:Object.assign({},done,{[k]:1})})});
  const A={wt:[['commit','gitCommit',L('Commit','Commit'),L('3 個檔案  +42 −18','3 files  +42 −18'),()=>c.dlg('commit',{after:()=>mark('commit')})],
      ['pr','gitPR',L('Push 並開合併請求','Push and open pull request'),'orbis/conv-c1 → main',()=>c.dlg('pushPR',{after:()=>mark('pr')})],
      ['merge','gitMerge',L('本機合併','Merge locally'),L('合併到本機 main，工作樹會封存','Into your local main; the worktree is archived'),()=>c.dlg('mergeLocal',{after:()=>mark('merge')})],
      ['discard','trash',L('捨棄','Discard'),L('刪除工作樹與 3 個檔案的修改','Deletes the worktree and changes to 3 files'),()=>c.dlg('discard',{after:()=>mark('discard')})]],
    local:[['commit','gitCommit',L('Commit','Commit'),'C:\\Users\\kash\\scripts  '+L('2 個檔案','2 files'),()=>c.dlg('commit',{after:()=>mark('commit')})],
      ['discard','rotate',L('還原修改','Revert changes'),L('2 個檔案回到對話開始前的內容','2 files go back to how they were before the conversation'),()=>c.dlg('discard',{revert:true,after:()=>mark('discard')})]],
    tmp:[['dl','download',L('下載檔案','Download files'),L('3 個檔案  .zip','3 files  .zip'),()=>flash(L('已下載 conv-c1.zip','Downloaded conv-c1.zip'))],
      ['discard','trash',L('捨棄','Discard'),L('刪除暫存資料夾','Deletes the scratch folder'),()=>c.dlg('discard',{after:()=>mark('discard')})]]}[loc];
  const share=emb?!!c.p.share:!!s.ceShare;const setShare=v=>{if(c.p.onShare)c.p.onShare(v);else set({ceShare:v});};
  const R=(k,icon,title,sub,on)=>{const d=!!done[k];return row({icon:icn(d?'check':icon,14),icColor:d?C.ok:(k==='discard'?C.bad:C.muted),title,fw:550,sub,hasSub:true,cursor:d||ro?'default':'pointer',click:d||ro?()=>{}:on,right:d?L('已完成','Done'):'',rightColor:C.ok,rIcon:d||ro?null:icn('chevR',14),op:d?0.6:1});};
  out.groups=[grp(L('變更','Changes'),A.map(x=>R(x[0],x[1],x[2],x[3],x[4])),{count:''}),
    grp(L('分享','Sharing'),[row({icon:icn(share?'users':'lock',14),title:L('分享對話','Share conversation'),fw:550,sub:share?L('Kash Studio 的成員可以唯讀檢視','Kash Studio members can read it'):L('其他人看不到這段對話','No one else can see it'),hasSub:true,right:share?L('團隊可檢視','Team can view'):L('只有自己','Only you'),cursor:ro?'default':'pointer',click:ro?()=>{}:()=>c.dlg('shareConv',{to:share?'team':'me',after:v=>setShare(v.to==='team')}),rIcon:ro?null:icn('chevR',14)})],{count:''})];
  docs(c,[pane([B('Btns',{just:'flex-start',acts:[btn(c,L('轉成任務','Convert to task'),{icon:icn('file',13),on:()=>c.dlg('convTask')}),btn(c,L('整理成技能','Turn into a skill'),{icon:icn('zap',13),on:()=>c.dlg('skillEdit',{loading:true,title:L('新技能 crlf-normalize','New skill crlf-normalize'),files:{'SKILL.md':'---\nname: crlf-normalize\ndescription: '+L('讀檔時統一換行並保留原始位元組','Normalize line endings on read and keep raw bytes')+'\n---\n\n'+L('1. 用 normalizeEol 包住讀檔\n2. 測試改用固定字串','1. Wrap reads with normalizeEol\n2. Use fixed strings in tests'),'scripts/check-eol.ps1':'git ls-files --eol'}})})]})],{})],'minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
// 29 wiki
M.wiki=c=>{const {out,s,set,ro,icn,C,flash,narrow,av}=c;const L=base(c,'Wiki');
  out.hasTitle=false;out.hasHeadRow=false;out.maxW='100%';out.pad='0';out.groups=[];out.headActs=[];out.bDocs=false;out.isEmpty=false;
  const nm=Object.assign({billing:L('帳務設計','Billing design'),notify:L('通知架構','Notification architecture'),eol:L('2026-10 換行處理','2026-10 Line endings'),draft:L('我的草稿','My drafts'),design:L('設計','Design'),dec:L('決策紀錄','Decisions'),orb:L('專案 ORB','Project ORB'),runbook:L('執行器手冊','Runner handbook')},s.wnames||{});
  const del=s.wdel||{};const extra=(s.wextra||[]).filter(x=>!del[x.id]);
  const pg=del[s.wp||'billing']?'notify':(s.wp||'billing');
  const fo=Object.assign({design:true,dec:false,orb:false},s.wf||{});
  const sec=Object.assign({fav:true,space:true,priv:true,views:false},s.wsec||{});
  const parentOf={billing:'design',notify:'design',eol:'dec',draft:'priv',runbook:'orb'};extra.forEach(x=>parentOf[x.id]=x.parent);
  const isFolder=k=>['design','dec','orb'].indexOf(k)>=0||extra.some(x=>x.id===k&&x.kind==='folder');
  const siblings=(parent,skip)=>Object.keys(parentOf).filter(k=>parentOf[k]===parent&&k!==skip&&!del[k]).map(k=>nm[k]||'');
  const ren=s.wren,neu=s.wnew;const favs=s.wfavs||{billing:1,eol:1};
  const focusEdit=()=>setTimeout(()=>{const el=document.querySelector('input[data-tree-edit]');if(el){el.focus();el.select();}},40);
  const edit=(val,onVal,commit,cancel,ph,err)=>({isEdit:true,notEdit:false,editVal:val,onEdit:e=>onVal(e.target.value),onEditKey:e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){e.preventDefault();cancel();}},onEditBlur:()=>{if((val||'').trim()&&!err)commit();else cancel();},editPh:ph,editBd:err?C.bad:'var(--o34373d)',hasErr:!!err,err:err||''});
  const base0={isEdit:false,notEdit:true,editVal:'',onEdit:()=>{},onEditKey:()=>{},onEditBlur:()=>{},editPh:'',editBd:'var(--o26292e)',hasErr:false,err:'',hasMore:false,more:()=>{},moreLabel:L('更多動作','More actions'),fw:400,tail:null};
  const tr=(key,label,depth,icon,o)=>{let r=Object.assign({},base0,{label,ind:(8+depth*16)+'px',icon:icn(icon,15),icColor:'var(--o8b9098)',chev:null,rot:'none',color:'var(--oe8e9eb)',bg:pg===key?'var(--osel)':'transparent',fw:pg===key?550:400,drag:!ro,on:()=>{if(nm[key]&&!isFolder(key))set({wp:key,wac:false});},hasMore:!ro,more:e=>{e.stopPropagation();c.menu(e,'wrow-'+key);}},o||{});
    if(ren===key){const v=s.wrv!==undefined?s.wrv:label;const dup=v.trim()&&siblings(parentOf[key],key).indexOf(v.trim())>=0;r=Object.assign(r,edit(v,x=>set({wrv:x}),()=>{if(dup||!v.trim())return;set({wnames:Object.assign({},s.wnames||{},{[key]:v.trim()}),wren:null,wrv:undefined});flash(L('已重新命名','Renamed'));},()=>set({wren:null,wrv:undefined}),label,dup?L('這個資料夾已有同名的項目','Something with this name is already here'):''),{hasMore:false});}
    return r;};
  const fold=(k,label,depth,o)=>tr(k,label,depth,fo[k]?'folderOpen':'folder',Object.assign({chev:icn('chevR',12),rot:fo[k]?'rotate(90deg)':'none',bg:'transparent',on:()=>set({wf:Object.assign({},fo,{[k]:!fo[k]})})},o||{}));
  const newRow=(parent,depth)=>{if(!neu||neu.parent!==parent)return [];const v=s.wnv||'';const dup=v.trim()&&siblings(parent).indexOf(v.trim())>=0;const id='n'+Date.now();
    return [Object.assign(tr('new','',depth,neu.kind==='folder'?'folder':'file',{bg:'transparent',hasMore:false}),edit(v,x=>set({wnv:x}),()=>{if(dup||!v.trim())return;set({wextra:(s.wextra||[]).concat([{id,kind:neu.kind,name:v.trim(),parent}]),wnames:Object.assign({},s.wnames||{},{[id]:v.trim()}),wnew:null,wnv:'',wp:neu.kind==='page'?id:pg,wf:Object.assign({},fo,{[parent]:true})});flash(neu.kind==='page'?L('已建立頁面','Page created'):L('已建立資料夾','Folder created'));},()=>set({wnew:null,wnv:''}),neu.kind==='folder'?L('資料夾名稱','Folder name'):L('頁面名稱','Page name'),dup?L('這個資料夾已有同名的項目','Something with this name is already here'):''))];};
  const kids=(parent,depth)=>extra.filter(x=>x.parent===parent).map(x=>x.kind==='folder'?fold(x.id,nm[x.id],depth):tr(x.id,nm[x.id],depth,'file'));
  const page=(k,d,o)=>del[k]?[]:[tr(k,nm[k],d,'file',o)];
  const startNew=(kind,parent)=>{set({wnew:{kind,parent},wnv:'',wf:Object.assign({},fo,{[parent]:true}),wsec:Object.assign({},sec,{[parent==='priv'?'priv':'space']:true}),wren:null});focusEdit();};
  c.menus.wadd=[{label:L('新頁面','New page'),icon:'file',sub:L('在「設計」中','In Design'),on:()=>startNew('page','design')},{label:L('新資料夾','New folder'),icon:'folder',on:()=>startNew('folder','root')}];
  const rowMenu=k=>{const f=isFolder(k);const bl=k==='billing'?undefined:[];const fav=!!favs[k];
    c.menus['wrow-'+k]=f?[{label:L('新頁面','New page'),icon:'file',on:()=>startNew('page',k)},{label:L('新資料夾','New folder'),icon:'folder',on:()=>startNew('folder',k)},{label:L('重新命名','Rename'),icon:'pencil',on:()=>{set({wren:k,wrv:nm[k],wnew:null});focusEdit();}},{sep:true},{label:L('刪除…','Delete…'),icon:'trash',danger:true,on:()=>c.dlg('wikiDelete',{name:nm[k],backlinks:[],after:()=>set({wdel:Object.assign({},del,{[k]:1})})})}]
      :[{label:fav?L('從收藏移除','Remove from favorites'):L('加入收藏','Add to favorites'),icon:'star',on:()=>set({wfavs:Object.assign({},favs,{[k]:fav?0:1})})},{label:L('重新命名','Rename'),icon:'pencil',on:()=>{set({wren:k,wrv:nm[k],wnew:null});focusEdit();}},{label:L('移動…','Move…'),icon:'folder',on:()=>c.dlg('wikiMove',{name:nm[k],from:parentOf[k]})},{sep:true},{label:L('刪除…','Delete…'),icon:'trash',danger:true,on:()=>c.dlg('wikiDelete',{name:nm[k],backlinks:bl,after:()=>set({wdel:Object.assign({},del,{[k]:1})})})}];};
  Object.keys(nm).concat(extra.map(x=>x.id)).forEach(rowMenu);
  const views=s.wviews||[];
  const favRows=Object.keys(favs).filter(k=>favs[k]&&nm[k]&&!del[k]&&!isFolder(k)).map(k=>tr(k,nm[k],0,'file'));
  const spaceRows=[fold('design',nm.design,0)].concat(fo.design?newRow('design',1).concat(page('billing',1),page('notify',1),kids('design',1)):[])
    .concat([fold('dec',nm.dec,0)]).concat(fo.dec?newRow('dec',1).concat(page('eol',1),kids('dec',1)):[])
    .concat([fold('orb',nm.orb,0)]).concat(fo.orb?newRow('orb',1).concat(page('runbook',1),kids('orb',1)):[])
    .concat(newRow('root',0)).concat(extra.filter(x=>x.parent==='root').map(x=>x.kind==='folder'?fold(x.id,nm[x.id],0):tr(x.id,nm[x.id],0,'file')));
  const privRows=newRow('priv',0).concat(page('draft',0,{tail:icn('lock',12)}),kids('priv',0));
  const viewRows=[tr('v-review',L('審閱中的設計','Designs in review'),0,'layers',{bg:'transparent',hasMore:false,on:()=>flash(L('已開啟檢視','View opened'))})].concat(views.map((v,i)=>tr('v'+i,v,0,'layers',{bg:'transparent',hasMore:false,on:()=>flash(L('已開啟檢視','View opened'))})));
  const SEC=(k,title,rows,o)=>Object.assign({title,rows,open:!!sec[k],openStr:String(!!sec[k]),rot:sec[k]?'0deg':'-90deg',toggle:()=>set({wsec:Object.assign({},sec,{[k]:!sec[k]})}),hasAdd:false,add:()=>{},addLabel:'',addPopup:'false',empty:!rows.length,emptyText:L('沒有項目','Nothing here')},o||{});
  const nav=[{label:L('新頁面','New page'),icon:icn('filePlus',16),on:()=>startNew('page','design'),dis:ro,op:ro?0.45:1,bg:'transparent'}];
  // ---- page ----
  const T2={billing:nm.billing,notify:nm.notify,eol:nm.eol,draft:nm.draft};
  const title=nm[pg]||'';const props=s.wprops||[];const wfmt=s.wfmt||{};const cm=s.wcm||[];const ac=!!s.wac;const um=s.wum||{};
  const crumbFolder=parentOf[pg];
  const crumbs=[{label:crumbFolder==='priv'?L('私人','Private'):L('團隊空間','Team space'),icon:icn(crumbFolder==='priv'?'lock':'users',14),on:()=>set({wsec:Object.assign({},sec,{[crumbFolder==='priv'?'priv':'space']:true})})},{label:crumbFolder==='priv'?'':(nm[crumbFolder]||''),icon:icn('folder',14),on:()=>set({wf:Object.assign({},fo,{[crumbFolder]:true})})},{label:title,icon:icn('file',14),on:()=>{},cur:'page'}].filter(x=>x.label).map((x,i)=>Object.assign({sep:i>0,cur:'false',color:x.cur==='page'?C.text:C.muted,flex:x.cur==='page'?'0 1 auto':'none'},x));
  const fav=!!favs[pg];
  c.menus.wpage=[{label:L('版本紀錄','Version history'),icon:'clock',on:()=>{if(c.p.onWiki)c.p.onWiki('wikiver');}},{label:'Graph',icon:'layers',on:()=>{if(c.p.onWiki)c.p.onWiki('wikigraph');}},{sep:true},
    {label:L('新增屬性…','Add property…'),icon:'plus',on:()=>c.dlg('wikiProp',{after:v=>set({wprops:props.concat([v])})})},{label:L('新增頁面檢視…','New page view…'),icon:'layers',on:()=>c.dlg('wikiView',{after:v=>set({wviews:views.concat([v.name]),wsec:Object.assign({},sec,{views:true})})})},{label:L('提交成儲存庫規格…','Submit as repo spec…'),icon:'git',on:()=>c.dlg('wikiSpec')},{label:L('匯出 Markdown…','Export Markdown…'),icon:'download',on:()=>c.dlg('wikiExport')},{sep:true},
    {label:L('移動…','Move…'),icon:'folder',on:()=>c.dlg('wikiMove',{name:title,from:crumbFolder})},{label:L('刪除…','Delete…'),icon:'trash',danger:true,on:()=>c.dlg('wikiDelete',{name:title,backlinks:pg==='billing'?undefined:[],after:()=>set({wdel:Object.assign({},del,{[pg]:1})})})}];
  const TA=(k,label,icon,o)=>Object.assign({btn:true,sep:false,label:label||'',icon:icon?icn(icon,15):null,aria:o&&o.aria||label,pressed:String(!!wfmt[k]),bg:wfmt[k]?'var(--o22242a)':'transparent',color:wfmt[k]?C.text:C.muted,hasChev:false,dis:ro,op:ro?0.45:1,on:()=>set({wfmt:Object.assign({},wfmt,{[k]:!wfmt[k]})})},o||{});
  const SP={btn:false,sep:true};
  const STY=[['p',L('內文','Text')],['h1',L('標題 1','Heading 1')],['h2',L('標題 2','Heading 2')],['h3',L('標題 3','Heading 3')]];const sty=s.wsty||'p';
  c.menus.wsty=STY.map(([k,l])=>({label:l,sel:sty===k,on:()=>set({wsty:k})}));
  const tools=[TA('sty',(STY.find(x=>x[0]===sty)||[])[1],null,{aria:L('文字樣式','Text style'),hasChev:true,pressed:'false',bg:'transparent',color:C.text,on:e=>c.menu(e,'wsty')}),SP,TA('b','', 'bold',{aria:L('粗體','Bold')}),TA('i','','italic',{aria:L('斜體','Italic')}),TA('u','','underline',{aria:L('底線','Underline')}),TA('s','','strike',{aria:L('刪除線','Strikethrough')}),SP,
    TA('ul','','listUl',{aria:L('項目清單','Bulleted list')}),TA('ol','','listOl',{aria:L('編號清單','Numbered list')}),TA('todo','','checkSq',{aria:L('待辦清單','To-do list')}),SP,TA('q','','quote',{aria:L('引言','Quote')}),TA('code','','code',{aria:L('程式碼','Code')}),SP,
    TA('link','','link',{aria:L('連結頁面或任務','Link a page or task'),on:()=>set({wac:!ac})}),TA('table','','table',{aria:L('表格','Table'),on:()=>flash(L('已插入表格','Table inserted'))}),TA('img','','image',{aria:L('圖片','Image'),on:()=>flash(L('已插入圖片','Image inserted'))})];
  const TN={text:L('文字','Text'),number:L('數字','Number'),date:L('日期','Date'),member:L('成員','Member'),tags:L('標籤','Tags'),bool:L('是否','Yes or no'),link:L('連結','Link')};
  const V=(label,o)=>Object.assign({label,icon:null,on:()=>{},dis:false,bg:'transparent',color:C.text,fs:'14px',font:'inherit',pad:'0',cursor:'default'},o||{});
  const chipV=(label,o)=>V(label,Object.assign({bg:'var(--o1c1e22)',pad:'0 8px',fs:'13px'},o||{}));
  const propRows=[{k:L('狀態','Status'),vals:[chipV(L('審閱中','In review'),{color:C.warn,icon:c.dot(C.warn,6)})]},{k:L('負責人','Owner'),vals:[V('mei-lin',{icon:av('mei-lin',18)})]},{k:L('標籤','Tags'),vals:[chipV('#billing'),chipV('#design')]},{k:L('相關任務','Related tasks'),vals:['ORB-38','ORB-62'].map(k=>chipV(k,{font:MONO,fs:'12px',color:'var(--o9cc3ff)',bg:'var(--tint-accent-12, rgba(127,176,250,.12))',cursor:'pointer',on:()=>flash(L('開啟 ','Open ')+k)}))}].concat(props.map(x=>({k:x.name,vals:[V(L('未設定','Not set')+'  '+TN[x.type],{color:C.muted})]}))).map((r,i)=>Object.assign(r,{bt:i?'1px solid var(--o1e2024)':'0'}));
  const G=(text,o)=>Object.assign({text,color:'inherit',bg:'transparent',pad:'0',font:'inherit',fs:'inherit',cursor:'auto',deco:'none',on:null,hasCur:false,curColor:'',curName:''},o||{});
  const WL=(text,on)=>G(text,{color:'var(--o9cc3ff)',cursor:'pointer',deco:'underline',on});
  const TK=k=>G(k,{color:'var(--o9cc3ff)',bg:'var(--tint-accent-12, rgba(127,176,250,.12))',pad:'1px 5px',font:MONO,fs:'13px',cursor:'pointer',on:()=>flash(L('開啟 ','Open ')+k)});
  const blank={isH:false,isP:false,isCheck:false,isCallout:false,isCode:false,isEmbed:false,isAc:false};
  const BK=(type,o)=>Object.assign({},blank,{['is'+type]:true},o);
  const chk=s.wchk||{c1:false,c2:true};
  const blocks=pg!=='billing'?[BK('P',{segs:[G(L('這一頁還沒有內容。','This page has no content yet.'),{color:C.muted})]})]:[
    BK('P',{segs:[G(L('這份規格說明發票按比例計算與退款流程。計算規則見 ','This spec covers prorated invoices and the refund flow. Calculation rules are in ')),WL('[['+L('發票計算','Invoice math')+']]',()=>flash(L('開啟 發票計算','Open Invoice math'))),G(L('，退款流程追蹤於 ','; the refund flow is tracked in ')),TK('ORB-62'),G(L('。','.'))]}),
    BK('P',{segs:[G(L('帳期切換時，未完成的發票','When a billing period switches, unfinished invoices '),{hasCur:true,curColor:'var(--o4fb86a)',curName:'chen-yu'}),G(L('沿用上一期的稅率，並在發票上註明適用期間。','keep the previous rate, and the invoice states which period applies.'))]}),
    BK('H',{text:L('成功指標','Success metrics'),hasCur:true,curColor:'#b39ddb',curName:'mei-lin'}),
    BK('Check',{text:L('退款在 1 個工作天內完成','Refunds complete within 1 business day'),checked:!!chk.c1,color:chk.c1?C.muted:C.text,deco:chk.c1?'line-through':'none',on:()=>set({wchk:Object.assign({},chk,{c1:!chk.c1})})}),
    BK('Check',{text:L('按比例計算的誤差小於 1 元','Prorating error stays under $0.01'),checked:!!chk.c2,color:chk.c2?C.muted:C.text,deco:chk.c2?'line-through':'none',on:()=>set({wchk:Object.assign({},chk,{c2:!chk.c2})})}),
    BK('H',{text:L('架構','Architecture'),hasCur:false,curColor:'',curName:''}),
    BK('Callout',{icon:icn('globe',16),icColor:C.acc,bg:'var(--o1a1b1f)',text:L('所有帳務 API 都經過閘道，客戶資料不會離開內部網路。','All billing APIs go through the gateway. Customer data never leaves the internal network.'),hasAct:false,act:()=>{},actLabel:''}),
    BK('Code',{text:L('帳務事件\n  → 閘道（驗證、限流）\n    → 計費服務（按比例計算）\n      → 發票產生器（PDF）','Billing event\n  → Gateway (auth, rate limiting)\n    → Billing service (prorating)\n      → Invoice generator (PDF)')}),
    BK('H',{text:L('相關頁面','Related pages'),hasCur:false,curColor:'',curName:''}),
    BK('Embed',{icon:icn('book',16),title:nm.notify,sub:L('推送與輪詢的取捨；通知事件類型共 7 種','Push vs polling trade-offs; 7 notification event types'),on:()=>set({wp:'notify'}),dis:false,cursor:'pointer'}),
    BK('Embed',{icon:icn('file',16),title:L('舊版部署流程','Old deploy process'),sub:L('嵌入的頁面已經刪除','The embedded page was deleted'),on:()=>{},dis:true,cursor:'default'}),
    BK('P',{segs:[G(L('另見 ','See also ')),G('[['+L('通','No'),{color:'var(--o9cc3ff)',font:MONO,fs:'13px',bg:'var(--o1c1e22)',pad:'1px 5px',cursor:'pointer',on:()=>set({wac:!ac})})]})]
    .concat(ac?[BK('Ac',{items:[[icn('file',14),nm.notify,L('頁面','Page')],[icn('file',14),'ORB-47  '+c.title('ORB-47'),L('任務','Task')],[icn('zap',14),'notify-format',L('技能','Skill')]].map(([ic,label,kind])=>({icon:ic,label,kind,on:()=>{set({wac:false});flash(L('已插入連結','Link inserted'));}}))})]:[])
    .concat([BK('Callout',{icon:icn('bot',16),icColor:C.acc,bg:'var(--tint-accent-08, rgba(127,176,250,.08))',text:L('claude-code 提出 2 項修改','claude-code proposed 2 changes'),hasAct:true,act:()=>{if(c.p.onWiki)c.p.onWiki('wikiprop');},actLabel:L('檢視','Review')})]);
  const backs=[[nm.notify,'notify'],['ORB-38',null],[nm.eol,'eol']].map(([label,k])=>({label,icon:icn('file',14),on:()=>{if(k)set({wp:k});else flash(L('開啟 ','Open ')+label);}}));
  const comments=[['chen-yu',L('稅率表要不要連到 ORB-63？','Should the tax table link to ORB-63?'),L('1 小時前','1 hr ago')],['mei-lin',L('好，我補上','Sure, adding it'),L('40 分鐘前','40 min ago')]].concat(cm.map(x=>['kashionz',x,L('剛剛','Just now')]));
  const AVB={kashionz:'var(--o3a3e46)','mei-lin':'var(--o4a3e52)','chen-yu':'var(--o3b4d45)'};
  const empty=!!c.isEmptyState;
  out.bWiki=!out.isLoading&&!out.isError;
  out.wk={showSide:!narrow,nav,
    sections:[SEC('fav',L('收藏','Favorites'),favRows),SEC('space',L('團隊空間','Team space'),empty?[]:spaceRows,{hasAdd:!ro,add:e=>c.menu(e,'wadd'),addLabel:L('新增','New'),addPopup:'menu'}),SEC('views',L('頁面檢視','Page views'),viewRows,{hasAdd:!ro,add:()=>c.dlg('wikiView',{after:v=>set({wviews:views.concat([v.name]),wsec:Object.assign({},sec,{views:true})})}),addLabel:L('新增頁面檢視','New page view')})],
    crumbs,crumbLabel:L('頁面位置','Page location'),faces:['mei-lin','chen-yu'].map((m,i)=>({name:m,init:m[0].toUpperCase(),bg:AVB[m],ml:i?'-6px':'0',ring:m==='mei-lin'?'#b39ddb':'var(--o4fb86a)'})),
    top:[{label:String(comments.length),icon:icn('msg',15),aria:L('留言','Comments'),pressed:String(!!s.wcmt),popup:'false',bg:s.wcmt?'var(--o22242a)':'transparent',color:s.wcmt?C.text:C.muted,on:()=>set({wcmt:!s.wcmt})},{label:'',icon:icn('star',15),aria:fav?L('從收藏移除','Remove from favorites'):L('加入收藏','Add to favorites'),pressed:String(fav),popup:'false',bg:'transparent',color:fav?C.warn:C.muted,on:()=>set({wfavs:Object.assign({},favs,{[pg]:fav?0:1})})},{label:'',icon:icn('more',15),aria:L('更多動作','More actions'),pressed:'false',popup:'menu',bg:'transparent',color:C.muted,on:e=>c.menu(e,'wpage')}],
    tools,toolLabel:L('格式','Formatting'),artPad:narrow?'24px 16px 64px':'48px 40px 96px',
    empty,emptyText:L('這個空間還沒有頁面','This space has no pages yet'),newPage:()=>{set({st:'normal'});startNew('page','design');},newPageLabel:L('新頁面','New page'),hasPage:!empty,
    pageIcon:icn('book',22),iconBg:'var(--tint-accent-12, rgba(127,176,250,.12))',iconColor:C.acc,title,meta:L('mei-lin 編輯於 10 分鐘前','Edited by mei-lin 10 min ago'),
    backCount:L(backs.length+' 個反向連結',backs.length+' backlinks'),jumpBack:()=>{const el=document.getElementById('wk-backlinks');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});},
    propLabel:L('屬性','Properties'),props:propRows,canAddProp:!ro,addProp:()=>c.dlg('wikiProp',{after:v=>set({wprops:props.concat([v])})}),addPropLabel:L('新增屬性','Add property'),
    blocks,backTitle:L('反向連結','Backlinks')+'  '+backs.length,backs,umTitle:L('未連結的提及','Unlinked mentions')+'  2',
    ums:[['m1',L('帳期報表','Billing period report')],['m2',L('退款 FAQ','Refund FAQ')]].map(([k,l])=>({label:l,linked:!!um[k],canLink:!um[k],linkedLabel:L('已連結','Linked'),act:L('連結','Link'),dis:ro,op:ro?0.45:1,on:()=>set({wum:Object.assign({},um,{[k]:1})})})),
    cmOpen:!!s.wcmt&&!narrow,cmTitle:L('留言','Comments'),cmClose:()=>set({wcmt:false}),comments:comments.map(([who,text,at])=>({who,text,at,init:who[0].toUpperCase(),bg:AVB[who]})),
    cq:s.wcq||'',onCq:e=>set({wcq:e.target.value}),cqPh:L('留言','Comment'),cqSend:()=>{if((s.wcq||'').trim())set({wcm:cm.concat([s.wcq.trim()]),wcq:''});},cqDis:ro||!(s.wcq||'').trim(),cqOp:(ro||!(s.wcq||'').trim())?0.45:1,cqLabel:L('送出','Send')};
};
M.wikigraph=c=>{const {out,s,set,C}=c;const L=base(c,c.lang==='en'?'Graph view':'Graph view');
  const sc=s.gs||'all',lc=s.gl||'global';out.headSegs=[c.segOf([['global',L('整個空間','Whole space')],['local',L('這一頁','This page')]],lc,v=>set({gl:v})),c.segOf([['all',L('全部','All')],['design',L('設計','Design')],['dec',L('決策','Decisions')]],sc,v=>set({gs:v}))];
  const N=[['billing',200,130,L('帳務設計','Billing design'),'design',9],['notify',110,70,L('通知架構','Notifications'),'design',7],['eol',300,70,L('換行處理','Line endings'),'dec',6],['inv',270,200,L('發票計算','Invoice math'),'design',6],['refund',120,200,L('退款 FAQ','Refund FAQ'),'dec',5],['runner',330,150,L('執行器','Runners'),'design',5],['orb38',60,130,'ORB-38','task',4]];
  const Ed=[['billing','notify'],['billing','eol'],['billing','inv'],['billing','refund'],['inv','runner'],['notify','orb38'],['refund','orb38'],['eol','runner']];
  const vis=n=>(sc==='all'||n[4]===sc||n[4]==='task')&&(lc==='global'||n[0]==='billing'||Ed.some(e=>(e[0]==='billing'&&e[1]===n[0])||(e[1]==='billing'&&e[0]===n[0])));
  const byId=k=>N.find(n=>n[0]===k);
  docs(c,[pane([B('Graph',{text:'Graph',nodes:N.map(n=>({x:n[1],y:n[2],r:n[5],ty:n[2]+n[5]+12,label:n[3],c:n[0]==='billing'?C.acc:(n[4]==='task'?C.warn:'var(--o8b9098)'),op:vis(n)?1:0.15,on:()=>{}})),edges:Ed.map(([a,b])=>{const A=byId(a),Bn=byId(b);return {x1:A[1],y1:A[2],x2:Bn[1],y2:Bn[2],c:vis(A)&&vis(Bn)?'var(--o3d4047)':'var(--o1e2024)'};})})])],'minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
M.wikiver=c=>{const {out,s,set,ro,icn,C,flash}=c;const L=base(c,c.lang==='en'?'Billing design history':'帳務設計 版本紀錄');
  const sel=s.wvs||['v12','v10'];const V=[['v12','mei-lin',L('10 分鐘前','10 min ago')],['v11','claude-code',L('2 小時前','2 hr ago')],['v10','kashionz',L('昨天','Yesterday')],['v9','mei-lin','10/20']];
  const pick=k=>{let n=sel.slice();if(n.indexOf(k)>=0)return;n=[n[1],k];set({wvs:n});};
  const order=a=>V.findIndex(v=>v[0]===a);const nw=order(sel[0])<order(sel[1])?sel[0]:sel[1],old=nw===sel[0]?sel[1]:sel[0];
  docs(c,[pane([B('H',{text:L('版本','Versions'),meta:L('選兩個比較','Pick two to compare')}),B('Rows',{rows:V.map(v=>rr(icn(sel.indexOf(v[0])>=0?'check':'clock',13),v[0]+'  '+v[1],v[2],{icColor:sel.indexOf(v[0])>=0?C.acc:C.muted,hasAct:true,act:sel.indexOf(v[0])>=0?L('已選','Selected'):L('比較','Compare'),dis:sel.indexOf(v[0])>=0,op:sel.indexOf(v[0])>=0?0.6:1,on:()=>pick(v[0])}))})]),
    pane([B('H',{text:old+' → '+nw,acts:[btn(c,L('還原到 ','Restore ')+old,{on:()=>c.dlg('wikiRestore',{v:old,after:()=>set({wvs:['v12',old]})})})]}),B('Code',{lines:[[' ## '+L('帳期切換','Billing period switch'),''],['- '+L('未完成的發票改用新稅率','Unfinished invoices use the new rate'),'-'],['+ '+L('未完成的發票沿用上一期的稅率','Unfinished invoices keep the previous rate'),'+'],['  '+L('退款流程見 ORB-62','Refund flow: ORB-62'),''],['+ ![['+L('通知架構','Notification architecture')+']]','+']].map(([text,k])=>({text,color:k==='+'?C.ok:k==='-'?C.bad:C.text,bg:k==='+'?'var(--tint-success, rgba(79,184,106,.1))':k==='-'?'var(--tint-danger, rgba(239,107,98,.1))':'transparent'}))})])],'260px minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
M.wikiprop=c=>{const {out,s,set,ro,icn,C,flash}=c;const L=base(c,c.lang==='en'?'Proposed changes':'代理提出的修改');
  const r=s.wpr||{};const P=[['p1',L('帳務設計','Billing design'),'run_8f2a',[['+ '+L('帳期切換時，未完成的發票沿用上一期稅率','On a billing period switch, unfinished invoices keep the previous rate'),'+']]],['p2',L('通知架構','Notification architecture'),'run_7c19',[['- '+L('每 30 秒輪詢','Poll every 30 seconds'),'-'],['+ '+L('改用 WebSocket 推送','Use WebSocket push'),'+']]]];
  const left=P.filter(x=>!r[x[0]]).length;out.headMeta=left?L(left+' 頁待處理',left+' pages to review'):'';
  out.headActs=left>1?[btn(c,L('全部接受','Accept all'),{on:()=>{const n=Object.assign({},r);P.forEach(x=>{if(!n[x[0]])n[x[0]]='yes';});set({wpr:n});flash(L('已套用 '+left+' 頁','Applied '+left+' pages'));}})]:[];
  docs(c,[pane([].concat(...P.map(([k,t2,run,lines])=>[B('H',{text:t2,meta:'claude-code  '+run,mt:'8px',acts:r[k]?[]:[btn(c,L('拒絕','Decline'),{bg:'transparent',color:C.bad,on:()=>c.dlg('propDecline',{page:t2,run,after:()=>set({wpr:Object.assign({},r,{[k]:'no'})})})}),btn(c,L('接受','Accept'),pri({on:()=>{set({wpr:Object.assign({},r,{[k]:'yes'})});flash(L('已套用','Applied'));}}))]}),
    r[k]?B('Note',{icon:icn(r[k]==='yes'?'check':'x',14),icColor:r[k]==='yes'?C.ok:C.muted,bg:'var(--o1a1b1f)',text:r[k]==='yes'?L('已接受','Accepted'):L('已拒絕','Declined'),acts:[btn(c,L('復原','Undo'),{on:()=>{const n=Object.assign({},r);delete n[k];set({wpr:n});}})]}):B('Code',{lines:lines.map(([text,kk])=>({text,color:kk==='+'?C.ok:C.bad,bg:kk==='+'?'var(--tint-success, rgba(79,184,106,.1))':'var(--tint-danger, rgba(239,107,98,.1))'}))})])))],'minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
M.mentions=c=>{const {out,row,grp,icn}=c;const L=base(c,c.lang==='en'?'Mentions in wiki':'Wiki 中的提及');
  out.groups=[grp('',[row({icon:icn('book',14),title:L('帳務設計','Billing design'),sub:L('…退款流程追蹤於 ORB-42 的後續…','…refund flow follows up on ORB-42…'),hasSub:true,right:L('10 分鐘前','10 min ago')}),row({icon:icn('book',14),title:L('2026-10 換行處理','2026-10 Line endings'),sub:L('決策：讀檔時正規化（ORB-42）','Decision: normalize on read (ORB-42)'),hasSub:true,right:L('昨天','Yesterday')})])];
  emptyAs(c,L('沒有頁面提到這個任務','No pages mention this task'));
};
// 30 skills
const SKILLS=L=>[{k:'windows-path-fix',desc:L('修正 Windows 長路徑與換行造成的測試失敗','Fix test failures caused by Windows long paths and line endings'),team:true,on:true},
  {k:'pr-description',desc:L('依合併請求範本整理變更說明','Write the pull request description from the template'),team:true,on:true},
  {k:'eol-check',desc:L('檢查換行設定與 .gitattributes','Check line-ending settings and .gitattributes'),team:true,on:true},
  {k:'docker-debug',desc:L('診斷容器建置與網路問題','Diagnose container build and network issues'),team:true,on:false},
  {k:'test-first',desc:L('先寫會失敗的測試，再修正程式','Write a failing test first, then fix the code'),team:true,on:true},
  {k:'my-refactor',desc:L('重構前後要檢查的事項','Checks to run before and after a refactor'),team:false,on:false}];
M.skills=c=>{const {out,s,set,ro,icn,C,p}=c;const L=base(c,c.lang==='en'?'Skills':'技能');
  const sc=s.ks||'all';const q=(s.kq||'').trim().toLowerCase();const en=s.ken||{};
  const all=SKILLS(L).concat((s.knew||[]).map(k=>({k,desc:L('新技能','New skill'),team:false,on:false})));
  const pend=all.filter(x=>x.pending).length;
  out.headSegs=[c.segOf([['all',L('全部','All')],['mine',L('我的','Mine')]],sc,v=>set({ks:v}))];
  const list=all.filter(x=>(sc==='all'||!x.team)&&(!q||x.k.indexOf(q)>=0||x.desc.toLowerCase().indexOf(q)>=0));
  const isOn=x=>en[x.k]!==undefined?en[x.k]:x.on;
  const create=()=>c.dlg('skillNew',{next:v=>{const nm=v.src==='blank'?v.name:'windows-path-fix-2';c.dlg('skillEdit',{title:L('新技能 ','New skill ')+nm,files:{'SKILL.md':'---\nname: '+nm+'\ndescription: \n---\n'},after:()=>set({knew:(s.knew||[]).concat([nm]),ks:'mine'})});}});
  out.headActs=[btn(c,L('新增技能','New skill'),pri({icon:icn('plus',14),on:create}))];out.emptyOn=create;
  out.groups=[];
  docs(c,[pane([B('Search',{value:s.kq||'',on:e=>set({kq:e.target.value}),ph:L('搜尋技能','Search skills')}),
    B('Items',{none:!list.length,noneText:q?L('沒有符合的技能','No matching skills'):L('還沒有技能','No skills yet'),items:list.map((x,i)=>{const on=isOn(x);return {bt:i?'1px solid var(--o1e2024)':'0',bg:'transparent',icon:icn('zap',16),title:x.k,desc:x.desc,hasBadge:false,badge:'',badgeColor:C.warn,on:()=>{if(p.onSkill)p.onSkill('skill');},
      hasSw:true,swOn:String(on),swLabel:L('預設啟用 ','Enabled by default: ')+x.k,swDis:ro,swOp:ro?0.45:1,swBg:on?C.acc:'var(--o3d4047)',swKnob:on?'14px':'2px',sw:()=>set({ken:Object.assign({},en,{[x.k]:!on})})};})})])],'minmax(0,1fr)');out.maxW='800px';
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
  if(c.isEmptyState){out.bDocs=false;out.isEmpty=true;emptyAs(c,L('還沒有技能','No skills yet'),L('新增技能','New skill'));}
};
M.skill=c=>{const {out,s,set,ro,icn,C,flash,p}=c;const L=base(c,'windows-path-fix');
  const on=s.k1on!==undefined?s.k1on:true;const orb=s.korb||'v3';const added=s.kadd||[];const f=s.kf||null;
  out.headMeta='v4';
  c.menus.kmore=[{label:L('編輯','Edit'),icon:'pencil',on:()=>c.dlg('skillEdit')},{label:L('上傳新版本','Upload new version'),icon:'upload',on:()=>c.dlg('skillVersion')},{label:L('加入專案…','Add to project…'),icon:'plus',on:()=>c.dlg('skillAdd',{})},{label:L('提交到儲存庫…','Submit to repo…'),icon:'git',on:()=>c.dlg('skillSubmit')}];
  out.headActs=[btn(c,on?L('已啟用','Enabled'):L('啟用','Enable'),{icon:on?icn('check',13):null,bg:on?'var(--tint-accent-12, rgba(127,176,250,.12))':'var(--o22242a)',color:on?'var(--o9cc3ff)':C.text,on:()=>{set({k1on:!on});flash(on?L('已停用','Disabled'):L('已啟用','Enabled'));}}),btn(c,'',{icon:icn('more',14),tip:L('更多動作','More actions'),dis:ro,on:e=>c.menu(e,'kmore')})];
  const FILES={'SKILL.md':['---','name: windows-path-fix','description: '+L('修正 Windows 長路徑與換行造成的測試失敗','Fix test failures caused by Windows long paths and line endings'),'---','',L('## 使用時機','## When to use'),L('測試只在 Windows 失敗，錯誤是路徑過長或換行不同。','Tests fail only on Windows with path-too-long or line-ending errors.'),'',L('## 步驟','## Steps'),L('1. 執行 scripts/check.ps1 找出超過 260 字元的路徑','1. Run scripts/check.ps1 to find paths over 260 characters'),L('2. 路徑一律用 path.win32 組合','2. Build paths with path.win32'),L('3. 讀檔時統一換行再比較','3. Normalize line endings before comparing')],'scripts/check.ps1':['Get-ChildItem -Recurse | Where-Object { $_.FullName.Length -gt 260 }'],'references/paths.md':['# Long paths','https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation']};
  const fileRows=Object.keys(FILES).map(k=>rr(icn('file',14),k,k==='scripts/check.ps1'?L('含腳本','Script'):'',{font:MONO,metaColor:C.warn,hasAct:true,act:f===k?L('收起','Hide'):L('檢視','View'),on:()=>set({kf:f===k?null:k})}));
  docs(c,[pane([B('Btns',{just:'flex-start',acts:[btn(c,L('所有技能','All skills'),{icon:icn('chevL',13),bg:'transparent',color:C.muted,dis:false,op:1,tip:'',on:()=>{if(p.onSkill)p.onSkill('skills');}})]}),
    B('P',{segs:[g(L('修正 Windows 長路徑與換行造成的測試失敗。','Fixes test failures caused by Windows long paths and line endings.'))],fs:'15px'}),
    B('P',{segs:[g(L('mei-lin 建立  v4  10/25 更新  用在 3 個專案','Created by mei-lin  v4  Updated Oct 25  Used in 3 projects'))],color:'var(--o8b9098)',fs:'13px'}),
    
    B('H',{text:L('說明','Instructions'),mt:'8px'}),
    B('P',{segs:[g(L('測試只在 Windows 失敗，錯誤是路徑過長或換行不同時使用。','Use when tests fail only on Windows with path-too-long or line-ending errors.'))]}),
    B('P',{segs:[g(L('1. 執行 ','1. Run ')),g('scripts/check.ps1',{font:MONO,fs:'13px',bg:'var(--o1c1e22)',pad:'1px 5px'}),g(L(' 找出超過 260 字元的路徑','  to find paths over 260 characters'))]}),
    B('P',{segs:[g(L('2. 路徑一律用 ','2. Build paths with ')),g('path.win32',{font:MONO,fs:'13px',bg:'var(--o1c1e22)',pad:'1px 5px'}),g(L(' 組合',''))]}),
    B('P',{segs:[g(L('3. 讀檔時統一換行再比較','3. Normalize line endings before comparing'))]}),
    B('H',{text:L('檔案','Files'),meta:'3',mt:'8px'}),B('Rows',{rows:fileRows})].concat(f?[B('Code',{lines:FILES[f].map(text=>({text,color:C.text,bg:'transparent'}))})]:[]).concat([
    B('H',{text:L('專案','Projects'),mt:'8px',acts:ro?[]:[btn(c,L('加入專案','Add to project'),{icon:icn('plus',12),bg:'transparent',color:C.muted,on:()=>c.dlg('skillAdd',{})})]}),
    B('Rows',{rows:[rr(icn('box',14),'ORB',orb==='v4'?'v4':'v3  '+L('有新版 v4','v4 available'),{metaColor:orb==='v4'?C.muted:C.acc,hasAct:orb!=='v4',act:L('更新','Update'),dis:ro,op:ro?0.45:1,on:()=>c.dlg('skillUpdate',{after:()=>set({korb:'v4'})})}),rr(icn('box',14),'WEB','v3'),rr(icn('box',14),'DOCS','v3')].concat(added.map(x=>rr(icn('box',14),x,'')))}),
    B('H',{text:L('安全掃描','Security scan'),meta:'2',mt:'8px'}),
    B('Rows',{rows:[rr(icn('alert',14),L('會執行 PowerShell 腳本','Runs a PowerShell script'),'scripts/check.ps1',{icColor:C.warn,font:'inherit'}),rr(icn('alert',14),L('連到外部網址','Links to an external URL'),'learn.microsoft.com',{icColor:C.warn})]})]))],'minmax(0,1fr)');out.maxW='800px';
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
M.skilledit=c=>{const {out,s,set,ro,icn,C,flash}=c;const L=base(c,c.lang==='en'?'Upload skill':'上傳技能');
  const nm=s.kn!==undefined?s.kn:'Windows Path Fix';const ok=/^[a-z0-9]+(-[a-z0-9]+)*$/.test(nm)&&nm.length<=64;
  docs(c,[pane([B('Btns',{just:'flex-start',acts:[btn(c,L('選擇資料夾','Choose folder'),{icon:icn('archive',13),on:()=>flash(L('已讀取 3 個檔案','Read 3 files'))}),btn(c,L('上傳 zip','Upload zip'),{icon:icn('archive',13),on:()=>flash(L('已讀取 3 個檔案','Read 3 files'))})]}),
    B('H',{text:L('名稱','Name'),mt:'4px'}),B('Text',{value:nm,on:e=>set({kn:e.target.value}),ph:'windows-path-fix',dis:ro}),
    ok?B('Note',{icon:icn('check',14),icColor:C.ok,bg:'var(--o1a1b1f)',text:L('名稱可用','Name is available')}):B('Note',{icon:icn('alert',14),icColor:C.bad,bg:'var(--tint-danger, rgba(239,107,98,.1))',text:L('只能用小寫英文、數字與連字號，例如 windows-path-fix','Use lowercase letters, numbers and hyphens, e.g. windows-path-fix'),acts:[btn(c,L('改成 windows-path-fix','Use windows-path-fix'),{on:()=>set({kn:'windows-path-fix'})})]}),
    B('H',{text:'SKILL.md',mt:'4px'}),B('Text',{value:s.kmd!==undefined?s.kmd:'---\nname: '+nm+'\ndescription: '+L('修正 Windows 長路徑與換行問題','Fix Windows long paths and line endings')+'\n---\n',on:e=>set({kmd:e.target.value}),ph:'SKILL.md',dis:ro}),
    B('Btns',{just:'flex-end',acts:[btn(c,L('儲存新版本','Save new version'),pri({dis:!ok||ro,op:(!ok||ro)?0.45:1,on:()=>flash(L('已儲存新版本','New version saved'))}))]})])],'minmax(0,1fr)');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
// 35 best-of-N
M.bestofn=c=>{const {out,s,set,ro,row,grp,chip,pill,icn,C,logo,flash}=c;const L=base(c,c.lang==='en'?'Dispatch ORB-42':'派工 ORB-42');
  const runs=s.bruns||[{a:'claude-code',m:'Sonnet 5.5'},{a:'codex',m:'GPT-5 Codex'},{a:'claude-code',m:'Opus 5.5'}];const n=runs.length;
  const open=()=>c.dlg('dispatch',{after:v=>{set({bruns:v.runs});if(v.runs.length>1&&c.p.onCompare)setTimeout(()=>c.p.onCompare('compare'),300);}});
  out.groups=[grp(n>1?L('同時派工 '+n+' 個','Dispatch '+n+' at once'):L('派工','Dispatch'),runs.map((x,i)=>row({icon:logo(x.a,16),title:x.a,chips:[pill(x.m)],right:'#'+(i+1)})))];
  out.headActs=[btn(c,L('編輯','Edit'),{icon:icn('pencil',13),on:open}),btn(c,n>1?L('同時派工 '+n+' 個','Dispatch '+n):L('派工','Dispatch'),pri({icon:icn('play',12),on:open}))];
  out.isEmpty=false;
};
M.compare=c=>{const {out,s,set,ro,icn,C,flash,logo}=c;const L=base(c,c.lang==='en'?'Compare runs  ORB-42':'比較執行結果  ORB-42');
  const pick=s.cp;const X=[['claude-code','Sonnet 5.5','3/3','$0.84','14m','+42 −18',L('讀檔時正規化，測試改用固定字串。','Normalize on read; tests use fixed strings.')],['codex','GPT-5 Codex','3/3','$0.61','11m','+65 −9',L('新增 .gitattributes 並調整測試。','Added .gitattributes and adjusted tests.')],['claude-code','Opus 5.5','2/3','$2.10','19m','+120 −30',L('重寫解析器；macOS 測試 1 個失敗。','Rewrote the parser; 1 macOS test fails.')]];
  docs(c,X.map((x,i)=>pane([B('H',{text:x[0],meta:x[1]}),B('Props',{rows:[{k:L('驗收','Verification'),v:x[2]},{k:L('費用','Cost'),v:x[3]},{k:L('時間','Time'),v:x[4]},{k:L('變更','Changes'),v:x[5]}]}),B('Code',{lines:[['- const lines = src.split("\\n")','-'],['+ const lines = normalizeEol(src).split("\\n")','+']].map(([text,k])=>({text,color:k==='+'?C.ok:C.bad,bg:'transparent'}))}),B('P',{segs:[g(x[6])],color:'var(--o8b9098)'}),
    pick===i?B('Note',{icon:icn('check',14),icColor:C.ok,bg:'var(--tint-success, rgba(79,184,106,.1))',text:L('已選，進入審查關卡','Selected, moved to review gate')}):B('Btns',{just:'flex-start',acts:[btn(c,L('選這個','Choose this'),Object.assign(i===1?pri():{},{dis:ro||pick!=null,op:(ro||pick!=null)?0.45:1,on:()=>c.dlg('pickRun',{label:x[0]+'  '+x[1],others:X.length-1,after:()=>set({cp:i})})}))]})],{bg:'var(--o1a1b1f)',pad:'14px 16px'})),'repeat(3,minmax(0,1fr))');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
// 36 live browser
M.browserlive=c=>{const {out,s,set,icn,C,lang}=c;const L=base(c,c.lang==='en'?'Browser check  Export button works':'瀏覽器驗收  匯出按鈕可用');
  const md=s.bl||'live';out.headSegs=[c.segOf([['live',L('即時','Live')],['done',L('已結束','Finished')]],md,v=>set({bl:v}))];
  const steps=[[L('開啟 /reports','Open /reports'),'0:02'],[L('點擊「匯出」','Click “Export”'),'0:05'],[L('等待下載','Wait for download'),'0:07'],[L('檢查檔名 report.csv','Check file name report.csv'),'0:09']];
  const k=s.blk||2;
  if(md==='live'&&!c.cmp_t){}
  docs(c,[pane([B('Frame',{url:'http://localhost:5173/reports',meta:md==='live'?L('每秒 2 張','2 fps'):L('截圖 4 張','4 screenshots'),dot:md==='live'?C.bad:C.muted,text:md==='live'?L('即時畫面','Live view'):L('最後的截圖','Final screenshot'),cx:['20%','62%','62%','40%'][k-1],cy:['18%','30%','46%','60%'][k-1]}),B('Btns',{just:'flex-start',acts:md==='live'?[btn(c,L('下一步','Next step'),{dis:false,op:1,on:()=>set({blk:Math.min(4,k+1)})})]:[]})]),
    pane([B('H',{text:L('操作紀錄','Actions')}),B('Rows',{rows:steps.map((x,i)=>rr(icn(i<k?'check':'clock',13),x[0],md==='live'&&i===k-1?L('進行中','Running'):x[1],{icColor:i<k||md==='done'?C.ok:C.muted,metaColor:md==='live'&&i===k-1?C.acc:C.muted}))})].concat(md==='done'?[B('H',{text:L('截圖','Screenshots'),mt:'8px'}),B('Rows',{rows:steps.map((x,i)=>rr(icn('file',13),'step-'+(i+1)+'.png',x[1],{font:MONO}))})]:[]),{bg:'var(--o1a1b1f)',pad:'14px 16px'})],'minmax(0,1fr) 280px');
  out.isEmpty=false;out.bDocs=!out.isLoading&&!out.isError;
};
})();
