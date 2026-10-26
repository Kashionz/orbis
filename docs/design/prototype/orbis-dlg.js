(function(){
const E=(...a)=>React.createElement(...a);
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FIRST={9:1,10:3,11:6,12:1},LEN={9:30,10:31,11:30,12:31};
const num=d=>d?d[0]*100+d[1]:0;
const MONO="'JetBrains Mono',ui-monospace,Consolas,monospace";
const D={};
function L(c){return (a,b)=>c.lang==='en'?b:a;}
const members=['kashionz','mei-lin','chen-yu'];
const AVC={kashionz:['K','var(--o3a3e46)'],'mei-lin':['M','var(--o4a3e52)'],'chen-yu':['C','var(--o3b4d45)']};
const AGENTS=['claude-code','codex','antigravity','grok-build'];
const MODELS={'claude-code':['Opus 5.5','Sonnet 5.5','Haiku 5.5'],codex:['GPT-5 Codex','GPT-5','GPT-5 Mini'],antigravity:['Gemini 2.5 Pro','Gemini 2.5 Flash'],'grok-build':['Grok 4','Grok Code Fast 1']};
const NOEFF=['Grok 4','Grok Code Fast 1'],FIXEFF={'Haiku 5.5':'fast'};
const TT={'ORB-42':['修正 Windows 上的換行測試','Fix line-ending tests on Windows'],'ORB-38':['發票按比例計算','Prorated invoices'],'ORB-47':['通知改成推送','Switch notifications to push'],'ORB-51':['匯出 CSV 的編碼','CSV export encoding'],'ORB-36':['執行器長路徑支援','Long path support on runners'],'ORB-45':['看板拖曳排序','Drag to reorder on the board'],'ORB-53':['通知中心分組','Group notifications in the inbox'],'ORB-40':['換行設定文件','Line-ending settings doc'],'ORB-62':['退款流程','Refund flow'],'ORB-60':['帳務重構','Billing rework']};
const taskOpts=(Lx,skip)=>Object.keys(TT).filter(k=>(skip||[]).indexOf(k)<0).map(k=>[k,k+'  '+Lx(TT[k][0],TT[k][1]),'file']);
const SW=['var(--o4c5058)','var(--o8b9098)','var(--od9a845)','var(--o7fb0fa)','var(--o4fb86a)','var(--oef6b62)'];
const done=(x,L,n)=>v=>(x.edit?L('已儲存 ','Saved '):L('已建立 ','Created '))+(n?v[n]:v.name);
const lintSkill=(md,L)=>{const m=/^---\n([\s\S]*?)\n---/.exec(md||'');if(!m)return L('SKILL.md 開頭要有 --- 包住的 name 與 description','SKILL.md must start with name and description between --- lines');const nm=(/^name:\s*(.*)$/m.exec(m[1])||[])[1];const ds=(/^description:\s*(.*)$/m.exec(m[1])||[])[1];
  if(!nm||!nm.trim())return L('缺少 name','name is missing');if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(nm.trim())||nm.trim().length>64)return L('name 只能用小寫英文、數字與連字號，最多 64 字元','name must use lowercase letters, numbers and hyphens, up to 64 characters');
  if(!ds||!ds.trim())return L('缺少 description','description is missing');if(ds.trim().length>1024)return L('description 最多 1024 字元','description must be 1024 characters or fewer');return '';};
const SKMD=L=>'---\nname: windows-path-fix\ndescription: '+L('修正 Windows 長路徑與換行問題','Fix Windows long paths and line endings')+'\n---\n\n'+L('1. 先用 scripts/check.ps1 重現\n2. 改用 path.win32','1. Reproduce with scripts/check.ps1\n2. Switch to path.win32');
const SKFILES=L=>({'SKILL.md':SKMD(L),'scripts/check.ps1':'Get-ChildItem -Recurse | Where-Object { $_.FullName.Length -gt 260 }','references/paths.md':'# Long paths\nhttps://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation'});

// ---------- 專案管理 ----------
D.filter=(c,x,L)=>{const F=[['priority',L('優先度','Priority')],['state',L('狀態','State')],['assignee',L('負責人','Assignee')],['due',L('截止日','Due')]];const O=[['is',L('是','is')],['not',L('不是','is not')],['before',L('早於','before')]];
  return {w:'680px',title:L('篩選條件','Filter conditions'),submit:L('套用','Apply'),init:{match:'all',rows:[{f:'priority',o:'is',v:L('高','High')}]},bad:{match:'all',rows:[{f:'priority',o:'is',v:L('高','High')},{f:'state',o:'is',v:''}]},
  fields:[{k:'match',label:L('符合','Match'),type:'seg',opts:[['all',L('全部條件','All conditions')],['any',L('任一條件','Any condition')]]},{k:'rows',label:L('條件','Conditions'),type:'list',addLabel:L('新增條件','Add condition'),blank:{f:'state',o:'is',v:''},cells:[{k:'f',type:'pk',opts:F},{k:'o',type:'sel',opts:O},{k:'v',type:'in',ph:L('值','Value')}]}],
  validate:v=>((v.rows||[]).some(r=>!(r.v||'').trim())?{rows:L('每個條件都要填值','Every condition needs a value')}:{}),done:v=>L('已套用 '+v.rows.length+' 個條件','Applied '+v.rows.length+' conditions')};};
D.bulk=(c,x,L)=>({w:'480px',title:x.label||L('狀態','State'),submit:L('套用','Apply'),init:{val:''},info:[{text:L('已選 '+(x.n||3)+' 個任務',(x.n||3)+' tasks selected')}],
  fields:[{k:'val',label:x.label||L('狀態','State'),type:'pick',req:true,search:x.field==='assignee',opts:x.opts||[['s2',L('準備中','Todo')],['s4',L('進行中','In progress')]]}],done:()=>L('已更新 '+(x.n||3)+' 個任務','Updated '+(x.n||3)+' tasks'),after:x.after});
D.archive=(c,x,L)=>({w:'420px',title:x.restore?L('還原任務','Restore tasks'):L('封存任務','Archive tasks'),danger:!x.restore,submit:x.restore?L('還原','Restore'):L('封存','Archive'),init:{},info:[{text:x.restore?L('還原 '+(x.n||3)+' 個任務到看板','Restore '+(x.n||3)+' tasks to the board'):L((x.n||3)+' 個任務會從看板隱藏，可在「已封存」中找到',(x.n||3)+' tasks will be hidden from the board; find them under Archived')}],fields:[],done:()=>x.restore?L('已還原','Restored'):L('已封存 '+(x.n||3)+' 個任務','Archived '+(x.n||3)+' tasks'),after:x.after});
D.archiveTask=(c,x,L)=>{const k=x.key||'ORB-42';return x.restore?{w:'420px',title:L('還原 ','Restore ')+k,submit:L('還原','Restore'),init:{},info:[{text:L('任務會回到看板，狀態維持「準備中」','The task returns to the board with state Todo')}],fields:[],done:()=>L('已還原 ','Restored ')+k,after:x.after}:
  {w:'420px',title:L('封存 ','Archive ')+k,danger:true,submit:L('封存','Archive'),init:{},info:[{text:L('任務會從看板隱藏，執行紀錄保留','The task is hidden from the board; run history is kept')}],fields:[{type:'note',tone:'warn',icon:'alert',text:L('執行中的 run_8f2a 會先中止','The running run_8f2a will be cancelled first')}],done:()=>L('已封存 ','Archived ')+k,after:x.after};};
const STN=L=>[['s1',L('待辦','Backlog'),'backlog'],['s2',L('就緒','Ready'),'unstarted'],['s4',L('進行中','In progress'),'started'],['s6',L('完成','Done'),'completed'],['s7',L('已取消','Cancelled'),'cancelled']];
D.epicLink=(c,x,L)=>({w:'480px',title:L('連結規格與 Wiki','Link spec and wiki'),submit:L('儲存','Save'),init:Object.assign({spec:'',wiki:''},x.init||{}),
  fields:[{k:'spec',label:L('儲存庫規格','Repo spec'),type:'pick',search:true,mono:true,opts:[['docs/specs/billing.md','docs/specs/billing.md','file','Kashionz/orbis'],['docs/specs/runner.md','docs/specs/runner.md','file','Kashionz/orbis'],['docs/specs/notify.md','docs/specs/notify.md','file','Kashionz/orbis'],['',L('不連結','None')]]},{k:'wiki',label:L('Wiki 頁','Wiki page'),type:'pick',search:true,opts:[['billing',L('帳務設計','Billing design'),'book',L('團隊 / 設計','Team / Design')],['notify',L('通知架構','Notification architecture'),'book',L('團隊 / 設計','Team / Design')],['',L('不連結','None')]]}],done:()=>L('已更新連結','Links updated'),after:x.after});
D.relation=(c,x,L)=>({w:'480px',title:L('新增關係','Add relation'),submit:L('新增','Add'),init:{kind:'related',task:''},bad:{kind:'blockedBy',task:'ORB-40'},
  fields:[{k:'kind',label:L('種類','Kind'),type:'seg',opts:[['blockedBy',L('被封鎖','Blocked by')],['blocks',L('封鎖','Blocks')],['related',L('相關','Related')],['duplicate',L('重複','Duplicate')]]},{k:'task',label:L('任務','Task'),type:'pick',req:true,search:true,opts:taskOpts(L,['ORB-42'])}],
  validate:v=>((x.has||[['blockedBy','ORB-40'],['blocks','ORB-45'],['related','ORB-51']]).some(r=>r[0]===v.kind&&r[1]===v.task)?{task:L('已經有這個關係','This relation already exists')}:{}),done:v=>L('已新增關係 ','Added relation ')+v.task,after:x.after});
const polOpts=L=>[['yolo',L('全部允許','Allow all'),L('所有動作都不再詢問（預設）','Never ask (default)')],['auto',L('自動','Auto'),L('讀取與工作樹內的編輯自動允許，其他問我','Reads and edits inside the worktree run; everything else asks')],['manual',L('逐一確認','Manual'),L('每個動作都先詢問','Ask before every action')]];
const effOpts=(L,model)=>{const no=NOEFF.indexOf(model)>=0,fx=FIXEFF[model];return [['fast',L('快速','Fast')],['std',L('標準','Standard')],['deep',L('深度','Deep')]].map(([k,l])=>[k,l,null,(no||(fx&&fx!==k))?(no?L('此模型不支援調整推理強度','This model doesn’t support reasoning effort'):L('此模型固定為快速','This model is fixed to Fast')):'']);};
const agentOpts=L=>AGENTS.map(a=>[a,a,'agent:'+a,a==='antigravity'?L('需要重新登入','Sign in again'):{'claude-code':'Anthropic',codex:'OpenAI','grok-build':'xAI'}[a],a==='antigravity'?L('需要重新登入','Sign in again'):'']);
D.assignAgent=(c,x,L)=>({w:'560px',title:x.auto?L('相依完成後自動派工','Dispatch when dependencies finish'):L('指派給代理','Assign to an agent'),submit:x.auto?L('開啟自動派工','Turn on'):L('指派','Assign'),init:Object.assign({agent:'claude-code',where:'local',model:'Sonnet 5.5',effort:'std',policy:'yolo'},x.init||{}),
  info:x.auto?[{text:L('ORB-40 完成後，用以下設定自動派工','When ORB-40 is done, dispatch with these settings'),icon:'clock',icColor:'var(--od9a845)'}]:[],
  fields:v=>[{k:'agent',label:L('代理','Agent'),type:'pick',req:true,opts:agentOpts(L)},{k:'where',label:L('在哪裡跑','Runs on'),type:'seg',opts:[['local',L('我的電腦  KASH-DESKTOP','My computer  KASH-DESKTOP'),'monitor'],['team',L('團隊執行器  team-runner-01','Team runner  team-runner-01'),'server']]},
    {k:'model',label:L('模型','Model'),type:'pick',req:true,opts:(MODELS[v.agent]||[]).map(m=>[m,m,'agent:'+v.agent])},{k:'effort',label:L('推理強度','Reasoning effort'),type:'seg',opts:effOpts(L,v.model)},{k:'policy',label:L('權限策略','Permission policy'),type:'radio',opts:polOpts(L)}],
  fix:(v,o)=>{const n=Object.assign({},v,o);if(o.agent&&MODELS[o.agent].indexOf(n.model)<0)n.model=MODELS[o.agent][1]||MODELS[o.agent][0];if(FIXEFF[n.model])n.effort=FIXEFF[n.model];return n;},
  validate:v=>(v.agent==='antigravity'?{agent:L('antigravity 需要重新登入','antigravity needs you to sign in again')}:{}),bad:{agent:'antigravity',where:'local',model:'Gemini 2.5 Pro',effort:'std',policy:'yolo'},
  done:v=>x.auto?L('已開啟，ORB-40 完成後派工給 ','On. Dispatches to ')+v.agent+L('',' when ORB-40 is done'):L('已指派給 ','Assigned to ')+v.agent,after:x.after});
D.dispatch=(c,x,L)=>({w:'680px',title:L('派工 ORB-42','Dispatch ORB-42'),init:{runs:[{a:'claude-code',m:'Sonnet 5.5'},{a:'codex',m:'GPT-5 Codex'}],where:'team',sk:['windows-path-fix','pr-description'],plan:false,policy:'yolo'},bad:{runs:[{a:'claude-code',m:'Sonnet 5.5'},{a:'claude-code',m:'Sonnet 5.5'}],where:'team',sk:[],plan:false,policy:'yolo'},
  submitOf:v=>v.runs.length>1?L('同時派工 '+v.runs.length+' 個','Dispatch '+v.runs.length):L('派工','Dispatch'),
  fields:v=>[{k:'runs',label:L('代理與模型','Agents and models'),type:'list',req:true,max:4,min:1,addLabel:L('新增一組','Add a run'),blank:{a:'codex',m:'GPT-5'},cells:[{k:'a',type:'pk',opts:AGENTS.filter(a=>a!=='antigravity').map(a=>[a,a,'agent:'+a])},{k:'m',type:'pk',opts:r=>(MODELS[r.a]||[]).map(m=>[m,m])}],hint:v.runs.length>1?L(v.runs.length+' 個執行會同時跑，完成後並排比較',v.runs.length+' runs start together; compare them when done'):L('加到 2–4 組可以並排比較','Add 2–4 runs to compare side by side')},
    {k:'where',label:L('在哪裡跑','Runs on'),type:'seg',opts:[['local',L('我的電腦','My computer'),'monitor'],['team',L('團隊執行器','Team runner'),'server']]},
    {k:'policy',label:L('權限策略','Permission policy'),type:'seg',opts:polOpts(L).map(o=>[o[0],o[1]]),hint:(polOpts(L).find(o=>o[0]===v.policy)||[])[2]||''},
    {k:'plan',type:'switch',swLabel:L('先出計畫','Plan first'),hint:L('代理先寫計畫，你核准後才開始修改','The agent writes a plan first and starts changing files after you approve it')},
    {k:'sk',label:L('技能','Skills'),type:'multi',opts:[['windows-path-fix','windows-path-fix'],['pr-description','pr-description'],['docker-debug','docker-debug'],['notify-format','notify-format'],['eol-check','eol-check'],['test-first','test-first'],['csv-encoding','csv-encoding']]}].concat((v.sk||[]).length>6?[{type:'note',tone:'warn',icon:'alert',text:L('一次載入太多技能，代理的上下文會變少','Too many skills; the agent has less context to work with')}]:[]),
  fix:(v,o)=>{const n=Object.assign({},v,o);n.runs=(n.runs||[]).map(r=>MODELS[r.a]&&MODELS[r.a].indexOf(r.m)<0?Object.assign({},r,{m:MODELS[r.a][0]}):r);return n;},
  validate:v=>{const ks=(v.runs||[]).map(r=>r.a+'|'+r.m);return ks.length!==new Set(ks).size?{runs:L('有重複的代理與模型組合','Two runs use the same agent and model')}:{};},
  done:v=>v.runs.length>1?L('已同時派工 '+v.runs.length+' 個','Dispatched '+v.runs.length+' runs'):L('已派工','Dispatched'),after:x.after});
D.pickRun=(c,x,L)=>({w:'420px',title:L('選定 ','Choose ')+(x.label||'codex  GPT-5 Codex'),submit:L('選定','Choose'),init:{},info:[{text:L('選定的結果會進入審查關卡','The chosen result moves to the review gate')},{text:L('其他 '+(x.others||2)+' 個執行的工作樹保留 14 天後封存','Worktrees of the other '+(x.others||2)+' runs are archived after 14 days'),icon:'archive',icColor:'var(--o8b9098)'}],fields:[],done:()=>L('已進入審查關卡','Moved to review gate'),after:x.after});
// ---------- 範本 ----------
D.tpl=(c,x,L)=>({w:'680px',title:x.edit?L('編輯任務範本','Edit task template'):L('存成任務範本','Save as task template'),submit:x.edit?L('儲存','Save'):L('存成範本','Save template'),init:x.init||{name:'',scope:'personal',body:''},bad:{name:L('錯誤回報','Bug report'),scope:'shared',body:L('## 重現步驟','## Steps to reproduce')},
  fields:[{k:'name',label:L('名稱','Name'),type:'text',req:true},{k:'scope',label:L('範圍','Scope'),type:'seg',opts:[['personal',L('個人','Personal')],['shared',L('團隊共用','Shared with team')]]},{k:'body',label:L('規格','Spec'),type:'area',req:true,ph:L('## 背景\n## 範圍','## Context\n## Scope'),hint:x.edit?'':L('目前的驗收條件會一起存進範本','Current acceptance criteria are saved with it')}],
  validate:v=>((x.names||['錯誤回報','新功能','我的重構清單','Bug report','New feature','My refactor checklist']).indexOf((v.name||'').trim())>=0?{name:L('已有同名的範本','A template with this name exists')}:{}),done:v=>(x.edit?L('已儲存 ','Saved '):L('已存成範本 ','Saved template '))+v.name,after:x.after});
D.delTpl=(c,x,L)=>({w:'420px',title:L('刪除範本','Delete template'),danger:true,submit:L('刪除','Delete'),init:{},info:[{text:x.name||L('錯誤回報','Bug report')},{text:L('已用這個範本建立的任務不受影響','Tasks created from it are not affected'),icColor:'var(--o8b9098)'}],fields:[],done:()=>L('已刪除','Deleted'),after:x.after});
// ---------- 報告 ----------
D.saveWiki=(c,x,L)=>{const FO={team:[['design',L('設計','Design')],['dec',L('決策紀錄','Decisions')],['reports',L('週報','Weekly reports')]],orb:[['runners',L('執行器','Runners')],['root',L('專案 ORB 根目錄','Project ORB root')]],priv:[['drafts',L('我的草稿','My drafts')]]};
  return {w:'480px',title:L('存成 Wiki 頁','Save as wiki page'),submit:L('儲存','Save'),init:{sp:'team',fo:'reports',name:L('kashionz 本週報告 10/25','kashionz weekly report Oct 25')},bad:{sp:'team',fo:'reports',name:L('kashionz 本週報告 10/18','kashionz weekly report Oct 18')},
  fields:v=>[{k:'sp',label:L('空間','Space'),type:'pick',req:true,opts:[['team',L('團隊','Team'),'users'],['orb',L('專案 ORB','Project ORB'),'box']]},{k:'fo',label:L('資料夾','Folder'),type:'pick',req:true,opts:(FO[v.sp]||[]).map(f=>[f[0],f[1],'folder'])},{k:'name',label:L('頁面名稱','Page name'),type:'text',req:true}],
  fix:(v,o)=>{const n=Object.assign({},v,o);if(o.sp&&!(FO[o.sp]||[]).some(f=>f[0]===n.fo))n.fo=(FO[o.sp][0]||[])[0];return n;},
  validate:v=>((v.name||'').trim()===L('kashionz 本週報告 10/18','kashionz weekly report Oct 18')?{name:L('這個資料夾已有同名的頁面','A page with this name exists in this folder')}:{}),done:v=>L('已存成 ','Saved as ')+v.name};};
D.regen=(c,x,L)=>({w:'420px',title:L('重新產生摘要','Regenerate summary'),submit:L('重新產生','Regenerate'),init:{},
  info:[{text:L('用 team-runner-01 上的 claude-code  Sonnet 5.5 產生','Generated by claude-code  Sonnet 5.5 on team-runner-01'),icon:'server',icColor:'var(--o8b9098)'},{text:L('預估費用','Estimated cost'),meta:'$0.12',font:MONO,icon:'gauge',icColor:'var(--od9a845)'}],
  fields:[{type:'note',tone:'muted',icon:'clock',text:L('目前的版本會保留在歷史版本中','The current version stays in history')}],done:()=>L('已重新產生摘要','Summary regenerated'),after:x.after});
// ---------- 對話 ----------
D.commit=(c,x,L)=>({w:'560px',title:'Commit',submit:'Commit',init:{msg:x.msg!==undefined?x.msg:'fix(parser): normalize CRLF on read\n\n'},bad:{msg:'fix(parser): normalize CRLF line endings when reading files on Windows runners'},
  info:[{text:L('3 個檔案','3 files'),meta:'+42 −18',font:MONO,icon:'file',icColor:'var(--o8b9098)'}],
  fields:[{k:'msg',label:L('訊息','Message'),type:'area',req:true,mono:true},{type:'kv',rows:[['M','src/parser.ts'],['M','src/parser.test.ts'],['A','.gitattributes']]}],
  validate:v=>{const l=(v.msg||'').split('\n')[0];return l.length>72?{msg:L('第一行最多 72 個字元，目前 '+l.length,'Keep the first line to 72 characters; it’s '+l.length)}:{};},done:()=>L('已 commit  a3f91c2','Committed  a3f91c2'),after:x.after});
D.pushPR=(c,x,L)=>({w:'680px',title:L('Push 並開合併請求','Push and open pull request'),submit:L('開合併請求','Open pull request'),init:{title:'fix(parser): normalize CRLF on read',body:L('## 變更\n- 讀檔時統一換行\n\n## 驗收\n- pnpm test 通過','## Changes\n- Normalize line endings on read\n\n## Verification\n- pnpm test passes'),draft:false},bad:{title:'',body:'',draft:false},
  info:[{text:'orbis/conv-c1 → main',font:MONO,icon:'git',icColor:'var(--o8b9098)',meta:'Kashionz/orbis'}],
  fields:[{k:'title',label:L('標題','Title'),type:'text',req:true},{k:'body',label:L('說明','Description'),type:'area',mono:true},{k:'draft',type:'switch',swLabel:L('建立為草稿','Create as draft')}],done:()=>L('已開合併請求 #143','Opened pull request #143'),after:x.after});
D.mergeLocal=(c,x,L)=>({w:'420px',title:L('合併到 main','Merge into main'),submit:L('合併','Merge'),init:{},info:[{text:L('orbis/conv-c1 的 2 個 commit 會合併到本機 main','2 commits on orbis/conv-c1 merge into your local main')},{text:L('合併後工作樹會封存','The worktree is archived after merging'),icon:'archive',icColor:'var(--o8b9098)'}],fields:[],done:()=>L('已合併到 main','Merged into main'),after:x.after});
D.discard=(c,x,L)=>({w:'420px',title:x.revert?L('還原修改','Revert changes'):L('捨棄變更','Discard changes'),danger:true,submit:x.revert?L('還原','Revert'):L('捨棄','Discard'),init:{},info:[{text:x.revert?L('C:\\Users\\kash\\scripts 中 2 個檔案會還原成對話開始前的內容','2 files in C:\\Users\\kash\\scripts go back to how they were before the conversation'):L('3 個檔案的修改與工作樹會被刪除，無法復原','Changes to 3 files and the worktree are deleted. This can’t be undone')}],fields:[],done:()=>x.revert?L('已還原','Reverted'):L('已捨棄','Discarded'),after:x.after});
D.convTask=(c,x,L)=>({w:'680px',title:L('轉成任務','Convert to task'),submit:L('建立','Create'),loading:{text:L('claude-code 正在草擬任務','claude-code is drafting the task'),ms:1600},
  init:{title:L('解析器支援 CRLF','Parser supports CRLF'),spec:L('讀檔時統一換行；保留原始位元組供差異比對','Normalize line endings on read; keep raw bytes for diffs'),ac:[{v:'`pnpm test`'},{v:L('macOS 與 Linux 的行為不受影響','macOS and Linux behave the same as before')}],prj:'ORB',st:'s4'},bad:{title:'',spec:'',ac:[{v:''}],prj:'ORB',st:'s4'},
  fields:[{k:'title',label:L('標題','Title'),type:'text',req:true},{k:'spec',label:L('規格','Spec'),type:'area',req:true},{k:'ac',label:L('驗收條件（選填）','Acceptance criteria (optional)'),type:'list',min:0,addLabel:L('新增條件','Add criterion'),blank:{v:''},cells:[{k:'v',type:'in',ph:L('例如：登入後看得到儀表板，或 `pnpm test`','e.g. The dashboard shows after sign-in, or `pnpm test`')}],hint:L('用反引號包住的指令會在工作樹執行，其他交給代理判定；專案的驗收指令每次都會先跑','A command in backticks runs in the worktree; anything else is checked by an agent. The project’s verify commands always run first')},{k:'prj',label:L('專案','Project'),type:'pick',req:true,opts:[['ORB','Orbis','box'],['WEB','Web','box']]},{k:'st',label:L('狀態','State'),type:'pick',opts:STN(L).map(s=>[s[0],s[1],'grp:'+s[2]])}],
  validate:v=>({}),done:()=>L('已建立 ORB-64','Created ORB-64'),after:x.after});
D.shareConv=(c,x,L)=>({w:'420px',title:L('分享對話','Share conversation'),submit:L('儲存','Save'),init:{to:x.to||'me'},fields:[{k:'to',type:'radio',opts:[['me',L('只有自己','Only you'),L('其他人看不到這段對話','No one else can see it')],['team',L('團隊可檢視','Team can view'),L('Kash Studio 的成員可以唯讀檢視','Kash Studio members can read it')]]}],done:v=>v.to==='team'?L('團隊可以檢視','Shared with the team'):L('只有自己','Only you'),after:x.after});
// ---------- Wiki ----------
const WF=L=>[['design',L('團隊 / 設計','Team / Design')],['dec',L('團隊 / 決策紀錄','Team / Decisions')],['runners',L('專案 ORB / 執行器','Project ORB / Runners')]];
D.wikiMove=(c,x,L)=>({w:'480px',title:L('移動「','Move “')+(x.name||L('帳務設計','Billing design'))+L('」','”'),submit:L('移動','Move'),init:{to:''},bad:{to:x.from||'design'},sample:{to:'dec'},
  fields:v=>[{k:'to',label:L('移到','Move to'),type:'pick',req:true,search:true,opts:WF(L).map(f=>[f[0],f[1],'folder'])}],
  validate:v=>(v.to===(x.from||'design')?{to:L('已經在這個資料夾','Already in this folder')}:{}),done:()=>L('已移動','Moved'),after:x.after});
D.wikiDelete=(c,x,L)=>{const bl=x.backlinks!==undefined?x.backlinks:[[L('通知架構','Notification architecture'),L('設計','Design')],['ORB-38',L('任務','Task')],[L('2026-10 換行處理','2026-10 Line endings'),L('決策紀錄','Decisions')]];
  return {w:'420px',title:L('刪除「','Delete “')+(x.name||L('帳務設計','Billing design'))+L('」','”'),danger:true,submit:L('刪除','Delete'),init:{},
  fields:(bl.length?[{type:'note',tone:'warn',icon:'alert',text:L(bl.length+' 個頁面連到這頁，刪除後連結會失效',bl.length+' pages link here; those links will break')},{type:'kv',rows:bl}]:[]).concat([{type:'note',tone:'muted',icon:'clock',text:L('30 天內可以從垃圾桶還原','You can restore it from Trash within 30 days')}]),done:()=>L('已刪除','Deleted'),after:x.after};};
D.wikiProp=(c,x,L)=>({w:'480px',title:L('新增屬性','Add property'),submit:L('新增','Add'),init:{name:'',type:'text'},bad:{name:L('標籤','Tags'),type:'text'},
  fields:[{k:'name',label:L('名稱','Name'),type:'text',req:true,ph:L('例如 審閱者','e.g. Reviewer')},{k:'type',label:L('型別','Type'),type:'seg',opts:[['text',L('文字','Text')],['number',L('數字','Number')],['date',L('日期','Date')],['member',L('成員','Member')],['tags',L('標籤','Tags')],['bool',L('是否','Yes or no')],['link',L('連結','Link')]]}],
  validate:v=>([L('標籤','Tags'),L('狀態','Status'),L('負責人','Owner'),L('相關任務','Related tasks')].indexOf((v.name||'').trim())>=0?{name:L('這頁已有同名的屬性','This page already has that property')}:{}),done:v=>L('已新增屬性 ','Added property ')+v.name,after:x.after});
D.wikiView=(c,x,L)=>({w:'560px',title:L('新增頁面檢視','New page view'),submit:L('建立','Create'),init:{name:'',layout:'table',src:'design',grp:'status'},bad:{name:L('所有頁面','All pages'),layout:'table',src:'design',grp:'status'},
  fields:[{k:'name',label:L('名稱','Name'),type:'text',req:true,ph:L('例如 審閱中的設計','e.g. Designs in review')},{k:'layout',label:L('版面','Layout'),type:'seg',opts:[['table',L('表格','Table')],['board',L('看板','Board')],['list',L('清單','List')],['cal',L('月曆','Calendar')]]},{k:'src',label:L('來源','Source'),type:'pick',req:true,opts:[['all',L('整個空間','Whole space'),'book']].concat(WF(L).slice(0,2).map(f=>[f[0],f[1],'folder']))},{k:'grp',label:L('分組','Group by'),type:'pick',opts:[['status',L('狀態','Status')],['owner',L('負責人','Owner')],['none',L('不分組','None')]]}],
  validate:v=>((v.name||'').trim()===L('所有頁面','All pages')?{name:L('已有同名的檢視','A view with this name exists')}:{}),done:v=>L('已建立檢視 ','Created view ')+v.name,after:x.after});
D.wikiRestore=(c,x,L)=>({w:'420px',title:L('還原到 ','Restore ')+(x.v||'v10'),submit:L('還原','Restore'),init:{},info:[{text:L('目前的內容會存成 v13，之後仍可還原','The current content is saved as v13 and can be restored later')}],fields:[],done:()=>L('已還原到 ','Restored ')+(x.v||'v10'),after:x.after});
D.wikiExport=(c,x,L)=>({w:'480px',title:L('匯出 Markdown','Export Markdown'),submit:L('匯出','Export'),init:{sc:'space',att:true},info:[{text:L('匯出成 Markdown 檔案（.zip），wikilink 轉成相對連結','Exports Markdown files (.zip); wikilinks become relative links'),icon:'download'}],
  fields:[{k:'sc',label:L('範圍','Scope'),type:'seg',opts:[['space',L('整個空間','Whole space')],['folder',L('設計資料夾','Design folder')],['page',L('這一頁','This page')]]},{k:'att',type:'switch',swLabel:L('包含附件','Include attachments')}],done:()=>L('已匯出 wiki.zip','Exported wiki.zip')});
D.propDecline=(c,x,L)=>({w:'420px',title:L('拒絕修改','Decline change'),danger:true,submit:L('拒絕','Decline'),init:{why:''},info:[{text:(x.page||L('帳務設計','Billing design'))+'  claude-code  '+(x.run||'run_8f2a')}],fields:[{k:'why',label:L('原因','Reason'),type:'area',ph:L('選填，會回覆給代理','Optional; sent back to the agent')}],done:()=>L('已拒絕','Declined'),after:x.after});
D.wikiSpec=(c,x,L)=>({w:'560px',title:L('提交成儲存庫規格','Submit as repo spec'),submit:L('開合併請求','Open pull request'),init:{repo:'Kashionz/orbis',path:'docs/specs/billing-design.md'},bad:{repo:'Kashionz/orbis',path:'docs/specs/billing-design'},
  fields:v=>[{k:'repo',label:L('儲存庫','Repository'),type:'pick',req:true,search:true,opts:[['Kashionz/orbis','Kashionz/orbis','git'],['Kashionz/orbis-desktop','Kashionz/orbis-desktop','git']]},{k:'path',label:L('路徑','Path'),type:'text',req:true,mono:true},{type:'kv',rows:[[L('分支','Branch'),'orbis/wiki-spec-billing'],[L('標題','Title'),'docs: add billing design spec'],[L('檔案','File'),v.path||'']]}],
  validate:v=>(v.path&&!/\.md$/.test(v.path)?{path:L('路徑要以 .md 結尾','The path must end in .md')}:{}),done:()=>L('已開合併請求 #144','Opened pull request #144')});
// ---------- 技能 ----------
const NAMEOK=n=>/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)&&n.length<=64;
D.skillNew=(c,x,L)=>({w:'680px',title:L('新增技能','New skill'),init:{src:'upload',f:'',name:'',repo:'',path:'',ref:'main'},bad:{src:'blank',f:'',name:'Windows Path Fix',repo:'',path:'',ref:'main'},
  submitOf:v=>({upload:L('上傳','Upload'),blank:L('建立','Create'),github:L('同步','Sync')})[v.src],
  fields:v=>[{k:'src',label:L('來源','Source'),type:'radio',opts:[['upload',L('上傳資料夾或 zip','Upload a folder or zip'),L('包含 SKILL.md 的資料夾','A folder that contains SKILL.md')],['blank',L('從空白開始','Start from blank'),L('在編輯器中撰寫 SKILL.md','Write SKILL.md in the editor')],['github',L('從 GitHub 同步','Sync from GitHub'),L('有新的 commit 時建立新版本','New commits create a new version')]]}].concat(
    v.src==='upload'?[{k:'f',label:L('檔案','Files'),type:'file',req:true,accept:L('資料夾或 .zip','Folder or .zip'),ph:L('拖放資料夾或 .zip 到這裡','Drop a folder or .zip here'),choose:L('選擇檔案','Choose files'),sample:'windows-path-fix.zip',size:'3 '+L('個檔案','files')}]:
    v.src==='blank'?[{k:'name',label:L('名稱','Name'),type:'text',req:true,mono:true,ph:'windows-path-fix',hint:L('小寫英文、數字與連字號','Lowercase letters, numbers and hyphens')}]:
    [{k:'repo',label:L('儲存庫','Repository'),type:'pick',req:true,search:true,opts:[['Kashionz/orbis','Kashionz/orbis','git'],['Kashionz/skills','Kashionz/skills','git']]},{k:'path',label:L('路徑','Path'),type:'text',req:true,mono:true,ph:'.claude/skills/windows-path-fix'},{k:'ref',label:L('分支或標籤','Branch or tag'),type:'text',mono:true}]),
  validate:v=>{if(v.src==='blank'&&v.name&&!NAMEOK(v.name))return {name:L('只能用小寫英文、數字與連字號，例如 windows-path-fix','Use lowercase letters, numbers and hyphens, e.g. windows-path-fix')};if(v.src==='blank'&&['windows-path-fix','pr-description','docker-debug'].indexOf(v.name)>=0)return {name:L('已有同名的技能','A skill with this name exists')};if(v.src==='github'&&/SKILL\.md$/.test(v.path||''))return {path:L('填資料夾路徑，不含 SKILL.md','Enter the folder path without SKILL.md')};return {};},
  done:v=>v.src==='github'?L('已同步 v1','Synced v1'):'',after:v=>{if(v.src!=='github'&&x.next)x.next(v);}});
