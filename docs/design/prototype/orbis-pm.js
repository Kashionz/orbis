(function(){
const E=(...a)=>React.createElement(...a);
const P={sliders:[['p','M21 4h-7'],['p','M10 4H3'],['p','M21 12h-9'],['p','M8 12H3'],['p','M21 20h-5'],['p','M12 20H3'],['p','M14 2v4'],['p','M8 10v4'],['p','M16 18v4']],kanban:[['r',3,3,18,18,2],['p','M9 3v18'],['p','M15 3v18']],gantt:[['p','M8 6h10'],['p','M6 12h9'],['p','M11 18h7']],folderOpen:[['p','m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2']],bold:[['p','M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8']],italic:[['p','M19 4h-9'],['p','M14 20H5'],['p','M15 4 9 20']],underline:[['p','M6 4v6a6 6 0 0 0 12 0V4'],['p','M4 20h16']],strike:[['p','M16 4H9a3 3 0 0 0-2.83 4'],['p','M14 12a4 4 0 0 1 0 8H6'],['p','M4 12h16']],listUl:[['p','M3 12h.01'],['p','M3 18h.01'],['p','M3 6h.01'],['p','M8 12h13'],['p','M8 18h13'],['p','M8 6h13']],listOl:[['p','M10 12h11'],['p','M10 18h11'],['p','M10 6h11'],['p','M4 10h2'],['p','M4 6h1v4'],['p','M6 18H4c0-1 2-2 2-3s-1-1.5-2-1']],checkSq:[['r',3,3,18,18,2],['p','m9 12 2 2 4-4']],quote:[['p','M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z'],['p','M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z']],code:[['p','m16 18 6-6-6-6'],['p','m8 6-6 6 6 6']],table:[['r',3,3,18,18,2],['p','M3 9h18'],['p','M3 15h18'],['p','M12 3v18']],image:[['r',3,3,18,18,2],['c',9,9,2],['p','m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21']],star:[['p','M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z']],chevL:[['p','m15 18-6-6 6-6']],filePlus:[['p','M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'],['p','M14 2v4a2 2 0 0 0 2 2h4'],['p','M9 15h6'],['p','M12 18v-6']],arrowUp:[['p','m5 12 7-7 7 7'],['p','M12 19V5']],chevR:[['p','m9 18 6-6-6-6']],gitCommit:[['c',12,12,3],['p','M3 12h6'],['p','M15 12h6']],gitPR:[['c',18,18,3],['c',6,6,3],['p','M13 6h3a2 2 0 0 1 2 2v7'],['p','M6 9v12']],gitMerge:[['c',18,18,3],['c',6,6,3],['p','M6 21V9a9 9 0 0 0 9 9']],folder:[['p','M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z']],upload:[['p','M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],['p','m17 8-5-5-5 5'],['p','M12 3v12']],download:[['p','M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],['p','m7 10 5 5 5-5'],['p','M12 15V3']],git:[['p','M6 3v12'],['c',18,6,3],['c',6,18,3],['p','M18 9a9 9 0 0 1-9 9']],users:[['p','M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'],['c',9,7,4],['p','M22 21v-2a4 4 0 0 0-3-3.87'],['p','M16 3.13a4 4 0 0 1 0 7.75']],globe:[['c',12,12,10],['p','M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'],['p','M2 12h20']],more:[['c',5,12,1],['c',12,12,1],['c',19,12,1]],key:[['c',7.5,15.5,5.5],['p','m21 2-9.6 9.6'],['p','m15.5 7.5 3 3L22 7l-3-3']],check:[['p','M20 6 9 17l-5-5']],chevD:[['p','m6 9 6 6 6-6']],plus:[['p','M5 12h14'],['p','M12 5v14']],x:[['p','M18 6 6 18'],['p','m6 6 12 12']],alert:[['c',12,12,10],['p','M12 8v4'],['p','M12 16h.01']],rotate:[['p','M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'],['p','M3 3v5h5']],lock:[['r',3,11,18,11,2],['p','M7 11V7a5 5 0 0 1 10 0v4']],archive:[['r',2,3,20,5,1],['p','M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8'],['p','M10 12h4']],filter:[['p','M22 3H2l8 9.46V19l4 2v-8.54L22 3z']],layers:[['p','m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z'],['p','m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65'],['p','m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65']],sort:[['p','m21 16-4 4-4-4'],['p','M17 20V4'],['p','m3 8 4-4 4 4'],['p','M7 4v16']],eye:[['p','M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0'],['c',12,12,3]],search:[['c',11,11,8],['p','m21 21-4.3-4.3']],issue:[['c',12,12,10],['c',12,12,1.5]],bot:[['r',3,11,18,10,2],['c',12,5,2],['p','M12 7v4'],['p','M8 16h.01'],['p','M16 16h.01']],user:[['c',12,8,4],['p','M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2']],clock:[['c',12,12,10],['p','M12 6v6l4 2']],copy:[['r',8,8,14,14,2],['p','M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2']],file:[['p','M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'],['p','M14 2v4a2 2 0 0 0 2 2h4'],['p','M16 13H8'],['p','M16 17H8']],msg:[['p','M7.9 20A9 9 0 1 0 4 16.1L2 22Z']],book:[['p','M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20']],zap:[['p','M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z']],play:[['p','m6 3 14 9-14 9z']],cycle:[['p','M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'],['p','M3 3v5h5'],['p','M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16'],['p','M16 16h5v5']],box:[['p','M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'],['p','M3.3 7 12 12l8.7-5'],['p','M12 22V12']],tag:[['p','M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z']],cal:[['r',3,4,18,18,2],['p','M16 2v4'],['p','M8 2v4'],['p','M3 10h18']],pencil:[['p','M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z']],trash:[['p','M3 6h18'],['p','M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'],['p','M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']],server:[['r',2,2,20,8,2],['r',2,14,20,8,2],['p','M6 6h.01'],['p','M6 18h.01']],monitor:[['r',2,3,20,14,2],['p','M8 21h8'],['p','M12 17v4']],shield:[['p','M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z']],gauge:[['p','m12 14 4-4'],['p','M3.34 19a10 10 0 1 1 17.32 0']],link:[['p','M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'],['p','M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']]};
window.__orbisIcn=(n,s)=>icn(n,s);
function icn(n,s){s=s||14;return E('svg',{width:s,height:s,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.75,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},(P[n]||[]).map((e,i)=>e[0]==='p'?E('path',{key:i,d:e[1]}):e[0]==='c'?E('circle',{key:i,cx:e[1],cy:e[2],r:e[3]}):E('rect',{key:i,x:e[1],y:e[2],width:e[3],height:e[4],rx:e[5]})));}
function sIcon(g,c,s){s=s||14;const k=[];
  if(g==='unstarted')k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:c,strokeWidth:1.5,fill:'none'}));
  else if(g==='started'){k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:c,strokeWidth:1.5,fill:'none'}));k.push(E('path',{key:2,d:'M7 3.5a3.5 3.5 0 0 1 0 7z',fill:c}));}
  else if(g==='completed'){k.push(E('circle',{key:1,cx:7,cy:7,r:6,fill:c}));k.push(E('path',{key:2,d:'m4.5 7 1.8 1.8L9.6 5.4',stroke:'var(--o16171a)',strokeWidth:1.5,fill:'none',strokeLinecap:'round',strokeLinejoin:'round'}));}
  else if(g==='backlog')k.push(E('circle',{key:1,cx:7,cy:7,r:5.5,stroke:c,strokeWidth:1.5,strokeDasharray:'2 2',fill:'none'}));
  else {k.push(E('circle',{key:1,cx:7,cy:7,r:6,fill:c}));k.push(E('path',{key:2,d:'M5 5l4 4M9 5l-4 4',stroke:'var(--o16171a)',strokeWidth:1.5,strokeLinecap:'round'}));}
  return E('svg',{width:s,height:s,viewBox:'0 0 14 14','aria-hidden':true},k);}
function pIcon(l){if(l==='urgent')return E('svg',{width:14,height:14,viewBox:'0 0 14 14','aria-hidden':true},[E('rect',{key:1,x:1,y:1,width:12,height:12,rx:3,fill:'var(--oef6b62)'}),E('path',{key:2,d:'M7 4v3.5M7 10h.01',stroke:'var(--o16171a)',strokeWidth:1.6,strokeLinecap:'round'})]);
  const n={high:3,medium:2,low:1}[l]||0;return E('svg',{width:14,height:14,viewBox:'0 0 14 14','aria-hidden':true},[[2,8,3],[6,5,6],[10,2,9]].map((b,i)=>E('rect',{key:i,x:b[0],y:b[1]+2,width:2.5,height:b[2],rx:1,fill:i<n?'var(--oe8e9eb)':'var(--o3d4047)'})));}