D.skillVersion=(c,x,L)=>({w:'560px',title:L('上傳新版本','Upload new version'),submit:L('上傳 v5','Upload v5'),init:{f:'',note:''},bad:{f:'windows-path-fix.tar',note:''},
  info:[{text:'windows-path-fix',font:MONO,meta:'v4 → v5'}],
  fields:[{k:'f',label:L('檔案','Files'),type:'file',req:true,accept:L('資料夾或 .zip','Folder or .zip'),ph:L('拖放資料夾或 .zip 到這裡','Drop a folder or .zip here'),choose:L('選擇檔案','Choose files'),sample:'windows-path-fix-v5.zip',size:'4 '+L('個檔案','files')},{k:'note',label:L('變更說明','What changed'),type:'area',ph:L('選填，會顯示在版本紀錄','Optional; shown in the version history')}],
  validate:v=>(v.f&&!/\.zip$/.test(v.f)?{f:L('只能上傳資料夾或 .zip','Upload a folder or .zip')}:{}),done:()=>L('已上傳 v5','Uploaded v5')});
D.skillEdit=(c,x,L)=>({w:'680px',title:x.title||L('編輯 windows-path-fix','Edit windows-path-fix'),submit:L('儲存新版本','Save new version'),loading:x.loading?{text:L('代理正在把這次執行整理成技能','The agent is turning this run into a skill'),ms:1800}:null,
  init:{files:{sel:'SKILL.md',files:x.files||SKFILES(L)}},bad:{files:{sel:'SKILL.md',files:Object.assign({},SKFILES(L),{'SKILL.md':'---\nname: Windows Path Fix\ndescription: \n---\n'})}},
  fields:[{k:'files',type:'editor',addLabel:L('新增檔案','Add file'),newName:'references/notes.md'}],
  validate:v=>{const e=lintSkill(((v.files||{}).files||{})['SKILL.md'],L);return e?{files:e}:{};},done:()=>L('已儲存新版本','New version saved'),after:x.after});
D.skillAdd=(c,x,L)=>({w:'480px',title:L('加入專案','Add to project'),submit:L('加入','Add'),init:{prj:'',ver:'v4'},
  fields:[{k:'prj',label:L('專案','Project'),type:'pick',req:true,opts:[['ORB','Orbis','box',L('已加入 v3','Has v3'),L('已加入 v3','Already has v3')],['WEB','Web','box',L('已加入 v3','Has v3'),L('已加入 v3','Already has v3')],['DOCS','Docs','box']]},{k:'ver',label:L('版本','Version'),type:'pick',req:true,opts:[['v4','v4','tag',L('最新','Latest')],['v3','v3','tag'],['v2','v2','tag']]}],done:v=>L('已加入 ','Added to ')+v.prj+'  '+v.ver});
D.skillUpdate=(c,x,L)=>({w:'560px',title:L('將 ORB 更新到 v4','Update ORB to v4'),submit:L('更新','Update'),init:{},info:[{text:L('和目前版本 v3 的差異','Changes since v3 (current)')}],
  fields:[{type:'diff',lines:[['-',L('2. 改用 path.posix','2. Switch to path.posix')],['+',L('2. 改用 path.win32','2. Switch to path.win32')],['+','scripts/check.ps1']]},{type:'note',tone:'muted',icon:'play',text:L('進行中的執行會在下次啟動時載入 v4','Running runs load v4 the next time they start')}],done:()=>L('ORB 已更新到 v4','ORB updated to v4'),after:x.after});