const dot=(c,sz)=>E('span',{style:{width:sz||7,height:sz||7,borderRadius:'50%',background:c,display:'block',flex:'none'}});
const logo=(a,s)=>E('img',{src:'assets/agents/'+a+'.svg',width:s||16,height:s||16,alt:'',style:{borderRadius:'50%',display:'block'}});
const AVC={kashionz:['K','var(--o3a3e46)'],'mei-lin':['M','var(--o4a3e52)'],'chen-yu':['C','var(--o3b4d45)'],octocat:['O','var(--o22242a)']};
const av=(w,s)=>{s=s||16;const a=AVC[w];return E('span',{style:{width:s,height:s,borderRadius:'50%',background:a?a[1]:'transparent',border:a?'none':'1px dashed var(--o4c5058)',boxSizing:'border-box',display:'grid',placeItems:'center',fontSize:s<18?9:10,flex:'none',color:'var(--oe8e9eb)'}},a?a[0]:'');};
const C={muted:'var(--o8b9098)',faint:'var(--o4c5058)',warn:'var(--od9a845)',acc:'var(--o7fb0fa)',ok:'var(--o4fb86a)',bad:'var(--oef6b62)',text:'var(--oe8e9eb)'};
const ST={s1:['backlog',C.faint],s2:['unstarted',C.muted],s4:['started',C.warn],s6:['completed',C.ok],s7:['cancelled',C.bad]};
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const IDX=(d)=>!d?null:(d[0]===9?d[1]-28:d[0]===10?d[1]+2:d[1]+33);
const FROM=(i)=>i<3?[9,28+i]:i<34?[10,i-2]:[11,i-33];
const TK0=[['ORB-42','s4','high','kashionz','claude-code',[10,21],[10,28],3,0,0,'verifying'],['ORB-38','s4','urgent','mei-lin','codex',[10,19],[10,26],5,0,0,'review_gate'],['ORB-47','s4','medium','chen-yu','claude-code',[10,23],[11,2],8,0,2,'plan_gate'],['ORB-51','s4','medium','kashionz','claude-code',[10,24],null,2,0,0,'running'],['ORB-36','s4','high','chen-yu','codex',[10,14],[10,25],3,0,1,'pr'],['ORB-45','s2','low','mei-lin','',[10,29],[11,8],2,1,1,''],['ORB-53','s1','none','','',null,null,0,1,2,''],['ORB-30','s6','medium','kashionz','',[10,8],[10,18],3,-1,0,''],['ORB-29','s6','low','chen-yu','',[10,1],[10,9],1,-1,0,'',true],['ORB-60','s4','high','mei-lin','',[10,12],[11,20],31,0,0,'',false,true]];
const LINKS=[['ORB-36','ORB-45'],['ORB-42','ORB-47']];
const T={
zh:{stateLabel:'原型狀態',states:['一般','空的','載入中','錯誤','唯讀','窄寬度'],loadFail:'載入失敗',retry:'重試',cancel:'取消',
heads:{dashexport:'匯出報告',views:'',mywork:'我的工作',intake:'收件匣',types:'任務類型與欄位',epic:'帳務重構',assign:'負責人',dashboard:'儀表板',palette:'',templates:'範本'},
empty:{views:'沒有符合的任務',mywork:'沒有指派給你的任務',intake:'收件匣是空的',epic:'還沒有子任務',assign:'未指派',dashboard:'還沒有資料',palette:'沒有符合的結果',templates:'還沒有範本',types:'還沒有自訂欄位'},
emptyAct:{views:'新增任務',intake:'提出需求',epic:'新增子任務',templates:'新增範本',types:'新增欄位'},
newTask:'新增任務',showArchived:'已封存',allProjects:'所有專案',tabsL:[['views','任務'],['dashboard','儀表板']],dtabs:[['overview','概覽'],['reports','報告']],selAll:'全選',clearSel:'取消選取',selected:'已選 {n} 個',updated:'已更新 {n} 個任務',
views:[['v1','所有任務'],['v2','我的任務'],['v3','本週到期']],
layouts:[['list','列表'],['cols','分欄'],['table','表格'],['cal','月曆'],['tl','時間軸']],
tool:{filter:'篩選',group:'分組',sort:'排序',display:'顯示'},matchAll:'全部符合',matchAny:'任一符合',
filters:[['mine','指派給我'],['high','優先度高以上'],['week','本週到期'],['stage','有代理階段'],['blocked','被封鎖']],
groupBy:[['state','狀態'],['stage','代理階段']],sortBy:[['manual','手動'],['priority','優先度'],['due','截止日'],['updated','更新時間']],asc:'遞增',desc:'遞減',
cols:{state:'狀態',priority:'優先度',assignee:'負責人',due:'截止日'},
key:'編號',title:'標題',stN:{s1:'待辦',s2:'就緒',s4:'進行中',s6:'完成',s7:'已取消'},priL:{urgent:'緊急',high:'高',medium:'中',low:'低',none:'無'},
none:'無',unset:'未設定',pts:'{n} 點',
bulk:[['state','狀態'],['priority','優先度'],['assignee','負責人'],['label','標籤'],['archive','封存']],
week:['一','二','三','四','五','六','日'],calTitle:'2026 年 10 月',today:'今天',prev:'上個月',next:'下個月',noDate:'沒有日期',taskTitle:'任務標題',created:'已建立 {k}',moved:'{k} 改到 {d}',
zoom:[['w','週'],['m','月'],['q','季']],
titles:{'ORB-42':'修正 Windows 上的換行測試','ORB-38':'發票按比例計算','ORB-47':'通知改成推送','ORB-51':'匯出 CSV 的編碼','ORB-36':'執行器長路徑支援','ORB-45':'看板拖曳排序','ORB-53':'通知中心分組','ORB-30':'登入頁改版','ORB-29':'移除舊版設定頁','ORB-40':'換行設定文件','WEB-12':'行銷頁改版','ORB-61':'發票 PDF 版面','ORB-62':'退款流程','ORB-63':'稅率表更新','ORB-60':'帳務重構'},
my:{today:'今天到期',week:'本週',later:'之後',nodate:'沒有日期'},
actual:'實際',ideal:'理想',
modSt:{active:'進行中',plan:'規劃中',done:'已完成'},modLinks:'儲存庫規格',wiki:'Wiki',
src:{github:'GitHub Issue',agent:'代理草稿',member:'成員提出'},accept:'接受',reject:'拒絕',dup:'重複',snooze:'延後',acceptTo:'接受並設為',dupOf:'和哪個任務重複',snoozeTo:'延後到',snz:[['tmr','明天'],['mon','下週一'],['month','下個月']],request:'提出需求',
done:{accept:'已接受',reject:'已拒絕',dup:'已標成重複',snooze:'已延後'},
types:{types:'任務類型',fields:'自訂欄位',noDispatch:'不能派工'},typeN:['功能','錯誤','雜項','大型任務'],kinds:[['text','文字'],['number','數字'],['single','單選'],['multi','多選'],['date','日期'],['member','成員'],['bool','是否']],required:'必填',fieldName:'欄位名稱',addField:'新增欄位',nameTaken:'名稱已存在',appliesTo:'套用到 {t}',allTypes:'所有類型',
epicChip:'大型任務',dispatch:'派工',epicNo:'大型任務不能派工，請派工子任務',epicSt:[['子任務',''],['已完成',''],['估計總和','']],
asg:{where:'在哪裡跑',model:'模型',effort:'推理強度',policy:'權限策略'},local:'我的電腦',team:'團隊執行器',efforts:[['fast','快速'],['std','標準'],['deep','深度']],policies:[['yolo','全部允許'],['auto','自動'],['manual','逐一確認']],teamNoYolo:'團隊執行器不能全部允許',waitDep:'等待 ORB-40 完成',readyNow:'條件已滿足',autoDispatch:'相依完成後自動派工',
dash:{state:'依狀態群組的進度',load:'每人的工作量',blocked:'被卡住的任務',usage:'代理用量與費用'},grp:{unstarted:'未開始',started:'進行中',completed:'已完成',cancelled:'已取消'},items:'{n} 項',blockedBy:'被 {k} 封鎖',usageBy:[['agent','代理'],['member','成員'],['project','專案']],range:[['7','7 天'],['30','30 天']],
palPh:'搜尋或輸入指令',palMove:'選擇',palOpen:'開啟',noMatch:'沒有符合的結果',pg:{task:'任務',run:'執行',conv:'對話',comment:'留言',wiki:'Wiki 頁',skill:'技能',action:'動作'},
pAct:[['新增任務','Ctrl N'],['開新對話',''],['切換專案',''],['開啟設定','Ctrl ,']],opened:'開啟 {x}',
tpl:{task:'任務範本',prompt:'Prompt 範本'},openEpic:'開啟大型任務',cf:{tplName:'範本名稱',kind:'種類',scope:'範圍',create:'建立',created:'已建立'},shared:'共用',personal:'個人',edit:'編輯',dupT:'複製',del:'刪除',newTpl:'新增範本',roTip:'只能檢視'},
en:{stateLabel:'Prototype state',states:['Default','Empty','Loading','Error','Read-only','Narrow'],loadFail:'Couldn’t load',retry:'Retry',cancel:'Cancel',
heads:{dashexport:'Export report',views:'',mywork:'My work',intake:'Intake',types:'Task types and fields',epic:'Billing rework',assign:'Assignee',dashboard:'Dashboard',palette:'',templates:'Templates'},
empty:{views:'No matching tasks',mywork:'Nothing assigned to you',intake:'Intake is empty',epic:'No sub-tasks yet',assign:'Unassigned',dashboard:'No data yet',palette:'No matching results',templates:'No templates yet',types:'No custom fields yet'},
emptyAct:{views:'New task',intake:'Submit a request',epic:'Add sub-task',templates:'New template',types:'Add field'},
newTask:'New task',showArchived:'Archived',allProjects:'All projects',tabsL:[['views','Tasks'],['dashboard','Dashboard']],dtabs:[['overview','Overview'],['reports','Reports']],selAll:'Select all',clearSel:'Clear selection',selected:'{n} selected',updated:'Updated {n} tasks',
views:[['v1','All tasks'],['v2','My tasks'],['v3','Due this week']],
layouts:[['list','List'],['cols','Columns'],['table','Table'],['cal','Calendar'],['tl','Timeline']],
tool:{filter:'Filter',group:'Group',sort:'Sort',display:'Display'},matchAll:'Match all',matchAny:'Match any',
filters:[['mine','Assigned to me'],['high','High priority or above'],['week','Due this week'],['stage','Has agent stage'],['blocked','Blocked']],
groupBy:[['state','State'],['stage','Agent stage']],sortBy:[['manual','Manual'],['priority','Priority'],['due','Due date'],['updated','Updated']],asc:'Ascending',desc:'Descending',
cols:{state:'State',priority:'Priority',assignee:'Assignee',due:'Due'},
key:'ID',title:'Title',stN:{s1:'Backlog',s2:'Ready',s4:'In progress',s6:'Done',s7:'Cancelled'},priL:{urgent:'Urgent',high:'High',medium:'Medium',low:'Low',none:'None'},
none:'None',unset:'Not set',pts:'{n} pts',
bulk:[['state','State'],['priority','Priority'],['assignee','Assignee'],['label','Labels'],['archive','Archive']],
week:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],calTitle:'October 2026',today:'Today',prev:'Previous month',next:'Next month',noDate:'No date',taskTitle:'Task title',created:'Created {k}',moved:'{k} moved to {d}',
zoom:[['w','Week'],['m','Month'],['q','Quarter']],
titles:{'ORB-42':'Fix line-ending tests on Windows','ORB-38':'Prorated invoices','ORB-47':'Switch notifications to push','ORB-51':'CSV export encoding','ORB-36':'Long path support on runners','ORB-45':'Drag to reorder on the board','ORB-53':'Group notifications in the inbox','ORB-30':'Login page refresh','ORB-29':'Remove the legacy settings page','ORB-40':'Line-ending settings doc','WEB-12':'Marketing page refresh','ORB-61':'Invoice PDF layout','ORB-62':'Refund flow','ORB-63':'Tax table update','ORB-60':'Billing rework'},
my:{today:'Due today',week:'This week',later:'Later',nodate:'No date'},
actual:'Actual',ideal:'Ideal',
modSt:{active:'Active',plan:'Planned',done:'Completed'},modLinks:'Repo spec',wiki:'Wiki',
src:{github:'GitHub issue',agent:'Agent draft',member:'Member request'},accept:'Accept',reject:'Decline',dup:'Duplicate',snooze:'Snooze',acceptTo:'Accept as',dupOf:'Duplicate of',snoozeTo:'Snooze until',snz:[['tmr','Tomorrow'],['mon','Next Monday'],['month','Next month']],request:'Submit a request',
done:{accept:'Accepted',reject:'Declined',dup:'Marked as duplicate',snooze:'Snoozed'},
types:{types:'Task types',fields:'Custom fields',noDispatch:'Can’t be dispatched'},typeN:['Feature','Bug','Chore','Epic'],kinds:[['text','Text'],['number','Number'],['single','Single select'],['multi','Multi select'],['date','Date'],['member','Member'],['bool','Yes or no']],required:'Required',fieldName:'Field name',addField:'Add field',nameTaken:'That name is already used',appliesTo:'Applies to {t}',allTypes:'all types',
epicChip:'Epic',dispatch:'Dispatch',epicNo:'Epics can’t be dispatched; dispatch their sub-tasks',epicSt:[['Sub-tasks',''],['Done',''],['Total estimate','']],
asg:{where:'Runs on',model:'Model',effort:'Reasoning effort',policy:'Permission policy'},local:'My computer',team:'Team runner',efforts:[['fast','Fast'],['std','Standard'],['deep','Deep']],policies:[['yolo','Allow all'],['auto','Auto'],['manual','Ask each time']],teamNoYolo:'Team runners can’t use Allow all',waitDep:'Waiting for ORB-40',readyNow:'Ready to dispatch',autoDispatch:'Dispatch when dependencies are done',
dash:{state:'Progress by state group',load:'Workload per person',blocked:'Blocked tasks',usage:'Agent usage and cost'},grp:{unstarted:'Unstarted',started:'Started',completed:'Completed',cancelled:'Cancelled'},items:'{n} items',blockedBy:'Blocked by {k}',usageBy:[['agent','Agent'],['member','Member'],['project','Project']],range:[['7','7 days'],['30','30 days']],
palPh:'Search or type a command',palMove:'Select',palOpen:'Open',noMatch:'No matching results',pg:{task:'Tasks',run:'Runs',conv:'Conversations',comment:'Comments',wiki:'Wiki pages',skill:'Skills',action:'Actions'},
pAct:[['New task','Ctrl N'],['New conversation',''],['Switch project',''],['Open settings','Ctrl ,']],opened:'Opened {x}',
tpl:{task:'Task templates',prompt:'Prompt templates'},openEpic:'Open epic',cf:{tplName:'Template name',kind:'Kind',scope:'Scope',create:'Create',created:'Created'},shared:'Shared',personal:'Personal',edit:'Edit',dupT:'Duplicate',del:'Delete',newTpl:'New template',roTip:'View only'}};
const fmt=(s,o)=>s.replace(/\{(\w+)\}/g,(m,k)=>o[k]);
const STS=['normal','empty','loading','error','readonly','narrow'];
const segOf=(opts,cur,set)=>opts.map(([v,label])=>({label,bg:v===cur?'var(--o2a2d33)':'transparent',color:v===cur?C.text:C.muted,on:()=>set(v)}));
const optOf=(label,sel,on,icon,icColor)=>({label,sel,on,icon:icon||null,icColor:icColor||C.muted,bg:sel?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',check:sel?icn('check',14):null});
const chip=(label,o)=>Object.assign({label,icon:null,color:C.muted,bg:'transparent',pad:'0'},o||{});
const pill=(label,o)=>chip(label,Object.assign({bg:'var(--o1c1e22)',pad:'0 6px'},o||{}));
window.__orbisPM=function(cmp){
  const s=cmp.state,p=cmp.props,set=x=>cmp.setState(x);
  const lang=p.lang==='en'?'en':'zh',t=T[lang],screen=p.screen||'views',embed=p.embed||'page';
  const st=s.st||p.state||'normal',ro=st==='readonly',narrow=st==='narrow',isEmptyState=st==='empty';
  const flash=m=>{clearTimeout(cmp._t);set({toast:m});cmp._t=setTimeout(()=>set({toast:''}),1800);};
  const df=d=>!d?'':(lang==='en'?MON[d[0]-1]+' '+d[1]:d[0]+'/'+d[1]);
  const ic={};Object.keys(P).forEach(k=>ic[k]=icn(k,14));
  const isLoading=st==='loading',isError=st==='error';
  const emptyGeneric=isEmptyState&&['views','assign','dashboard','dashexport'].indexOf(screen)<0;
  const isLock=false;
  const body=!isLoading&&!isError&&!emptyGeneric;
  const out={t,ic,lang,ro,roOp:ro?0.45:1,toast:s.toast,stop:e=>e.stopPropagation(),
    bg:embed==='page'||embed==='canvas'?'var(--o16171a)':'transparent',bar:p.bar!==false,barPad:embed==='page'?'12px 28px 0':embed==='canvas'?'12px 20px 0':'0 0 14px',
    states:STS.map((k,i)=>({label:t.states[i],bg:k===st?'var(--o2a2d33)':'transparent',color:k===st?C.text:C.muted,on:()=>set({st:k})})),
    maxW:narrow?'380px':(embed==='page'&&screen!=='views'?'960px':'100%'),pad:narrow&&embed!=='page'&&embed!=='canvas'?'16px':({page:'20px 28px 40px',canvas:'20px',settings:'0',panel:'0'}[embed]||'0'),frame:narrow?'1px dashed var(--o34373d)':'none',
    hasTitle:screen!=='views'&&screen!=='palette',head:t.heads[screen],headMeta:'',hFs:embed==='panel'?'13px':'16px',hasViewPick:screen==='views',hasHeadRow:screen!=='palette',hasToolbar:screen==='views'&&!isLoading,headActs:[],
    isLoading,isError,isLock,toNormal:()=>set({st:'normal'}),skel:[{w:'62%'},{w:'48%'},{w:'71%'},{w:'40%'},{w:'56%'}],
    isEmpty:emptyGeneric||(isEmptyState&&screen==='views'),emptyText:t.empty[screen]||'',emptyHasAct:!!t.emptyAct[screen],emptyAct:t.emptyAct[screen]||'',emptyIc:icn('issue',12),emptyDis:ro&&screen!=='intake',emptyOp:ro&&screen!=='intake'?0.45:1,emptyOn:()=>{if(p.onNew&&screen==='views')p.onNew();else set({st:'normal'});},
    propCols:narrow?'92px minmax(0,1fr)':'120px minmax(0,1fr)',headSegs:[],panes:[],bDocs:false,bWiki:false,wk:{},groups:[],layoutOpts:[],tools:[],hasDesc:false,desc:'',bDash:false,bExport:false,kpis:[],dmRows:[],dmHead:[],ex:{},bReps:false,bRep:false,rl:[],rp:{}};
  const act=(label,o)=>Object.assign({label,icon:null,tail:null,on:()=>{},dis:ro,tip:ro?t.roTip:'',bg:'var(--o22242a)',color:C.text,fw:400,op:ro?0.45:1},o||{});
  const primary=o=>Object.assign({bg:'var(--obtn)',color:'var(--obtnfg)',fw:550},o||{});
  const menus={};
  const menu=(e,id)=>{const r=e.currentTarget.getBoundingClientRect();const w=Math.max(220,Math.round(r.width));const left=Math.max(8,Math.min(Math.round(r.left),window.innerWidth-w-8));const below=window.innerHeight-r.bottom>280||r.top<280;set({menu:{id,top:below?Math.round(r.bottom+4)+'px':'auto',bottom:below?'auto':Math.round(window.innerHeight-r.top+4)+'px',left:left+'px',w:w+'px'}});setTimeout(()=>{const b=document.querySelector('[role=menu] button');if(b)b.focus();},30);};
  const dlg=(k,x)=>{set({menu:null});if(window.__orbisDlg)window.__orbisDlg.open(set,k,x);};
  out.dlgFlash=flash;out.lang=lang;
  const finishMenu=()=>{const m=s.menu;const items=m&&menus[m.id];out.menuOpen=!!items;out.menuClose=()=>set({menu:null});out.menuTop=m?m.top:'0';out.menuBottom=m?m.bottom:'auto';out.menuLeft=m?m.left:'0';out.menuW=m?m.w:'220px';out.ic.more=icn('more',14);
    out.menuKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();set({menu:null});return;}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const bs=[...e.currentTarget.querySelectorAll('button')];const i=bs.indexOf(document.activeElement);const n=bs[(i+(e.key==='ArrowDown'?1:-1)+bs.length)%bs.length];if(n)n.focus();}};
    out.menuItems=(items||[]).map(it=>Object.assign({hasIcon:!!it.icon,isHead:!!it.head,isSep:!!it.sep,isErr:!!it.err,isItem:!it.head&&!it.sep&&!it.err,label:it.label||'',sub:it.sub||'',hasSub:!!it.sub,kbd:it.kbd||'',icon:typeof it.icon==='string'?icn(it.icon,14):(it.icon||null),icColor:it.icColor||C.muted,font:it.mono?"'JetBrains Mono',ui-monospace,Consolas,monospace":'inherit',
      role:it.multi?'menuitemcheckbox':(it.sel!==undefined?'menuitemradio':'menuitem'),sel:it.sel?'true':'false',dis:!!it.dis,op:it.dis?0.45:1,tip:it.tip||'',bg:it.sel&&!it.multi?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',color:it.danger?C.bad:C.text,check:it.sel?icn('check',14):null,
      on:()=>{if(it.dis)return;if(!it.keep)set({menu:null});if(it.on)it.on();}}));};
  const TABS=['views','dashboard'];
  out.hasTabs=!!p.tabs&&TABS.indexOf(screen)>=0;
  if(out.hasTabs){const small=narrow||(typeof window!=='undefined'&&window.innerWidth<860);
    out.tabs=t.tabsL.map(([k,l])=>({label:l,cur:k===screen?'page':'false',line:k===screen?'var(--oe3e4e6, #e3e4e6)':'transparent',color:k===screen?C.text:C.muted,fw:k===screen?550:400,mbg:k===screen?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',hasCount:false,count:'',on:()=>{set({tabsMenu:false});if(p.onTab)p.onTab(k);}}));
    out.tabsRowD=small?'none':'flex';out.tabsMenuD=small?'block':'none';out.tabCur=(t.tabsL.find(x=>x[0]===screen)||[])[1];out.tabsMenuOpen=!!s.tabsMenu;out.togTabsMenu=()=>set({tabsMenu:!s.tabsMenu});
    if(screen!=='views'){out.hasTitle=false;}}
  // ---------- tasks model ----------
  const tk=(s.tk||TK0.map(r=>({key:r[0],state:r[1],pri:r[2],who:r[3],agent:r[4],start:r[5],due:r[6],est:r[7],stage:r[10],arch:!!r[11],epic:!!r[12]}))).map(x=>Object.assign({},x));
  const setTk=fn=>{const n=tk.map(x=>Object.assign({},x));fn(n);set({tk:n});};
  const title=k=>t.titles[k]||k;
  // ---------- 13/14/21 views ----------
  if(screen==='views'){
    const SV={v1:{layout:'list',filters:[],match:'all',group:'state',sort:'manual',dir:'asc',cols:['state','priority','assignee','due'],arch:false},v2:{layout:'list',filters:['mine'],match:'all',group:'state',sort:'priority',dir:'desc',cols:['state','priority','due'],arch:false},v3:{layout:'cal',filters:['week'],match:'all',group:'state',sort:'due',dir:'asc',cols:['state','priority','assignee','due'],arch:false}};
    const vid=s.vid||'v1',saved=Object.assign({},SV[vid],p.layout?{layout:p.layout}:{},(s.savedOver||{})[vid]||{});const v=saved;
    const setV=o=>set({savedOver:Object.assign({},s.savedOver||{},{[vid]:Object.assign({},v,o)})});
    const vo=t.views.find(x=>x[0]===vid);
    Object.assign(out,{viewName:vo[1],viewMenuOpen:!!s.vm,viewMenuBg:s.vm?'var(--o1c1e22)':'transparent',togViewMenu:()=>set({vm:!s.vm,tb:null}),
      viewOpts:t.views.map(([id,l])=>({label:l,bg:id===vid?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',check:id===vid?icn('check',14):null,on:()=>set({vid:id,vm:false})})),
      headActs:[act(t.newTask,primary({icon:icn('plus',14),on:()=>{if(p.onNew)p.onNew();}}))],
      layoutOpts:segOf(t.layouts,v.layout,l=>setV({layout:l})),layoutTabs:t.layouts.map(([k,l])=>({label:l,icon:icn({list:'listUl',cols:'kanban',table:'table',cal:'cal',tl:'gantt'}[k],14),sel:String(k===v.layout),bg:k===v.layout?'var(--o1c1e22)':'transparent',color:k===v.layout?C.text:C.muted,on:()=>setV({layout:k})})),
      allProj:!!s.allProj,togAllProj:()=>set({allProj:!s.allProj}),apBg:s.allProj?'var(--o1c1e22)':'transparent',apColor:s.allProj?C.text:C.muted,showArch:v.arch,togArchived:()=>setV({arch:!v.arch}),archBg:v.arch?'var(--o1c1e22)':'transparent',archColor:v.arch?C.text:C.muted});
    const box=(on)=>({boxD:'grid',bd:on?C.acc:'var(--o3d4047)',fill:on?C.acc:'transparent',box:on?icn('check',10):null,check:null,bg:'transparent'});
    const tool=(k,icon,opts,extra)=>Object.assign({label:t.tool[k],icon:icn(icon,13),open:s.tb===k,toggle:()=>set({tb:s.tb===k?null:k,vm:false}),bg:s.tb===k?'var(--o1c1e22)':'transparent',color:s.tb===k?C.text:C.muted,hasCount:false,count:'',hasSeg:false,seg:[],opts,secs:[]},extra||{});
    out.popClose=()=>set({tb:null,vm:false});if((s.tb||s.vm)&&typeof window!=='undefined'&&!window.__orbisPopEsc){const h=e=>{if(e.key==='Escape'){window.removeEventListener('keydown',h);window.__orbisPopEsc=null;set({tb:null,vm:false});}};window.__orbisPopEsc=h;window.addEventListener('keydown',h);}
    out.tools=[
      tool('filter','filter',t.filters.map(([k,l])=>{const on=v.filters.indexOf(k)>=0;return Object.assign({label:l,on:()=>setV({filters:on?v.filters.filter(x=>x!==k):v.filters.concat([k])})},box(on));}),{hasCount:v.filters.length>0,count:String(v.filters.length),hasSeg:true,seg:segOf([['all',t.matchAll],['any',t.matchAny]],v.match,m=>setV({match:m})),color:v.filters.length?C.text:(s.tb==='filter'?C.text:C.muted)}),
      tool('display','sliders',[],{secs:[{title:t.tool.group,opts:t.groupBy.map(([k,l])=>Object.assign(optOf(l,v.group===k,()=>setV({group:k})),{boxD:'none'})),hasSeg:false,seg:[]},{title:t.tool.sort,opts:t.sortBy.map(([k,l])=>Object.assign(optOf(l,v.sort===k,()=>setV({sort:k})),{boxD:'none'})),hasSeg:true,seg:segOf([['asc',t.asc],['desc',t.desc]],v.dir,d=>setV({dir:d}))},{title:(lang==='en'?'Properties':'顯示屬性'),opts:Object.keys(t.cols).map(k=>{const on=v.cols.indexOf(k)>=0;return Object.assign({label:t.cols[k],on:()=>setV({cols:on?v.cols.filter(x=>x!==k):v.cols.concat([k])})},box(on));}),hasSeg:false,seg:[]},{title:'',opts:[Object.assign({label:t.showArchived,on:()=>setV({arch:!v.arch})},box(v.arch))],hasSeg:false,seg:[]}].map(x=>Object.assign({hasTitle:!!x.title},x)),hasCount:(v.arch?1:0)+(v.group!=='state'?1:0)+(v.sort!=='manual'?1:0)>0,count:String((v.arch?1:0)+(v.group!=='state'?1:0)+(v.sort!=='manual'?1:0)),color:C.muted})];
    const PR={urgent:0,high:1,medium:2,low:3,none:4};
    const match=x=>{const F={mine:x.who==='kashionz',high:PR[x.pri]<=1,week:!!x.due&&IDX(x.due)>=IDX([10,26])&&IDX(x.due)<=IDX([11,1]),stage:!!x.stage,blocked:LINKS.some(l=>l[1]===x.key)};const fs=v.filters;if(!fs.length)return true;return v.match==='all'?fs.every(f=>F[f]):fs.some(f=>F[f]);};
    let rows=isEmptyState?[]:tk.filter(x=>(v.arch||!x.arch)&&match(x));if(s.allProj&&!isEmptyState&&v.filters.indexOf('mine')>=0)rows=rows.concat([{key:'WEB-12',state:'s4',pri:'medium',who:'kashionz',agent:'',start:[10,22],due:[10,30],est:3,stage:'',arch:false}]);
    const sk={priority:x=>PR[x.pri],due:x=>x.due?IDX(x.due):999,updated:x=>-tk.indexOf(x)};
    if(sk[v.sort]){rows=rows.slice().sort((a,b)=>sk[v.sort](a)-sk[v.sort](b));if(v.dir==='desc')rows.reverse();}
    const bodyV=body&&!isEmptyState;
    out.isEmpty=out.isEmpty||(bodyV&&rows.length===0);
    out.bListNest=false;
    const LL=(a,b)=>lang==='en'?b:a;
    const STG={planning:LL('規劃','Planning'),plan_gate:LL('計畫關卡','Plan gate'),running:LL('執行中','Running'),verifying:LL('驗收中','Verifying'),review_gate:LL('審查關卡','Review gate'),pr:LL('合併請求','Pull request')};
    const byStage=v.group==='stage';
    const GK=byStage?Object.keys(STG).concat(['']):Object.keys(t.stN);
    const gl=k=>byStage?(k?STG[k]:LL('沒有代理階段','No agent stage')):t.stN[k];
    const dotEl=(c,sz)=>E('span',{style:{width:sz||7,height:sz||7,borderRadius:'50%',background:c,display:'block'}});
    const ringEl=E('span',{style:{width:8,height:8,borderRadius:'50%',border:'1px solid var(--o4c5058)',display:'block',boxSizing:'border-box'}});
    const gi=k=>byStage?(k?dotEl(C.acc):ringEl):sIcon(ST[k][0],ST[k][1]);
    const emptyAv=E('span',{style:{width:18,height:18,borderRadius:'50%',border:'1px dashed var(--o4c5058)',display:'block',boxSizing:'border-box'}});
    const closedG=s.lgc||{s7:true};const addAt=s.ladd;const dk=s.dk;const dkT=dk&&tk.find(z=>z.key===dk);const srcG=dkT?dkT.state:null;const kbL=v.layout==='cols';
    const openTask=k=>{if(p.onOpenTask)p.onOpenTask(k);else flash(LL('開啟 ','Open ')+k);};
    const late=x=>x.due&&IDX(x.due)<IDX([10,25])&&ST[x.state][0]!=='completed';
    const colOn=k=>v.cols.indexOf(k)>=0;
    const rowOf=x=>{const done=ST[x.state][0]==='completed';const a=x.agent&&x.stage?x.agent:'';
      return {key:x.key,title:title(x.key),done:String(done),titleColor:done?C.muted:C.text,deco:done?'line-through':'none',showKey:!narrow,
        ck:e=>{if(e&&e.stopPropagation)e.stopPropagation();if(ro)return;setTk(n=>{const y=n.find(z=>z.key===x.key);y.state=done?'s2':'s6';if(!done)y.stage='';});flash(done?LL('已重新開啟 ','Reopened ')+x.key:LL('已完成 ','Completed ')+x.key);},
        ckBd:done?C.ok:'var(--o4c5058)',ckBg:done?C.ok:'transparent',ckIc:done?icn('check',10):null,ckLabel:(done?LL('重新開啟 ','Reopen '):LL('標成完成 ','Mark complete '))+x.key,
        pri:pIcon(x.pri),priTip:t.f&&t.f.priority?t.priL[x.pri]:t.priL[x.pri],hasStage:!!x.stage&&!byStage,stage:STG[x.stage]||'',
        hasState:byStage&&colOn('state'),stateIc:sIcon(ST[x.state][0],ST[x.state][1]),stateL:t.stN[x.state],
        who:a?logo(a,18):(x.who?av(x.who,18):emptyAv),whoTip:a||x.who||t.unset,
        hasDue:!!x.due,due:x.due?df(x.due):'',dueColor:late(x)?C.bad:C.muted,hasEst:false,est:x.est?fmt(t.pts,{n:x.est}):'',isEpic:!!x.epic,epic:t.epicChip,
        open:()=>{if(x.epic&&p.onOpenEpic)p.onOpenEpic();else openTask(x.key);},op:dk===x.key?0.4:(x.arch?0.55:1),cls:s.jm===x.key?'ob-moved':'',
        showPri:colOn('priority'),showDueCol:colOn('due'),showEstCol:false,showWho:colOn('assignee'),hasDueK:!!x.due&&colOn('due'),hasEstK:false,cur:ro||byStage?'default':'grab',
        drag:!ro&&!byStage,ds:e=>{const dt=e.dataTransfer;dt.setData('text/plain',x.key);dt.effectAllowed='move';const el=e.currentTarget;try{const rc=el.getBoundingClientRect();const g=el.cloneNode(true);g.removeAttribute('class');g.style.cssText+=';position:fixed;top:-1000px;left:-1000px;width:'+rc.width+'px;pointer-events:none;opacity:1;background:var(--opop);border:1px solid rgba(127,176,250,.55);border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.45);transform:'+(kbL?'rotate(2deg)':'none');document.body.appendChild(g);dt.setDragImage(g,e.clientX-rc.left,e.clientY-rc.top);setTimeout(()=>g.remove(),0);}catch(_){}const clr=()=>{window.removeEventListener('dragend',clr,true);setTimeout(()=>{if(cmp.state.dk)set({dk:null,dov:null});},0);};window.addEventListener('dragend',clr,true);setTimeout(()=>set({dk:x.key}),0);}};};
    const addOf=g=>{const on=!!addAt&&addAt.g===g;return {addOn:on,addNot:!on&&!ro&&!(byStage&&!g),addQ:on?addAt.q:'',addOnQ:e=>set({ladd:{g,q:e.target.value}}),
        addStart:()=>{set({ladd:{g,q:''}});setTimeout(()=>{const el=document.querySelector('input[data-quick-add]');if(el)el.focus();},40);},
        addKey:e=>{if(e.key==='Enter'){const q=((s.ladd||{}).q||'').trim();if(q){const key='ORB-'+(64+tk.length-9);t.titles[key]=q;setTk(n=>{n.push({key,state:byStage?'s4':g,pri:'none',who:'kashionz',agent:'',start:null,due:null,est:0,stage:byStage?g:'',arch:false});});flash(fmt(t.created,{k:key}));set({ladd:{g,q:''}});}}if(e.key==='Escape')set({ladd:null});},
        addBlur:()=>{if(!((s.ladd||{}).q||'').trim())set({ladd:null});},addPh:LL('任務名稱，按 Enter 建立','Task name, press Enter to create'),addLabel:LL('新增任務','Add task')};};
    out.lst=GK.map(k=>{const rs=rows.filter(x=>byStage?(x.stage||'')===k:x.state===k);const closed=!!closedG[k];const isOver=!!dk&&!byStage&&!ro&&s.dov===k&&srcG!==k;
      return Object.assign({k,label:gl(k),icon:gi(k),count:String(rs.length),rows:rs.map(rowOf),open:!closed,openStr:String(!closed),rot:closed?'-90deg':'0deg',toggle:()=>set({lgc:Object.assign({},closedG,{[k]:!closed})}),canAdd:!ro&&!(byStage&&!k),
        over:e=>{if(ro||byStage)return;e.preventDefault();e.dataTransfer.dropEffect='move';if(s.dov!==k)set({dov:k});},leave:e=>{if(e.relatedTarget&&e.currentTarget.contains(e.relatedTarget))return;if(s.dov===k)set({dov:null});},drop:e=>{e.preventDefault();if(ro||byStage){set({dk:null,dov:null});return;}const kk=e.dataTransfer.getData('text/plain');const y0=kk&&tk.find(z=>z.key===kk);if(!y0||y0.state===k){set({dk:null,dov:null});return;}const n=tk.filter(z=>z.key!==kk).map(z=>Object.assign({},z));n.push(Object.assign({},y0,{state:k,stage:(k==='s6'||k==='s7')?'':y0.stage}));set({tk:n,dk:null,dov:null,jm:kk});flash(kk+'  → '+gl(k));setTimeout(()=>{if(cmp.state.jm===kk)set({jm:null});},900);},isOver:String(isOver),colBg:isOver?'var(--tint-accent-06, rgba(127,176,250,.06))':'var(--o18191d)',listBg:isOver?'var(--tint-accent-06, rgba(127,176,250,.06))':'transparent',colRing:isOver?'inset 0 0 0 1px rgba(127,176,250,.45)':'inset 0 0 0 1px transparent',slot:isOver&&!closed,slotLabel:LL('移到「'+gl(k)+'」','Move to '+gl(k))},addOf(k));}).filter(g=>byStage?(g.rows.length>0||g.k===''):true);
    out.bList2=bodyV&&v.layout==='list'&&rows.length>0;out.bKb=bodyV&&v.layout==='cols'&&rows.length>0;out.kbW=narrow?'260px':'288px';
    // table
    const W={state:'128px',priority:'104px',assignee:'136px',due:'92px',estimate:'76px'};
    const colKeys=Object.keys(t.cols).filter(k=>v.cols.indexOf(k)>=0);
    out.tCols='36px 72px minmax(220px,1fr) '+colKeys.map(k=>W[k]).join(' ');
    out.tHead=[t.key,t.title].concat(colKeys.map(k=>t.cols[k]));
    const sel=s.sel||[];
    const cellOf=(x,k)=>{const open=s.cell===x.key+':'+k;const setX=(f,val)=>{setTk(n=>{n.find(y=>y.key===x.key)[f]=val;});set({cell:null});};
      const base={open:()=>set({cell:open?null:x.key+':'+k}),isOpen:open,bg:open?'var(--o1c1e22)':'transparent',color:C.text,icColor:C.muted,icon:null,opts:[]};
      if(k==='state'){const g=ST[x.state];return Object.assign(base,{icon:sIcon(g[0],g[1]),icColor:g[1],value:t.stN[x.state],opts:Object.keys(t.stN).map(id=>optOf(t.stN[id],id===x.state,()=>setX('state',id),sIcon(ST[id][0],ST[id][1]),ST[id][1]))});}
      if(k==='priority')return Object.assign(base,{icon:pIcon(x.pri),value:t.priL[x.pri],opts:Object.keys(t.priL).map(l=>optOf(t.priL[l],l===x.pri,()=>setX('pri',l),pIcon(l)))});
      if(k==='assignee'){const a=x.agent&&x.stage?x.agent:'';return Object.assign(base,{icon:a?logo(a,16):av(x.who),value:a||x.who||t.unset,color:(a||x.who)?C.text:C.muted,opts:['kashionz','mei-lin','chen-yu'].map(m=>optOf(m,m===x.who&&!a,()=>{setTk(n=>{const y=n.find(z=>z.key===x.key);y.who=m;y.agent='';});set({cell:null});},av(m))).concat(['claude-code','codex'].map(ag=>optOf(ag,ag===a,()=>{setTk(n=>{const y=n.find(z=>z.key===x.key);y.agent=ag;if(!y.stage)y.stage='planning';});set({cell:null});},logo(ag,16))))});}
      if(k==='due')return Object.assign(base,{icon:icn('cal',13),value:x.due?df(x.due):t.unset,color:x.due?(IDX(x.due)<IDX([10,25])&&ST[x.state][0]!=='completed'?C.bad:C.text):C.muted,opts:[[[10,25],t.today],[[10,26],lang==='en'?'Tomorrow':'明天'],[[10,27],lang==='en'?'Next Monday':'下週一'],[null,t.unset]].map(([d,l])=>optOf(l,false,()=>setX('due',d)))});
      if(k==='estimate')return Object.assign(base,{value:x.est?fmt(t.pts,{n:x.est}):t.unset,color:x.est?C.text:C.muted,opts:[1,2,3,5,8].map(n=>optOf(fmt(t.pts,{n}),n===x.est,()=>setX('est',n)))});
      return Object.assign(base,{value:''});};
    out.bTable=bodyV&&v.layout==='table'&&rows.length>0;
    const chk=on=>({bd:on?C.acc:'var(--o3d4047)',fill:on?C.acc:'transparent',ic:on?icn('check',10):null});
    out.tRows=rows.map(x=>{const on=sel.indexOf(x.key)>=0;const c=chk(on);return {isEpic:x.epic,openT:()=>{if(x.epic&&p.onOpenEpic)p.onOpenEpic();},tCursor:x.epic?'pointer':'default',tTip:x.epic?t.openEpic:'',key:x.key,title:title(x.key),isSel:on,bd:c.bd,fill:c.fill,selIc:c.ic,bg:on?'var(--tint-accent-08, rgba(127,176,250,.08))':'transparent',op:x.arch?0.55:1,sel:()=>set({sel:on?sel.filter(y=>y!==x.key):sel.concat([x.key])}),cells:colKeys.map(k=>cellOf(x,k))};});
    const allOn=rows.length>0&&rows.every(x=>sel.indexOf(x.key)>=0);const ca=chk(allOn);
    Object.assign(out,{allSel:allOn,allBd:ca.bd,allFill:ca.fill,allIc:ca.ic,selAll:()=>set({sel:allOn?[]:rows.map(x=>x.key)}),hasSel:sel.length>0&&out.bTable&&!ro,selLabel:fmt(t.selected,{n:sel.length}),clearSel:()=>set({sel:[]}),
      bulk:t.bulk.map(([k,l])=>({label:l,color:k==='archive'?C.text:C.text,icon:k==='archive'?icn('archive',13):null,on:()=>{if(k==='archive')setTk(n=>{n.forEach(y=>{if(sel.indexOf(y.key)>=0)y.arch=true;});});flash(fmt(t.updated,{n:sel.length}));set({sel:[]});}}))});
    // calendar
    out.bCal=bodyV&&v.layout==='cal';out.calTitle=t.calTitle;out.calWeek=t.week;out.calH=narrow?'64px':'96px';out.sideW=narrow?'100%':'200px';out.canEdit=!ro;
    const dragStart=k=>e=>{e.dataTransfer.setData('text/plain',k);e.dataTransfer.effectAllowed='move';};
    const dropTo=d=>e=>{e.preventDefault();const k=e.dataTransfer.getData('text/plain');if(!k||ro)return;setTk(n=>{const y=n.find(z=>z.key===k);if(y)y.due=d;});if(d)flash(fmt(t.moved,{k,d:df(d)}));};
    out.calDays=Array.from({length:35},(_,i)=>{const d=FROM(i);const inMonth=d[0]===10;const isToday=d[0]===10&&d[1]===25;const items=rows.filter(x=>x.due&&IDX(x.due)===i);
      return {n:d[0]===10||lang==='en'?String(d[1]):d[0]+'/'+d[1],bg:inMonth?'transparent':'var(--o131417)',numBg:isToday?C.acc:'transparent',numColor:isToday?'var(--obtnfg)':(inMonth?C.text:C.muted),fw:isToday?550:400,
        items:items.map(x=>({label:narrow?x.key:title(x.key),title:x.key+'  '+title(x.key),pri:pIcon(x.pri),ds:dragStart(x.key)})),adding:s.calAdd===i,
        over:e=>{if(!ro)e.preventDefault();},drop:dropTo(d),click:()=>{if(!ro)set({calAdd:i,calQ:''});}};});
    out.noDate=rows.filter(x=>!x.due).map(x=>({key:x.key,title:title(x.key),pri:pIcon(x.pri),ds:dragStart(x.key)}));
    out.noDateOver=e=>{if(!ro)e.preventDefault();};out.noDateDrop=dropTo(null);
    out.calQ=s.calQ||'';out.onCalQ=e=>set({calQ:e.target.value});
    const addCal=()=>{const q=(s.calQ||'').trim();if(q&&s.calAdd!=null){const key='ORB-'+(64+tk.length-9);t.titles[key]=q;setTk(n=>{n.push({key,state:'s2',pri:'none',who:'kashionz',agent:'',start:null,due:FROM(s.calAdd),est:0,stage:'',arch:false});});flash(fmt(t.created,{k:key}));}set({calAdd:null,calQ:''});};
    out.calKey=e=>{if(e.key==='Enter')addCal();if(e.key==='Escape')set({calAdd:null});};out.calBlur=()=>{if(!(s.calQ||'').trim())set({calAdd:null});};
    // timeline
    out.bTl=bodyV&&v.layout==='tl';const zoom=s.zoom||'w';const dw={w:28,m:14,q:6}[zoom];const t0=IDX([10,12]);const days=42;
    out.zoomOpts=segOf(t.zoom,zoom,z=>set({zoom:z}));out.tlLeft=narrow?'150px':'260px';
    const tlr=rows.filter(x=>x.start||x.due);const drag=s.tlDrag;
    out.tlRows=tlr.map((x,i)=>{const sh=drag&&drag.key===x.key?drag.d:0;const a=(x.start?IDX(x.start):IDX(x.due)-1)+sh,b=(x.due?IDX(x.due):a+1)+sh;const g=ST[x.state];
      return {key:x.key,title:title(x.key),pri:pIcon(x.pri),x:((a-t0)*dw)+'px',w:Math.max(dw,(b-a+1)*dw)+'px',range:df(FROM(a))+' – '+df(FROM(b)),barBg:g[0]==='completed'?'var(--tint-success, rgba(79,184,106,.1))':'var(--tint-accent-16, rgba(90,156,248,.16))',barFg:g[0]==='completed'?C.ok:'var(--o9cc3ff)',cursor:ro?'default':'grab',
        down:e=>{if(ro)return;const x0=e.clientX;const mv=ev=>set({tlDrag:{key:x.key,d:Math.round((ev.clientX-x0)/dw)}});const up=ev=>{window.removeEventListener('pointermove',mv);window.removeEventListener('pointerup',up);const d=Math.round((ev.clientX-x0)/dw);if(d)setTk(n=>{const y=n.find(z=>z.key===x.key);if(y.start)y.start=FROM(IDX(y.start)+d);if(y.due)y.due=FROM(IDX(y.due)+d);});set({tlDrag:null});};window.addEventListener('pointermove',mv);window.addEventListener('pointerup',up);}};});
    out.tlHPad=zoom==='w'?'0':'6px';out.tlHAlign=zoom==='w'?'center':'left';out.tlW=(days*dw)+'px';out.tlWn=days*dw;out.tlHn=tlr.length*36;
    out.tlHead=zoom==='w'?Array.from({length:days},(_,i)=>{const d=FROM(t0+i);return {w:dw+'px',label:String(d[1])};}):zoom==='m'?Array.from({length:6},(_,i)=>({w:(7*dw)+'px',label:df(FROM(t0+i*7))})):[{w:(20*dw)+'px',label:lang==='en'?'Oct':'10 月'},{w:(22*dw)+'px',label:lang==='en'?'Nov':'11 月'}];
    out.tlLinks=LINKS.map(([a,b])=>{const ia=tlr.findIndex(x=>x.key===a),ib=tlr.findIndex(x=>x.key===b);if(ia<0||ib<0)return null;const ra=out.tlRows[ia],rb=out.tlRows[ib];const x1=parseFloat(ra.x)+parseFloat(ra.w),x2=parseFloat(rb.x),y1=ia*36+18,y2=ib*36+18;const back=x2<x1+16;const yb=y2-14;return {d:back?`M${x1} ${y1} H${x1+8} V${yb} H${x2-8} V${y2} H${x2-2}`:`M${x1} ${y1} H${x1+8} V${y2} H${x2-2}`,ex:x2-2,ey:y2};}).filter(Boolean);
    out.todayX=((IDX([10,25])-t0)*dw+dw/2)+'px';
    if(window.__orbisDlg)window.__orbisDlg.run({out,s,p,set,flash,lang,ro,st,icn,C,df,title,t,cmp});
    return out;
  }
  // ---------- generic list rows ----------
  const ind=narrow?'0':'24px';
  const row=o=>{const r=Object.assign({rightColor:C.muted,hasSw:false,icon:null,icColor:C.muted,hasKey:!!o.key,key:'',title:'',fw:400,chips:[],hasBar:false,pct:'0%',right:'',rIcon:null,hasSub:!!o.sub,sub:'',hasActs:false,acts:[],panelOpen:false,panelLabel:'',panelOpts:[],done:false,doneLabel:'',bg:'transparent',cursor:'default',op:1,ind,click:()=>{}},o);r.hasIcon=!!r.icon;r.hasRIcon=!!r.rIcon;if(!r.icon&&!o.ind)r.ind='0';return r;};
  const grp=(label,rows,o)=>Object.assign({hasLabel:!!label,label,rows,count:String(rows.length),icon:null,color:C.muted,hasDesc:!!(o&&o.desc),desc:''},o||{});
  const taskRow=(k,o)=>{const x=tk.find(y=>y.key===k)||{state:'s2',pri:'none'};const g=ST[x.state];return row(Object.assign({icon:sIcon(g[0],g[1]),icColor:g[1],key:k,title:title(k)},o||{}));};
  if(screen==='mywork'){
    const other={key:'WEB-12',state:'s4',due:[10,30]};
    const proj=k=>pill(k.split('-')[0]);
    const R=(k,due)=>taskRow(k,{chips:[proj(k),chip('',{icon:pIcon((tk.find(y=>y.key===k)||{pri:'medium'}).pri)})],right:due?df(due):''});
    out.groups=[grp(t.my.today,[R('ORB-36',[10,25])],{icon:dot(C.warn)}),grp(t.my.week,[R('ORB-42',[10,28]),R('WEB-12',[10,30])]),grp(t.my.later,[R('ORB-30',[11,4])]),grp(t.my.nodate,[R('ORB-51',null)])];
    out.headMeta=fmt(t.items,{n:5});
  }
  if(screen==='epic'){
    const el=Object.assign({spec:'docs/specs/billing.md',wiki:'billing'},s.elink||{});const WN={billing:lang==='en'?'Billing design':'帳務設計',notify:lang==='en'?'Notification architecture':'通知架構'};
    out.epicLinks=(el.spec?[{icon:icn('file',12),label:el.spec,font:"'JetBrains Mono',ui-monospace,Consolas,monospace"}]:[]).concat(el.wiki?[{icon:icn('book',12),label:WN[el.wiki],font:'inherit'}]:[]);out.epicHasLinks=out.epicLinks.length>0;
    out.headActs=[act(lang==='en'?'Link':'連結',{icon:icn('link',12),on:()=>dlg('epicLink',{init:el,after:v=>set({elink:v})})}),act(t.dispatch,{icon:icn('play',12),dis:true,op:0.45,tip:t.epicNo})];
    out.headMeta=t.epicChip;
    const kids=[['ORB-36','s4'],['ORB-38','s4'],['ORB-42','s4'],['ORB-61','s6'],['ORB-62','s2'],['ORB-63','s6'],['ORB-30','s6'],['ORB-29','s6'],['ORB-53','s1']];
    const doneN=kids.filter(k=>k[1]==='s6').length,startN=kids.filter(k=>ST[k[1]][0]==='started').length;
    out.bEpic=body;out.epicStats=[[t.epicSt[0][0],String(kids.length)],[t.epicSt[1][0],doneN+' / '+kids.length]].map(([label,value])=>({label,value}));
    out.epicPct=Math.round(doneN/kids.length*100)+'%';out.epicPct2=Math.round(startN/kids.length*100)+'%';
    out.groups=[grp('',kids.map(([k,sid])=>row({icon:sIcon(ST[sid][0],ST[sid][1]),icColor:ST[sid][1],key:k,title:title(k),chips:[chip(t.stN[sid])]})))];
  }
  if(screen==='assign'){
    const a=s.asg!==undefined?s.asg:(isEmptyState?'':'claude-code');
    const isAgent=['claude-code','codex','antigravity'].indexOf(a)>=0;
    out.bAssign=body;out.asIsAgent=isAgent;
    out.asOpts=['kashionz','mei-lin','chen-yu','claude-code','codex','antigravity'].map(k=>{const ag=k.indexOf('-')>0&&!AVC[k]||k==='codex';const A=AVC[k];return {label:k,isAgent:ag,isUser:!ag,logo:'assets/agents/'+k+'.svg',init:A?A[0]:'',avBg:A?A[1]:'',bg:k===a?'var(--o1c1e22)':'transparent',ring:k===a?'inset 0 0 0 1px var(--o7fb0fa)':'none',on:()=>{if(k===a){set({asg:'',ap:null});return;}if(ag&&!ro)dlg('assignAgent',{init:Object.assign({},s.acfg||{},{agent:k}),after:v=>set({asg:v.agent,ap:null,acfg:{where:v.where,model:v.model,effort:v.effort,policy:v.policy}})});else set({asg:k,ap:null});}};});
    const cfg=Object.assign({where:'local',model:'Sonnet 5.5',effort:'std',policy:'yolo'},s.acfg||{});
    const setC=(k,v)=>set({acfg:Object.assign({},cfg,{[k]:v}),ap:null});
    const MODELS={'claude-code':['Opus 5.5','Sonnet 5.5','Haiku 5.5'],codex:['GPT-5 Codex','GPT-5','GPT-5 Mini'],antigravity:['Gemini 2.5 Pro','Gemini 2.5 Flash']}[a]||[];
    const F=(k,icon,value,opts)=>({label:t.asg[k],icon:icn(icon,14),value,isOpen:s.ap===k,bg:s.ap===k?'var(--o1c1e22)':'transparent',open:()=>set({ap:s.ap===k?null:k}),opts});
    const o2=(label,sub,sel,on,dis)=>({label,sub:sub||'',sel,on:dis?()=>{}:on,dis:!!dis,op:dis?0.45:1,bg:sel?'var(--tint-accent-12, rgba(127,176,250,.12))':'transparent',check:sel?icn('check',14):null});
    out.asCfg=[F('where',cfg.where==='local'?'monitor':'server',cfg.where==='local'?t.local+'  KASH-DESKTOP':t.team+'  team-runner-01',[o2(t.local,'KASH-DESKTOP',cfg.where==='local',()=>setC('where','local')),o2(t.team,'team-runner-01',cfg.where==='team',()=>setC('where','team'))]),
      F('model','zap',MODELS.indexOf(cfg.model)>=0?cfg.model:MODELS[0],MODELS.map(m=>o2(m,'',m===cfg.model,()=>setC('model',m)))),
      F('effort','gauge',(t.efforts.find(e=>e[0]===cfg.effort)||[])[1],t.efforts.map(([k,l])=>o2(l,'',k===cfg.effort,()=>setC('effort',k)))),
      F('policy','shield',(t.policies.find(e=>e[0]===cfg.policy)||[])[1],t.policies.map(([k,l])=>o2(l,'',k===cfg.policy,()=>setC('policy',k))))];
    const auto=s.auto!==undefined?s.auto:true;const waiting=!s.depDone;
    Object.assign(out,{waitText:waiting?t.waitDep:t.readyNow,waitIcon:icn(waiting?'clock':'check',14),waitColor:waiting?C.warn:C.ok,waitBg:waiting?'var(--tint-warn, rgba(217,168,69,.12))':'var(--tint-success, rgba(79,184,106,.1))',autoOn:auto,togAuto:()=>{if(auto)set({auto:false});else dlg('assignAgent',{auto:true,init:Object.assign({agent:isAgent?a:'claude-code'},cfg),after:v=>set({auto:true,asg:v.agent,acfg:{where:v.where,model:v.model,effort:v.effort,policy:v.policy}})});},autoBg:auto?C.acc:'var(--o3d4047)',autoKnob:auto?'14px':'2px'});
    if(isEmptyState){out.isEmpty=false;}
  }
  if(screen==='dashboard'&&!ro){out.headSegs=[segOf(t.dtabs,s.dtab||'overview',v=>set({dtab:v}))];}
  if(screen==='dashboard'&&s.dtab==='reports'&&!ro&&window.__orbisMore){if(window.__orbisDlg)window.__orbisDlg.run({out,s,p,set,flash,lang,ro,st,icn,C,df,title,t,cmp});const hs=out.headSegs;window.__orbisMore.reports({out,s,p,set,flash,lang,ro,narrow,isEmptyState,body,dlg,menu,menus,row:o=>{const r=Object.assign({rIcon:null,rightColor:C.muted,hasSw:false,icon:null,icColor:C.muted,hasKey:false,key:'',title:'',fw:400,chips:[],hasBar:false,pct:'0%',right:'',hasSub:!!o.sub,sub:'',hasActs:false,acts:[],panelOpen:false,panelLabel:'',panelOpts:[],done:false,doneLabel:'',bg:'transparent',cursor:'default',op:1,ind:'0',click:()=>{}},o);r.hasIcon=!!r.icon;r.hasRIcon=!!r.rIcon;return r;},grp:(label,rows,o)=>Object.assign({hasLabel:!!label,label,rows,count:String(rows.length),icon:null,color:C.muted},o||{}),chip,pill,act,primary,segOf,optOf,icn,sIcon,pIcon,av,logo,dot,C,fmt,df,title:k=>t.titles[k]||k});out.headSegs=hs.concat(out.headSegs);out.head=t.heads.dashboard;out.hasTitle=!out.hasTabs;out.bList=body&&out.groups.length>0;finishMenu();return out;}
  if(screen==='dashboard'||screen==='dashexport'){
    const LL=(a,b)=>lang==='en'?b:a;const E0=isEmptyState;
    const dx=screen==='dashexport'||!!s.dx;
    const per=s.dper||'week';
    const PER={week:[LL('本週','This week'),LL('10/19 – 10/25','Oct 19 – 25'),1],last:[LL('上週','Last week'),LL('10/12 – 10/18','Oct 12 – 18'),0.75],month:[LL('本月','This month'),LL('10/1 – 10/25','Oct 1 – 25'),3.4]};
    const pm=PER[per][2];const sc=n=>E0?0:Math.round(n*pm);const money=n=>'$'+(E0?0:n*pm).toFixed(2);
    // member data: done, in progress, blocked, reviews, PRs, runs, cost, activity Mon..Sun
    const MB=[['kashionz',6,3,0,6,4,18,31.40,[3,5,2,6,4,0,1]],['mei-lin',4,2,1,2,3,14,19.80,[2,3,4,1,3,0,0]],['chen-yu',3,4,2,3,2,10,11.85,[1,2,2,3,1,0,0]]];
    const X=(day,kind,txt)=>({day,kind,txt});
    const ACT={'kashionz':[X(LL('週五 10/24','Fri Oct 24'),'done',LL('完成 ORB-42 修正 Windows 上的換行測試','Completed ORB-42 Fix line-ending tests on Windows')),X(LL('週五 10/24','Fri Oct 24'),'pr',LL('合併 #131 feat: long paths','Merged #131 feat: long paths')),X(LL('週四 10/23','Thu Oct 23'),'review',LL('核准 ORB-36 的審查關卡','Approved the ORB-36 review gate')),X(LL('週四 10/23','Thu Oct 23'),'pr',LL('合併 #128 fix: normalize EOL on read','Merged #128 fix: normalize EOL on read')),X(LL('週三 10/22','Wed Oct 22'),'run',LL('派工 ORB-51 給 codex','Dispatched ORB-51 to codex')),X(LL('週二 10/21','Tue Oct 21'),'done',LL('完成 ORB-30 登入頁改版','Completed ORB-30 Login page refresh'))],
      'mei-lin':[X(LL('週五 10/24','Fri Oct 24'),'return',LL('退回 ORB-38 的審查：需要補測試','Returned the ORB-38 review: needs tests')),X(LL('週四 10/23','Thu Oct 23'),'done',LL('完成 ORB-29 帳單 PDF 版面','Completed ORB-29 Invoice PDF layout')),X(LL('週三 10/22','Wed Oct 22'),'pr',LL('合併 #126 feat: invoice pdf','Merged #126 feat: invoice pdf')),X(LL('週一 10/19','Mon Oct 19'),'blocked',LL('ORB-38 發票按比例計算 卡在審查關卡','ORB-38 Prorated invoices is stuck at the review gate'))],
      'chen-yu':[X(LL('週四 10/23','Thu Oct 23'),'blocked',LL('ORB-45 看板拖曳排序 等待 ORB-36','ORB-45 Drag to reorder waits on ORB-36')),X(LL('週三 10/22','Wed Oct 22'),'done',LL('完成 ORB-27 匯出 CSV 加上 BOM','Completed ORB-27 Add BOM to CSV export')),X(LL('週二 10/21','Tue Oct 21'),'run',LL('派工 ORB-47 給 claude-code','Dispatched ORB-47 to claude-code')),X(LL('週一 10/19','Mon Oct 19'),'pr',LL('合併 #124 chore: runner logs','Merged #124 chore: runner logs'))]};
    const KI={done:['check',C.ok],pr:['gitMerge',C.acc],review:['check',C.acc],return:['x',C.warn],run:['play',C.muted],blocked:['alert',C.warn]};
    const tot=i=>MB.reduce((a,r)=>a+r[i],0);
    const kpiRows=[[LL('完成的任務','Tasks completed'),String(sc(tot(1))),E0?'':LL('比上期 +4','+4 vs last period'),C.ok,LL('平均每人 ','Per person ')+(E0?0:(tot(1)*pm/3).toFixed(1))],
      [LL('合併請求','Pull requests merged'),String(sc(tot(5))),E0?'':LL('比上期 +2','+2 vs last period'),C.ok,LL('另有 3 個等待審查','3 more waiting for review')],
      [LL('代理執行','Agent runs'),String(sc(tot(6))),E0?'':LL('成功率 86%','86% succeeded'),C.text,LL('失敗 4 次、中止 2 次','4 failed, 2 stopped')],
      [LL('代理費用','Agent cost'),money(63.05),E0?'':LL('比上期 −8%','−8% vs last period'),C.ok,LL('預算 $250 / 月','Budget $250 / month')]];
    const days=LL('一二三四五六日','MTWTFSS').split('');
    const mx=Math.max.apply(null,MB.map(r=>Math.max.apply(null,r[8])));
    const seeMB=ro?MB.filter(r=>r[0]==='kashionz'):MB;const open=s.dmo||{};
    const H=narrow?[LL('完成','Done'),LL('卡住','Blocked')]:[LL('完成','Done'),LL('進行中','In progress'),LL('卡住','Blocked'),LL('審查','Reviews'),'PR',LL('代理執行','Runs')];
    const cellsOf=r=>{const all=[[sc(r[1]),C.text],[sc(r[2]),C.text],[sc(r[3]),r[3]&&!E0?C.warn:C.muted],[sc(r[4]),C.text],[sc(r[5]),C.text],[sc(r[6]),C.text]];const pick=narrow?[all[0],all[2]]:all;return pick.map(([v,c])=>({v:String(v),c}));};
    out.bDash=body&&!dx;
    if(out.bDash){
      out.kpiCols=narrow?'repeat(2,minmax(0,1fr))':'repeat(4,minmax(0,1fr))';
      out.kpis=kpiRows.map(([label,value,delta,dc,sub])=>({label,value,delta,dColor:dc,sub}));
      out.dmTitle=LL('成員活動','Member activity');out.dmMeta=PER[per][1];out.dmCols=narrow?'minmax(0,1fr) repeat(2,52px)':'minmax(220px,2.2fr) repeat(6,minmax(44px,1fr)) 128px';
      out.dmHead=H.map(l=>({l}));out.dmSpark=!narrow;out.dmSparkL=LL('每日活動','Daily activity');out.dmNameL=LL('成員','Member');
      out.dmAll=LL('查看成員報告','Open member reports');out.dmGoReports=()=>set({dtab:'reports'});
      out.dmRows=seeMB.map(r=>{const w=r[0];const on=!!open[w];const acts=E0?[]:ACT[w];const last=acts[0];
        return {name:w,av:av(w,24),latest:E0?LL('這段期間沒有活動','No activity in this period'):LL('最近：','Latest: ')+last.txt,cells:cellsOf(r),rot:on?'90deg':'0deg',openStr:String(on),
          toggle:()=>set({dmo:Object.assign({},open,{[w]:!on})}),open:on,
          spark:r[8].map((n,i)=>({h:E0?'2px':Math.max(2,Math.round(n/mx*24))+'px',bg:i>=5?'var(--o3d4047)':C.acc,tip:days[i]+'  '+(E0?0:n)})),sparkAria:LL('每日活動 ','Daily activity ')+r[8].join(' / '),
          acts:acts.map(a=>({day:a.day,ic:icn(KI[a.kind][0],13),icC:KI[a.kind][1],txt:a.txt})),
          openRep:()=>{set({rpw:w});if(p.onOpenReport)p.onOpenReport(w);else set({dtab:'reports'});},openRepL:LL('開啟 '+w+' 的週報','Open '+w+'’s report')};});
    }
    if(!dx){
      out.headSegs=ro?[segOf(Object.keys(PER).map(k=>[k,PER[k][0]]),per,v=>set({dper:v}))]:[segOf(t.dtabs,s.dtab||'overview',v=>set({dtab:v}))].concat((s.dtab||'overview')==='overview'?[segOf(Object.keys(PER).map(k=>[k,PER[k][0]]),per,v=>set({dper:v}))]:[]);
      if((s.dtab||'overview')==='overview')out.headActs=[act(LL('匯出報告','Export report'),{dis:false,op:1,tip:'',icon:icn('download',13),on:()=>{if(p.onTab&&screen==='dashboard')p.onTab('dashexport');else set({dx:true});}})];
      const by=s.uBy==='project'?'project':'agent';
      const mk=c=>Object.assign({isLine:false,isStack:false,isBars:false,isList:false,hasSeg:false,seg:[],rows:[],bars:[],parts:[],labelW:'110px',span:'auto',meta:''},c);
      const usage={agent:[['claude-code',62,41.20],['codex',28,18.75],['antigravity',6,3.10]],project:[['ORB',83,52.60],['WEB',17,10.45]]}[by];
      out.bCharts=body;out.chartCols=narrow?'minmax(0,1fr)':'repeat(2,minmax(0,1fr))';
      out.charts=[mk({title:t.dash.state,meta:fmt(t.items,{n:E0?0:36}),isStack:true,span:'1/-1',parts:(E0?[[t.grp.unstarted,1,'var(--o22242a)']]:[[t.grp.completed,18,C.ok],[t.grp.started,9,C.warn],[t.grp.unstarted,7,C.muted],[t.grp.cancelled,2,C.bad]]).map(([label,n,c])=>({label,n:E0?'0':String(n),flex:n,c}))}),
        mk({title:t.dash.blocked,meta:E0?'0':'3',isList:true,rows:(E0?[]:[['ORB-38','s4',LL('審查關卡 3 天','Review gate, 3 days')],['ORB-45','s2',fmt(t.blockedBy,{k:'ORB-36'})],['ORB-47','s4',fmt(t.blockedBy,{k:'ORB-42'})]]).map(([k,sid,b])=>({key:k,title:title(k),icon:sIcon(ST[sid][0],ST[sid][1]),color:ST[sid][1],right:b}))})
      ].concat(ro?[]:[mk({title:t.dash.usage,meta:money(63.05),isBars:true,hasSeg:true,seg:segOf(t.usageBy.filter(x=>x[0]!=='member'),by,v=>set({uBy:v})),
        bars:(E0?[]:usage).map(([k,pct,cost])=>({label:k,icon:by==='agent'?logo(k,16):null,segs:[{w:pct+'%',c:C.acc}],value:money(cost)}))})]);
    }else{
      // ---------- export report ----------
      out.head=LL('匯出報告','Export report');out.hasTitle=true;out.hasTabs=false;out.headSegs=[];
      const back=()=>{if(screen==='dashexport'&&p.onTab)p.onTab('dashboard');else set({dx:false});};
      const ex=Object.assign({fmt:'pdf',who:['kashionz','mei-lin','chen-yu'],sec:['sum','kpi','members','detail','blocked'],send:false},s.ex||{});
      const up=o=>set({ex:Object.assign({},ex,o)});
      const FM={pdf:[LL('PDF 報告','PDF report'),LL('排好版的報告，適合寄出或列印','A formatted report to send or print'),'file'],csv:[LL('CSV 原始資料','CSV data'),LL('每筆活動一列，可用 Excel 再分析','One row per activity, for Excel'),'table'],md:[LL('Markdown','Markdown'),LL('貼到 Wiki 或 Email','Paste into the wiki or email'),'code']};
      const SEC=[['sum',LL('本期重點','Highlights')],['kpi',LL('關鍵數字','Key numbers')],['members',LL('成員一覽','Members at a glance')],['detail',LL('每位成員做了什麼','What each member did')],['blocked',LL('卡住的任務','Blocked tasks')]];
      const has=k=>ex.sec.indexOf(k)>=0;const whoMB=MB.filter(r=>ex.who.indexOf(r[0])>=0);
      const box=on=>({sel:String(on),bd:on?C.acc:'var(--o3d4047)',fill:on?C.acc:'transparent',ck:on?icn('check',10):null});
      const PAV={kashionz:['#e0e7ff','#3730a3'],'mei-lin':['#fce7f3','#9d174d'],'chen-yu':['#dcfce7','#166534']};
      const TAG={done:[LL('完成','Done'),'#dcfce7','#166534'],pr:[LL('合併','Merged'),'#e0e7ff','#3730a3'],review:[LL('核准','Approved'),'#e0f2fe','#075985'],return:[LL('退回','Returned'),'#fef3c7','#92400e'],run:[LL('派工','Dispatched'),'#f3f4f6','#374151'],blocked:[LL('卡住','Blocked'),'#fee2e2','#991b1b']};
      const strip=a=>{if(a.kind==='blocked')return a.txt;const x=a.txt.replace(/^\S+\s+/,'');return lang==='en'?x.charAt(0).toUpperCase()+x.slice(1):x;};
      const isMonth=per==='month';const docTitle=isMonth?LL('團隊月報','Team monthly report'):LL('團隊週報','Team weekly report');
      const page2=has('detail')||has('blocked');const nPages=page2?2:1;
      const pg=n=>LL('第 '+n+' 頁，共 '+nPages+' 頁','Page '+n+' of '+nPages);
      const good=['#dcfce7','#166534'],flat=['#f3f4f6','#374151'],warnC=['#fef3c7','#92400e'];
      const totR=MB.reduce((a,r)=>a+r[4],0),totB=MB.reduce((a,r)=>a+r[3],0);
      out.bExport=body;out.exCols=narrow?'minmax(0,1fr)':'280px minmax(0,1fr)';
      out.ex={back,backL:LL('返回儀表板','Back to dashboard'),icBack:icn('chevL',14),
        perL:LL('期間','Period'),per:segOf(Object.keys(PER).map(k=>[k,PER[k][0]]),per,v=>set({dper:v})),perRange:PER[per][1],
        whoL:LL('成員','Members'),who:MB.map(r=>Object.assign({label:r[0],av:av(r[0],18),on:()=>up({who:ex.who.indexOf(r[0])>=0?ex.who.filter(x=>x!==r[0]):ex.who.concat([r[0]])})},box(ex.who.indexOf(r[0])>=0))),
        secL:LL('內容','Sections'),secs:SEC.map(([k,l])=>Object.assign({label:l,dis:ex.fmt==='csv',op:ex.fmt==='csv'?0.45:1,on:()=>{if(ex.fmt!=='csv')up({sec:has(k)?ex.sec.filter(x=>x!==k):ex.sec.concat([k])});}},box(has(k)&&ex.fmt!=='csv'))),secNote:ex.fmt==='csv'?LL('CSV 只匯出活動明細','CSV exports activity rows only'):'',hasSecNote:ex.fmt==='csv',
        fmtL:LL('格式','Format'),fmts:Object.keys(FM).map(k=>({label:FM[k][0],sub:FM[k][1],icon:icn(FM[k][2],14),sel:String(ex.fmt===k),bd:ex.fmt===k?C.acc:'var(--o26292e)',bg:ex.fmt===k?'var(--tint-accent-08, rgba(127,176,250,.08))':'transparent',dot:ex.fmt===k?C.acc:'transparent',dotBd:ex.fmt===k?C.acc:'var(--o4c5058)',on:()=>up({fmt:k})})),
        sendL:LL('同時寄給主管','Also send to managers'),sendSub:LL('用 Email 寄給 mei-lin，附上這份 PDF','Email mei-lin with this PDF attached'),sendOn:String(!!ex.send),sendBg:ex.send?C.acc:'var(--o3d4047)',sendKnob:ex.send?'14px':'2px',togSend:()=>up({send:!ex.send}),hasSend:false,
        go:()=>{if(!whoMB.length)return;flash(ex.fmt==='pdf'?(ex.send?LL('已下載 PDF，並寄給 mei-lin','PDF downloaded and sent to mei-lin'):LL('已下載 orbis-週報-10-19.pdf','Downloaded orbis-report-oct-19.pdf')):ex.fmt==='csv'?LL('已下載 orbis-活動-10-19.csv','Downloaded orbis-activity-oct-19.csv'):LL('已複製 Markdown','Markdown copied'));},
        goL:ex.fmt==='pdf'?LL('下載 PDF','Download PDF'):ex.fmt==='csv'?LL('下載 CSV','Download CSV'):LL('複製 Markdown','Copy Markdown'),goIc:icn(ex.fmt==='md'?'copy':'download',14),goDis:!whoMB.length,goOp:whoMB.length?1:0.45,noWho:!whoMB.length,noWhoL:LL('至少選一位成員','Pick at least one member'),
        isPdf:ex.fmt==='pdf',isCsv:ex.fmt==='csv',isMd:ex.fmt==='md',previewL:LL('預覽','Preview'),pages:ex.fmt==='pdf'?LL('共 '+nPages+' 頁',nPages+(nPages>1?' pages':' page')):'',
        // ---- paper ----
        brand:'Orbis',docTitle,perPill:PER[per][0],docLead:LL('Kash Studio 在 ORB 專案的進度、成員成果與需要協助的地方。','Progress, member results and where help is needed for Kash Studio on project ORB.'),
        infos:[[LL('團隊','Team'),'Kash Studio'],[LL('專案','Project'),'ORB'],[LL('期間','Period'),PER[per][1]],[LL('產生日期','Generated'),LL('2026/10/26','Oct 26, 2026')]].map(([k,v])=>({k,v})),
        hasP2:page2,p1:pg(1),p2:pg(nPages),runHead:docTitle+'  ·  '+PER[per][1],foot:LL('內部資料，請勿外流','Internal. Please don’t share.'),
        hasSum:has('sum'),sumH:LL(PER[per][0]+'重點','Highlights'),sum:[LL('完成 '+sc(13)+' 個任務、合併 '+sc(9)+' 個合併請求，比上期多 4 個任務。','Completed '+sc(13)+' tasks and merged '+sc(9)+' pull requests, 4 more tasks than last period.'),LL('Windows 換行修正（ORB-42）與執行器長路徑支援（ORB-36）已上線。','The Windows line-ending fix (ORB-42) and runner long-path support (ORB-36) shipped.'),LL('發票按比例計算（ORB-38）在審查關卡等了 3 天，需要 mei-lin 回覆；chen-yu 有 2 個任務在等相依任務。','Prorated invoices (ORB-38) has waited 3 days at the review gate for mei-lin; chen-yu has 2 tasks waiting on dependencies.')].map((x,i)=>({x,n:String(i+1)})),
        hasKpi:has('kpi'),kpis:[[LL('完成的任務','Tasks completed'),sc(13),LL('▲ 4 比上期','▲ 4 vs last'),good],[LL('合併請求','Pull requests merged'),sc(9),LL('▲ 2 比上期','▲ 2 vs last'),good],[LL('完成的審查','Reviews done'),sc(totR),LL('平均 1 天內','Within 1 day on avg'),flat],[LL('卡住的任務','Blocked tasks'),E0?0:totB,LL('最久 3 天','Longest 3 days'),warnC]].map(([l,v,d,c])=>({l,v:String(v),d:E0?'—':d,dBg:c[0],dC:c[1]})),
        hasMembers:has('members'),memH:LL('成員一覽','Members at a glance'),memCols:[LL('成員','Member'),LL('完成','Done'),LL('進行中','In progress'),LL('卡住','Blocked'),LL('審查','Reviews'),'PR',LL('完成率','Completion')].map((l,i)=>({l,al:i===0?'left':(i===6?'left':'center')})),
        memRows:whoMB.map((r,i)=>{const d=sc(r[1]),ip=sc(r[2]),b=sc(r[3]);const pct=d+ip+b?Math.round(d/(d+ip+b)*100):0;return {n:r[0],init:r[0][0].toUpperCase(),avBg:PAV[r[0]][0],avC:PAV[r[0]][1],bg:i%2?'#fafafa':'#ffffff',
          d:String(d),ip:String(ip),rv:String(sc(r[4])),pr:String(sc(r[5])),b:String(b),bBg:b?'#fef3c7':'transparent',bC:b?'#92400e':'#9ca3af',pct:pct+'%',pctL:pct+'%'};}),
        hasDetail:has('detail'),detH:LL('每位成員做了什麼','What each member did'),
        det:whoMB.map(r=>({n:r[0],init:r[0][0].toUpperCase(),avBg:PAV[r[0]][0],avC:PAV[r[0]][1],
          stats:[[LL('完成','Done'),sc(r[1])],[LL('進行中','In progress'),sc(r[2])],[LL('卡住','Blocked'),sc(r[3])]].map(([l,v])=>({l,v:String(v)})),
          items:(E0?[]:ACT[r[0]]).map(a=>({d:a.day.replace(/^週. /,'').replace(/^[A-Z][a-z]{2} /,''),tag:TAG[a.kind][0],tagBg:TAG[a.kind][1],tagC:TAG[a.kind][2],x:strip(a)})),none:E0,noneL:LL('這段期間沒有活動','No activity in this period')})),
        hasBlocked:has('blocked'),blkH:LL('卡住的任務','Blocked tasks'),
        blk:E0?[]:[['ORB-38',title('ORB-38'),LL('等審查關卡','Waiting on review'),'mei-lin',3],['ORB-45',title('ORB-45'),LL('等 ORB-36 完成','Waiting on ORB-36'),'chen-yu',2],['ORB-47',title('ORB-47'),LL('等 ORB-42 完成','Waiting on ORB-42'),'chen-yu',1]].map(([k,ti,w,o,d])=>({k,ti,w,o,d:LL(d+' 天',d+(d>1?' days':' day'))})),
        blkNone:E0,blkNoneL:LL('沒有卡住的任務','Nothing is blocked'),
        empty:!whoMB.length,
        // csv
        csvHead:['date','member','action','task','title','project'],
        csvRows:E0?[]:whoMB.reduce((a,r)=>a.concat((ACT[r[0]]||[]).map(x=>{const m=x.txt.match(/(ORB-\d+|#\d+)/);return {c:['2026-10-'+((x.day.match(/(\d+)$/)||[0,'24'])[1]),r[0],x.kind,m?m[1]:'',x.txt.replace(/^\S+\s+(ORB-\d+|#\d+)?\s*/,'').slice(0,28),'ORB'].map(v=>({v}))};})),[]),
        csvMore:LL('共 '+(E0?0:sc(76))+' 列，預覽前 '+Math.min(14,whoMB.length*5)+' 列','76 rows; showing the first few'),
        // markdown
        md:['# '+docTitle+'  '+PER[per][1],'','## '+LL(PER[per][0]+'重點','Highlights'),'- '+LL('完成 '+sc(13)+' 個任務、合併 '+sc(9)+' 個合併請求','Completed '+sc(13)+' tasks, merged '+sc(9)+' pull requests'),'- '+LL('ORB-38 在審查關卡等了 3 天','ORB-38 has waited 3 days at review'),'','## '+LL('成員一覽','Members'),'| '+LL('成員 | 完成 | 進行中 | 卡住 | PR','Member | Done | In progress | Blocked | PR')+' |','|---|---:|---:|---:|---:|'].concat(whoMB.map(r=>'| '+r[0]+' | '+sc(r[1])+' | '+sc(r[2])+' | '+sc(r[3])+' | '+sc(r[5])+' |')).join('\n')};
    }
  }
  if(screen==='palette'){
    const q=(s.palQ||'').toLowerCase();
    const items=[['task','file','ORB-42',title('ORB-42'),'Orbis'],['task','file','ORB-38',title('ORB-38'),'Orbis'],['task','file','WEB-12',title('WEB-12'),'Web'],['run','play','run_8f2a','claude-code  Sonnet 5.5','ORB-42'],['conv','msg','',lang==='en'?'Why does CRLF break the parser':'為什麼 CRLF 會讓解析器出錯',lang==='en'?'Yesterday':'昨天'],['comment','msg','',lang==='en'?'“Keep .gitattributes unchanged”':'「先不要動 .gitattributes」','ORB-42'],['wiki','book','',lang==='en'?'Billing design':'帳務設計',lang==='en'?'Team':'團隊'],['skill','zap','','windows-path-fix','v3']].concat(t.pAct.map(([l,k])=>['action','zap','',l,k]));
    const f=items.filter(x=>!q||(x[2]+' '+x[3]).toLowerCase().indexOf(q)>=0);
    const shown=isEmptyState?[]:f;
    const selI=Math.min(s.palSel||0,Math.max(0,shown.length-1));
    out.bPalette=!isLoading&&!isError;out.palQ=isEmptyState&&!s.palQ?'zzz':(s.palQ||'');out.onPalQ=e=>set({palQ:e.target.value,palSel:0});
    out.palKey=e=>{if(e.key==='ArrowDown'){e.preventDefault();set({palSel:Math.min(selI+1,shown.length-1)});}if(e.key==='ArrowUp'){e.preventDefault();set({palSel:Math.max(selI-1,0)});}if(e.key==='Enter'&&shown[selI]){flash(fmt(t.opened,{x:shown[selI][2]||shown[selI][3]}));}if(e.key==='Escape'&&p.onClose)p.onClose();};
    const gs=[];shown.forEach((x,i)=>{let g=gs.find(y=>y.k===x[0]);if(!g){g={k:x[0],label:t.pg[x[0]],rows:[]};gs.push(g);}g.rows.push({icon:icn(x[1],14),hasKey:!!x[2],key:x[2],title:x[3],meta:x[4],bg:i===selI?'var(--o1c1e22)':'transparent',hover:()=>{if(selI!==i)set({palSel:i});},on:()=>flash(fmt(t.opened,{x:x[2]||x[3]}))});});
    out.palGroups=gs;out.palNone=!shown.length;out.isEmpty=false;
  }
  if(window.__orbisMore&&window.__orbisMore[screen])window.__orbisMore[screen]({out,s,p,set,flash,lang,ro,narrow,isEmptyState,body,row,grp,chip,pill,act,primary,segOf,optOf,icn,sIcon,pIcon,av,logo,dot,C,fmt,df,title,dlg,menu,menus});
  out.bList=(body||(isEmptyState&&out.isEmpty===false&&!isLoading&&!isError))&&out.groups.length>0&&!out.bPalette;
  if(window.__orbisDlg)window.__orbisDlg.run({out,s,p,set,flash,lang,ro,st,icn,C,df,title,t,cmp});
  finishMenu();
  return out;
};
})();