D.skillSubmit=(c,x,L)=>({w:'680px',title:L('提交到儲存庫','Submit to repo'),submit:L('開合併請求','Open pull request'),init:{repo:'Kashionz/orbis',path:'.claude/skills/windows-path-fix/'},bad:{repo:'Kashionz/orbis',path:'.claude/skills/windows-path-fix/SKILL.md'},
  fields:v=>[{k:'repo',label:L('儲存庫','Repository'),type:'pick',req:true,search:true,opts:[['Kashionz/orbis','Kashionz/orbis','git'],['Kashionz/orbis-desktop','Kashionz/orbis-desktop','git']]},{k:'path',label:L('寫入路徑','Write to'),type:'text',req:true,mono:true},
    {type:'kv',rows:[[L('分支','Branch'),'orbis/skill-windows-path-fix'],[L('標題','Title'),'feat: add windows-path-fix skill (v4)'],[L('檔案','Files'),(v.path||'')+'SKILL.md'],['',(v.path||'')+'scripts/check.ps1'],['',(v.path||'')+'references/paths.md']]}],
  validate:v=>(v.path&&!/\/$/.test(v.path)?{path:L('填資料夾路徑，以 / 結尾','Enter a folder path ending in /')}:{}),done:()=>L('已開合併請求 #142','Opened pull request #142')});
// ---------- 帳號 ----------
const SCOPES=[['task:read','task:read',null,'Read tasks'],['task:write','task:write'],['run:read','run:read'],['repo:read','repo:read'],['wiki:read','wiki:read'],['wiki:write','wiki:write']];
// ---------- 執行環境 ----------
D.archiveWt=(c,x,L)=>({w:'420px',title:L('封存工作樹','Archive worktree'),danger:true,submit:L('封存','Archive'),init:{},info:[{text:(x.run||'run_7c19')+'  orbis/orb-42-2',font:MONO},{text:L('工作樹會從磁碟移除，分支與執行紀錄保留','The worktree is removed from disk; the branch and run history stay')}],fields:[],done:()=>L('已封存工作樹','Worktree archived'),after:x.after});
D.auditExport=(c,x,L)=>({w:'480px',title:L('匯出稽核紀錄','Export audit log'),submit:L('匯出','Export'),init:{rg:'30',fmt:'csv',flt:true},
  fields:v=>[{k:'rg',label:L('期間','Period'),type:'seg',opts:[['7',L('7 天','7 days')],['30',L('30 天','30 days')],['90',L('90 天','90 days')]]},{k:'fmt',label:L('格式','Format'),type:'seg',opts:[['csv','CSV'],['json','JSON']]},{k:'flt',type:'switch',swLabel:L('套用目前的篩選','Apply current filters')},{type:'kv',rows:[[L('筆數','Entries'),v.flt?'38':({'7':'52','30':'214','90':'611'})[v.rg]]]}],done:v=>L('已匯出 audit.','Exported audit.')+v.fmt});

// ---------- 範例資料（畫廊用） ----------
const auto=(sp,fields,base)=>{const v=JSON.parse(JSON.stringify(base||sp.init||{}));fields.forEach(f=>{if(!f.k||!f.req)return;const cur=v[f.k];const empty=f.type==='list'?!(cur||[]).length:(f.type==='multi'?!(cur||[]).length:!cur||(typeof cur==='string'&&!cur.trim()));if(!empty)return;
  if(f.type==='text'||f.type==='area')v[f.k]=f.mono?'example':'範例';else if(f.type==='pick'){const o=(typeof f.opts==='function'?f.opts(v):f.opts).find(x=>!x[4]);v[f.k]=o?o[0]:'';}else if(f.type==='date')v[f.k]=[10,28];else if(f.type==='file')v[f.k]=f.sample;else if(f.type==='multi')v[f.k]=[f.opts[0][0]];else if(f.type==='list')v[f.k]=[Object.assign({},f.blank,{v:'pnpm test'})];});return v;};
function fieldsOf(sp,v){return (typeof sp.fields==='function'?sp.fields(v):sp.fields)||[];}
function initState(c,k,x,force){const Lx=L(c);const sp=D[k](c,x||{},Lx);let v=JSON.parse(JSON.stringify(sp.init||{}));
  const d={k,x:x||{},v:null,pop:null,mon:{},phase:'idle',ask:false,tried:false,q:'',probe:null};
  const sample=()=>{let sv=sp.sample?Object.assign({},v,sp.sample):v;sv=auto(sp,fieldsOf(sp,sv),sv);return sv;};
  if(force==='err'){d.v=sp.bad?JSON.parse(JSON.stringify(sp.bad)):v;d.tried=true;}
  else if(force==='sending'){d.v=sample();d.phase='sending';}
  else if(force==='srv'){d.v=sample();d.phase='srv';}
  else if(force==='ask'){d.v=sample();if(JSON.stringify(d.v)===JSON.stringify(v)){const f=fieldsOf(sp,v).find(f=>f.type==='text'||f.type==='area');if(f)d.v[f.k]=(d.v[f.k]||'')+(f.type==='area'?'\n…':' 2');}d.ask=true;}
  else if(force==='loading'&&sp.loading){d.phase='loading';}
  else if(force==='done'&&sp.result){d.v=sample();d.phase='done';}
  else if(force==='dis'){const e=JSON.parse(JSON.stringify(v));fieldsOf(sp,v).forEach(f=>{if(f.req&&f.k)e[f.k]=(f.type==='list'||f.type==='multi')?[]:(f.type==='date'?null:'');});d.v=e;}
  else if(force==='ok'){d.v=sample();}
  else if(sp.loading&&!force)d.phase='loading';
  return {d,sp};}
const iconOf=(c,n,s)=>{s=s||14;if(!n)return null;if(typeof n!=='string')return n;
  if(n.indexOf('agent:')===0)return E('img',{src:'assets/agents/'+n.slice(6)+'.svg',width:s,height:s,alt:'',style:{borderRadius:'50%',display:'block'}});
  if(n.indexOf('av:')===0){const a=AVC[n.slice(3)]||['?','var(--o22242a)'];return E('span',{style:{width:s+2,height:s+2,borderRadius:'50%',background:a[1],color:'var(--oe8e9eb)',display:'grid',placeItems:'center',fontSize:9,fontWeight:550}},a[0]);}
  if(n.indexOf('dot:')===0)return E('span',{style:{width:12,height:12,borderRadius:'50%',background:n.slice(4),display:'block'}});
  if(n.indexOf('grp:')===0){const g=n.slice(4);const col={backlog:'var(--o4c5058)',unstarted:'var(--o8b9098)',started:'var(--od9a845)',completed:'var(--o4fb86a)',cancelled:'var(--oef6b62)'}[g];const k=[];
    if(g==='backlog')k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:col,strokeWidth:1.5,strokeDasharray:'2 2',fill:'none'}));else if(g==='unstarted')k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:col,strokeWidth:1.5,fill:'none'}));else if(g==='started'){k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:col,strokeWidth:1.5,fill:'none'}));k.push(E('path',{key:2,d:'M7 3.5a3.5 3.5 0 0 1 0 7z',fill:col}));}else{k.push(E('circle',{key:1,cx:7,cy:7,r:6,fill:col}));}
    return E('svg',{width:14,height:14,viewBox:'0 0 14 14','aria-hidden':true},k);}
  return c.icn?c.icn(n,s):null;};

window.__orbisDlg={D,initState,fieldsOf,
  // 開啟：由各畫面呼叫，只存 key 與參數；欄位狀態在 OrbisDlg 元件內
  open(set,k,x){set({dlg:{k,x:x||{},n:Date.now()}});},
  host(out,s,set,st){out.dlgOpen=!!s.dlg;const d=s.dlg||{};out.dlgK=d.k||'';out.dlgX=d.x||{};out.dlgN=d.n||0;out.dlgSt=st||'normal';out.dlgClose=()=>set({dlg:null});},
  run(c){
  const {out,s,set,ro,icn,C}=c;const Lx=L(c);
  const open=(k,x)=>window.__orbisDlg.open(set,k,x);
  out.openDlg=open;
  const scr=c.p.screen||'views';
  out.bCreate=false;
  const ha=out.headActs||[];const last=ha[ha.length-1];
  if(scr==='views'){
    if(out.tools&&out.tools[0])out.tools[0].opts=out.tools[0].opts.concat([{label:Lx('編輯條件…','Edit conditions…'),on:()=>open('filter'),boxD:'none',bd:'transparent',fill:'transparent',box:null,check:null,bg:'transparent'}]);
    const sel=s.sel||[];
    const VAL={state:[['s1',Lx('待辦','Backlog'),'grp:backlog'],['s2',Lx('就緒','Ready'),'grp:unstarted'],['s4',Lx('進行中','In progress'),'grp:started'],['s6',Lx('完成','Done'),'grp:completed'],['s7',Lx('已取消','Cancelled'),'grp:cancelled']],priority:[['urgent',Lx('緊急','Urgent')],['high',Lx('高','High')],['medium',Lx('中','Medium')],['low',Lx('低','Low')]],assignee:members.map(m=>[m,m,'av:'+m]).concat([['claude-code','claude-code','agent:claude-code'],['codex','codex','agent:codex']]),label:[['bug','bug','tag'],['windows','windows','tag'],['ux','ux','tag']]};
    const KEYS=['state','priority','assignee','label','archive'];
    (out.bulk||[]).forEach((b,i)=>{const k=KEYS[i];b.on=k==='archive'?()=>open('archive',{n:sel.length,after:()=>set({sel:[]})}):()=>open('bulk',{field:k,label:b.label,n:sel.length,opts:VAL[k],after:()=>set({sel:[]})});});}
  window.__orbisDlg.host(out,s,set,c.st);
},
  // ---- 由 OrbisDlg 元件呼叫：把對話框狀態轉成畫面資料 ----
  render(c){
  const {out,s,set,st,icn,C}=c;const Lx=L(c);const t=out.t;
  const d=s.dlg;out.dlgOpen=!!d;if(!d){out.dlg={fields:[],info:[]};return;}
  const sp=D[d.k](c,d.x,Lx);const v=d.v||JSON.parse(JSON.stringify(sp.init||{}));
  const upd=o=>set({dlg:Object.assign({},d,{v:sp.fix?sp.fix(v,o):Object.assign({},v,o),probe:null})});
  const setD=o=>set({dlg:Object.assign({},d,{v},o)});
  const isDone=d.phase==='done'&&!!sp.result;
  const fields=isDone?sp.result(v):fieldsOf(sp,v);
  const errs=sp.validate&&!isDone?sp.validate(v):{};
  const isMissing=f=>f.req&&(f.type==='list'||f.type==='multi'?!(v[f.k]||[]).length:!v[f.k]||(typeof v[f.k]==='string'&&!v[f.k].trim()));
  const missing=isDone?[]:fields.filter(isMissing);
  if(d.tried)missing.forEach(f=>{if(!errs[f.k])errs[f.k]=f.reqMsg||Lx('必填','Required');});
  const dirty=JSON.stringify(v)!==JSON.stringify(sp.init||{});
  const blocked=(c.ro&&!sp.allowRo);
  const sending=d.phase==='sending',loading=d.phase==='loading';
  const close=()=>set({dlg:null});
  const submit=()=>{if(isDone)return close();if(sending||loading)return;if(missing.length||Object.keys(errs).length||blocked)return setD({tried:true});setD({phase:'sending'});
    setTimeout(()=>{if(st==='error'){c.set({dlg:Object.assign({},d,{v,phase:'srv'})});return;}if(sp.result){c.set({dlg:Object.assign({},d,{v,phase:'done'})});if(sp.after)sp.after(v);return;}c.set({dlg:null});if(sp.after)sp.after(v);const m=sp.done?sp.done(v):'';if(m&&c.flash)c.flash(m);},700);};
  const esc=()=>{if(sending)return;if(dirty&&!isDone&&!loading){setD({ask:true});setTimeout(()=>{const b=document.querySelector('[role=alertdialog] button');if(b)b.focus();},30);}else close();};
  const ic=n=>iconOf(c,n,14);
  const days=(m)=>{const a=[];for(let i=0;i<FIRST[m];i++)a.push(null);for(let i=1;i<=LEN[m];i++)a.push(i);return a;};
  const tint={warn:['var(--tint-warn, rgba(217,168,69,.12))',C.warn],bad:['var(--tint-danger, rgba(239,107,98,.1))',C.bad],ok:['var(--tint-success, rgba(79,184,106,.1))',C.ok],acc:['var(--tint-accent-08, rgba(127,176,250,.08))',C.acc],muted:['var(--o1a1b1f)',C.muted]};
  let firstFocus=true;
  const blank={k:'',label:'',hasLabel:false,req:false,isText:false,isArea:false,isPick:false,isDate:false,isSeg:false,isSwitch:false,isMulti:false,isList:false,isRadio:false,isNote:false,isDiff:false,isCode:false,isKv:false,isFile:false,isEditor:false,isReview:false,isPerms:false,isProbe:false,err:'',hasErr:false,hint:'',hasHint:false,focus:false,bd:'var(--o26292e)',value:'',font:'inherit',opts:[],rows:[],lines:[]};
  const F=fields.map((f,fi)=>{const val=v[f.k];const err=errs[f.k];
    const o=Object.assign({},blank,{k:f.k||('f'+fi),label:f.label||'',hasLabel:!!f.label,req:!!f.req,err:err||'',hasErr:!!err,hint:f.hint||'',hasHint:!!f.hint&&!err,bd:err?C.bad:'var(--o26292e)',invalid:err?'true':'false',font:f.mono?MONO:'inherit'});
    o['is'+f.type.charAt(0).toUpperCase()+f.type.slice(1)]=true;
    if(f.type==='text'||f.type==='area'){o.value=val||'';o.ph=f.ph||'';o.focus=firstFocus&&!isDone;firstFocus=false;o.on=e=>upd({[f.k]:e.target.value});}
    if(f.type==='pick'){const opts=typeof f.opts==='function'?f.opts(v):f.opts;const cur=opts.find(x=>x[0]===val);const open=d.pop===f.k;const q=(d.q||'').toLowerCase();
      Object.assign(o,{display:cur?cur[1]:(f.browse||Lx('選擇','Choose')),icon:cur?ic(cur[2]):(f.browse?ic('folder'):null),hasIcon:!!(cur?cur[2]:f.browse),valColor:cur?C.text:C.muted,open,toggle:()=>setD({pop:open?null:f.k,q:''}),hasSearch:!!f.search,q:d.q||'',qph:Lx('搜尋','Search'),onQ:e=>setD({q:e.target.value}),
        opts:opts.filter(x=>!q||String(x[1]).toLowerCase().indexOf(q)>=0).map(x=>({label:x[1],sub:x[3]||'',subColor:C.muted,icon:ic(x[2]),hasIcon:!!x[2],icColor:C.muted,sel:x[0]===val,dis:!!x[4],op:x[4]?0.45:1,tip:x[4]||'',bg:x[0]===val?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',check:x[0]===val?icn('check',14):null,mono:f.mono?MONO:'inherit',on:()=>{if(x[4])return;set({dlg:Object.assign({},d,{v:sp.fix?sp.fix(v,{[f.k]:x[0]}):Object.assign({},v,{[f.k]:x[0]}),pop:null,q:'',probe:null})});}}))});o.noOpts=!o.opts.length;}
    if(f.type==='date'){const m=(d.mon||{})[f.k]||(val?val[0]:10);const open=d.pop===f.k;Object.assign(o,{open,toggle:()=>setD({pop:open?null:f.k}),display:val?(c.lang==='en'?MON[val[0]-1]+' '+val[1]+', 2026':'2026/'+val[0]+'/'+val[1]):Lx('選擇日期','Pick a date'),valColor:val?C.text:C.muted,monTitle:c.lang==='en'?MON[m-1]+' 2026':'2026 年 '+m+' 月',wk:c.lang==='en'?['M','T','W','T','F','S','S']:['一','二','三','四','五','六','日'],
      prev:()=>setD({mon:Object.assign({},d.mon,{[f.k]:Math.max(9,m-1)})}),next:()=>setD({mon:Object.assign({},d.mon,{[f.k]:Math.min(12,m+1)})}),
      days:days(m).map(n=>{const sel=val&&val[0]===m&&val[1]===n;const today=m===10&&n===25;return {n:n||'',vis:n?'visible':'hidden',bg:sel?C.acc:'transparent',color:sel?'var(--obtnfg)':(today?C.acc:C.text),fw:today||sel?550:400,on:()=>{if(n)set({dlg:Object.assign({},d,{v:Object.assign({},v,{[f.k]:[m,n]}),pop:null})});}};}),
      quick:[[Lx('今天','Today'),[10,25]],[Lx('明天','Tomorrow'),[10,26]],[Lx('下週一','Next Monday'),[10,27]],[Lx('清除','Clear'),null]].map(([label,dv])=>({label,on:()=>set({dlg:Object.assign({},d,{v:Object.assign({},v,{[f.k]:dv}),pop:null})})}))});}
    if(f.type==='seg')o.opts=f.opts.map(x=>({label:x[1],icon:ic(x[2]),sel:x[0]===val,dis:!!x[3],op:x[3]?0.45:1,tip:x[3]||'',bg:x[0]===val?'var(--o2a2d33)':'transparent',color:x[0]===val?C.text:C.muted,ring:x[0]===val&&String(x[2]||'').indexOf('dot:')===0?'inset 0 0 0 1px var(--oe8e9eb)':'none',aria:x[1]||x[0],on:()=>{if(!x[3])upd({[f.k]:x[0]});}}));
    if(f.type==='radio')o.opts=f.opts.map(x=>({label:x[1],sub:x[2]||'',hasSub:!!x[2],sel:x[0]===val,dis:!!x[3],op:x[3]?0.45:1,tip:x[3]||'',bg:x[0]===val?'var(--o1c1e22)':'transparent',bdc:x[0]===val?C.acc:'var(--o3d4047)',dot:x[0]===val?C.acc:'transparent',on:()=>{if(!x[3])upd({[f.k]:x[0]});}}));
    if(f.type==='switch')Object.assign(o,{value:!!val,swLabel:f.swLabel,swBg:val?C.acc:'var(--o3d4047)',swKnob:val?'14px':'2px',on:()=>upd({[f.k]:!val})});
    if(f.type==='multi'){const arr=val||[];o.opts=f.opts.map(x=>{const on=arr.indexOf(x[0])>=0;return {label:x[1],icon:on?icn('check',12):ic(x[2]),sel:on,bg:on?'var(--tint-accent-12, rgba(127,176,250,.12))':'var(--o1c1e22)',ring:on?'inset 0 0 0 1px var(--o7fb0fa)':(err?'inset 0 0 0 1px var(--oef6b62)':'none'),on:()=>upd({[f.k]:on?arr.filter(y=>y!==x[0]):arr.concat([x[0]])})};});}
    if(f.type==='list'){const arr=val||[];const max=f.max||99,min=f.min||0;o.addLabel=f.addLabel;o.add=()=>{if(arr.length<max)upd({[f.k]:arr.concat([Object.assign({},f.blank)])});};o.addOp=arr.length>=max?0.45:1;o.addDis=arr.length>=max;
      o.rows=arr.map((r,ri)=>({remove:()=>{if(arr.length>min)upd({[f.k]:arr.filter((_,y)=>y!==ri)});},rmOp:arr.length>min?1:0.35,rmDis:arr.length<=min,cells:f.cells.map(cl=>{const setC=nv=>upd({[f.k]:arr.map((rr,y)=>y===ri?Object.assign({},rr,{[cl.k]:nv}):rr)});
        if(cl.type==='in')return {isIn:true,isSel:false,isPk:false,value:r[cl.k]||'',ph:cl.ph,bd:(err&&!(r[cl.k]||'').trim())?C.bad:'var(--o26292e)',on:e=>setC(e.target.value)};
        const copts=typeof cl.opts==='function'?cl.opts(r):cl.opts;
        if(cl.type==='pk'){const pk=f.k+':'+ri+':'+cl.k;const open=d.pop===pk;const cur=copts.find(x=>x[0]===r[cl.k]);return {isIn:false,isSel:false,isPk:true,label:cur?cur[1]:Lx('選擇','Choose'),icon:cur?ic(cur[2]):null,hasIcon:!!(cur&&cur[2]),open,toggle:()=>setD({pop:open?null:pk}),opts:copts.map(x=>({label:x[1],icon:ic(x[2]),hasIcon:!!x[2],sel:x[0]===r[cl.k],bg:x[0]===r[cl.k]?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',check:x[0]===r[cl.k]?icn('check',14):null,on:()=>{const nr=arr.map((rr,y)=>y===ri?Object.assign({},rr,{[cl.k]:x[0]}):rr);set({dlg:Object.assign({},d,{v:sp.fix?sp.fix(v,{[f.k]:nr}):Object.assign({},v,{[f.k]:nr}),pop:null})});}}))};}
        return {isIn:false,isSel:true,isPk:false,opts:copts.map(x=>({label:x[1],bg:r[cl.k]===x[0]?'var(--o2a2d33)':'transparent',color:r[cl.k]===x[0]?C.text:C.muted,on:()=>setC(x[0])}))};})}));}
    if(f.type==='note'){const tt=tint[f.tone||'muted'];Object.assign(o,{text:f.text,icon:ic(f.icon||'alert'),nbg:tt[0],icColor:tt[1]});}
    if(f.type==='diff')o.lines=f.lines.map(([k,text])=>({text:(k==='+'?'+ ':k==='-'?'- ':'  ')+text,color:k==='+'?C.ok:k==='-'?C.bad:C.text,bg:k==='+'?'var(--tint-success, rgba(79,184,106,.1))':k==='-'?'var(--tint-danger, rgba(239,107,98,.1))':'transparent'}));
    if(f.type==='code'){o.lines=f.lines.map(text=>({text,color:C.text,bg:'transparent'}));o.hasCopy=!!f.copy;o.copyLabel=d.copied?Lx('已複製','Copied'):Lx('複製','Copy');o.copyIcon=icn(d.copied?'check':'copy',13);o.copy=()=>{try{navigator.clipboard&&navigator.clipboard.writeText(f.lines.join('\n'));}catch(e){}setD({copied:true});setTimeout(()=>c.set({dlg:Object.assign({},c.getD(),{copied:false})}),1600);};}
    if(f.type==='kv')o.rows=f.rows.map(([k,vv])=>({k,v:vv}));
    if(f.type==='file'){Object.assign(o,{has:!!val,none:!val,value:val||'',size:f.size||'',ph:f.ph,accept:f.accept,choose:f.choose,removeLabel:Lx('移除','Remove'),fileIc:icn('file',14),upIc:icn('upload',18),pick:()=>upd({[f.k]:f.sample}),remove:()=>upd({[f.k]:''}),dz:err?C.bad:'var(--o34373d)'});}
    if(f.type==='editor'){const ed=val||{sel:'SKILL.md',files:{}};const names=Object.keys(ed.files);Object.assign(o,{tree:names.map(n=>({label:n,ind:(n.indexOf('/')>0?18:6)+'px',bg:n===ed.sel?'var(--osel)':'transparent',warn:n==='SKILL.md'&&!!err,icon:icn('file',13),on:()=>upd({[f.k]:Object.assign({},ed,{sel:n})})})),cur:ed.files[ed.sel]||'',curName:ed.sel,onEd:e=>upd({[f.k]:Object.assign({},ed,{files:Object.assign({},ed.files,{[ed.sel]:e.target.value})})}),
      addLabel:f.addLabel,add:()=>{if(ed.files[f.newName]!==undefined)return;upd({[f.k]:{sel:f.newName,files:Object.assign({},ed.files,{[f.newName]:''})}});},edBd:err&&ed.sel==='SKILL.md'?C.bad:'var(--o26292e)',okText:Lx('名稱與描述符合規則','Name and description look good'),isOk:!err&&ed.sel==='SKILL.md',okIc:icn('check',12)});}
    if(f.type==='perms'){const rows=val||[];const L2=f.levels;Object.assign(o,{addLabel:f.addLabel,open:d.pop===f.k,toggle:()=>setD({pop:d.pop===f.k?null:f.k}),
      cands:f.cands.filter(x=>!rows.some(r=>r.id===x[0])).map(x=>({label:x[1],icon:ic(x[2]),on:()=>set({dlg:Object.assign({},d,{v:Object.assign({},v,{[f.k]:rows.concat([{id:x[0],label:x[1],kind:x[3],lvl:'view',inh:false,over:false}])}),pop:null})})})),
      rows:rows.map((r,ri)=>{const setR=p=>upd({[f.k]:rows.map((y,j)=>j===ri?Object.assign({},y,p):y)});const locked=r.inh&&!r.over;
        return {label:r.label,icon:r.kind==='member'?ic('av:'+r.id):ic('users'),sub:r.inh?f.inhLabel+r.from:'',hasSub:r.inh,locked,editable:!locked,lockLabel:(L2.find(l=>l[0]===r.lvl)||[])[1],
          act:r.inh?(r.over?f.resetLabel:f.overLabel):Lx('移除','Remove'),actColor:r.inh?C.text:C.muted,onAct:()=>{if(r.inh)setR({over:!r.over});else upd({[f.k]:rows.filter((_,j)=>j!==ri)});},
          levels:L2.map(l=>({label:l[1],bg:r.lvl===l[0]?'var(--o2a2d33)':'transparent',color:r.lvl===l[0]?C.text:C.muted,on:()=>setR({lvl:l[0]})}))};})});o.noCands=!o.cands.length;}
    if(f.type==='probe'){o.hasLabel=false;const pr=d.probe;const need=f.need&&!v[f.need];Object.assign(o,{label:f.label,dis:need||pr==='run',op:need?0.45:1,running:pr==='run',has:!!pr&&pr!=='run',msg:pr&&pr.msg||'',msgColor:pr&&pr.ok?C.ok:C.bad,msgIc:pr&&pr!=='run'?icn(pr.ok?'check':'alert',13):null,
      on:()=>{setD({probe:'run'});setTimeout(()=>{const cur=c.getD();if(cur&&cur.probe==='run')c.set({dlg:Object.assign({},cur,{probe:f.run(cur.v||v)})});},900);}});}
    return o;});
  const bad=missing.length>0||Object.keys(errs).length>0||blocked;
  const subLabel=isDone?Lx('完成','Done'):sending?Lx('送出中','Saving'):(sp.submitOf?sp.submitOf(v):sp.submit);
  out.dlg={title:sp.title,w:sp.w,fields:loading?[]:F,info:loading||isDone?[]:(sp.info||[]).map(l=>Object.assign({},l,{icon:ic(l.icon),hasIcon:!!l.icon,icColor:l.icColor||C.muted,color:C.text,meta:l.meta||'',font:l.font||'inherit'})),srvErr:d.phase==='srv',srvErrText:Lx('伺服器沒有回應，請再試一次','The server didn’t respond. Try again.'),sending,
    loading,loadText:loading?sp.loading.text:'',hasCancel:!isDone,
    subLabel,subDis:!isDone&&(bad||sending||loading),subOp:!isDone&&(bad||loading)?0.45:1,subBg:sp.danger&&!isDone?'var(--tint-danger, rgba(239,107,98,.1))':'var(--obtn)',subColor:sp.danger&&!isDone?C.bad:'var(--obtnfg)',askClose:!!d.ask};
  Object.assign(out,{dlgSubmit:submit,dlgEsc:esc,dlgScrim:esc,dlgKeep:()=>{setD({ask:false});},dlgClose:close,dlgKey:e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();submit();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(d.pop)setD({pop:null});else if(d.ask)setD({ask:false});else esc();}}});
  Object.assign(t,c.lang==='en'?{discardQ:'Discard unsaved changes?',keepEditing:'Keep editing',discard:'Discard',removeRow:'Remove',cancel:'Cancel',noMatch:'No matches',prev:'Previous month',next:'Next month',close:'Close'}:{discardQ:'要捨棄未儲存的修改嗎？',keepEditing:'繼續編輯',discard:'捨棄',removeRow:'移除',cancel:'取消',noMatch:'沒有符合的項目',prev:'上個月',next:'下個月',close:'關閉'});
},
  // ---- 畫廊：所有視窗與可強制的狀態 ----
  catalog(lang){const Lx=lang==='en'?(a,b)=>b:(a,b)=>a;const S=(t,ks)=>({title:t,items:ks.map(k=>Array.isArray(k)?{k:k[0],x:k[1]||{},label:k[2]}:{k,x:{},label:''})});
    return [S(Lx('專案管理','Project management'),['filter',['bulk',{field:'state',n:3}],['archive',{n:3}],'relation','epicLink',['archiveTask',{}],['archiveTask',{restore:true},Lx('還原','Restore')],'assignAgent',['assignAgent',{auto:true},Lx('自動派工','Auto-dispatch')],'dispatch',['pickRun',{}],'tpl',['delTpl',{}]]),
      S(Lx('報告','Reports'),['saveWiki','regen']),
      S(Lx('對話','Conversations'),['commit','pushPR','mergeLocal',['discard',{}],['discard',{revert:true},Lx('還原修改','Revert')],'convTask','shareConv']),
      S('Wiki',['wikiMove',['wikiDelete',{}],'wikiProp','wikiView','wikiRestore','wikiExport',['propDecline',{}],'wikiSpec']),
      S(Lx('技能','Skills'),['skillNew','skillVersion','skillEdit',['skillEdit',{loading:true},Lx('從執行整理','From a run')],'skillAdd','skillUpdate','skillSubmit']),
      S(Lx('其他','More'),[['archiveWt',{}],'auditExport'])];}
};
})();
