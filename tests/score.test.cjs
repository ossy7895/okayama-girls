const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=__dirname;
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const payload=Buffer.from(html.match(/<script id="live-v98-payload"[^>]*>(.*?)<\/script>/s)[1],'base64').toString();
const source=payload.match(/<script>(.*?)<\/script>/s)[1];

function extract(name){
 const start=html.indexOf('    function '+name+'(');assert.ok(start>=0,name);
 const tail=html.slice(start);const end=tail.indexOf('\n    }');assert.ok(end>=0,name);
 return tail.slice(0,end+6);
}
class Element{
 constructor(id=''){this.id=id;this.style={};this.dataset={};this.listeners={};this.children=[];this.value='';this.textContent='';this.flags=new Set();this.classList={add:(...a)=>a.forEach(x=>this.flags.add(x)),remove:(...a)=>a.forEach(x=>this.flags.delete(x)),contains:x=>this.flags.has(x),toggle:(x,on)=>{on=on??!this.flags.has(x);if(on)this.flags.add(x);else this.flags.delete(x);return on;}};}
 set innerHTML(x){this._html=x;this.children=[];}get innerHTML(){return this._html||'';}
 addEventListener(t,f){(this.listeners[t]??=[]).push(f);}setAttribute(k,v){this[k]=v;}
 appendChild(e){this.children.push(e);return e;}querySelectorAll(){return [];}querySelector(){return null;}
 click(){for(const f of this.listeners.click||[])f({target:this});}scrollTo(){}closest(){return null;}
}
function dom(){const elements=new Map();return {elements,getElementById(id){if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);},createElement:()=>new Element(),querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}};}
function fixture({half='表',side='先攻',outs=0,connected=true}={}){
 const document=dom(),messages=[],tasks=[];
 const members=Array.from({length:9},(_,i)=>({id:'p'+(i+1),name:'検証選手'+(i+1),num:String(i+1)}));
 const initial={inning:1,half,score:0,balls:0,strikes:0,outs,selectedPosition:'',selectedBallResult:null,bases:{first:null,second:null,third:null},lastBatterSerial:0,logs:[]};
 const parentDoc=dom(),childWindow={},handlers={};
 const liveState={inning:1,half,ball:0,strike:0,out:outs,logs:[],inningScores:{team:{},opponent:{}},battingOrder:members.map(m=>m.id),battingIndex:0,batterId:'p1',pitcherId:'p9',fieldingPositions:{p9:'投'},teamScore:0,opponentScore:0};
 const p={liveGameId:"test-game",document:parentDoc,liveState,currentMembers:members,currentLiveSide:side,cloneLiveState:x=>JSON.parse(JSON.stringify(x)),window:{addEventListener:(type,f)=>(handlers[type]??=[]).push(f)},setTimeout:f=>{tasks.push(f);return tasks.length;},requestAnimationFrame:()=>{},console,isStaffMember:()=>false,updateLiveUI(){},markLiveChanged(){},saveLiveGame:()=>{p.saved=JSON.parse(JSON.stringify(liveState));},moveToScoreCell(){}};
 const frame=parentDoc.getElementById('live-v98-frame');frame.contentWindow=childWindow;
 childWindow.postMessage=msg=>tasks.push(()=>c.dispatch(msg));
 const c={document,window:{innerWidth:390,addEventListener:(type,f)=>(c.handlers[type]??=[]).push(f),parent:{postMessage:msg=>{messages.push(JSON.parse(JSON.stringify(msg)));tasks.push(()=>{for(const f of handlers.message||[])f({source:childWindow,data:msg});});}}},handlers:{},setTimeout:()=>1,clearTimeout(){},requestAnimationFrame(){},console};
 vm.createContext(c);vm.runInContext(source,c);
 vm.runInContext('globalThis.api={state,siteBridge,history,beginBatterDestination,chooseRunnerOutcome,runnerAction,noBallAction,addCount,render,bridgeSnapshot};',c);
 c.dispatch=msg=>{for(const f of c.handlers.message||[])f({data:msg});};
 vm.createContext(p);
 const names=['normalizeInningScores','recalcTotalsFromInnings','normalizeBattingOrder','assignedPitcherId','syncCurrentBatterFromOrder','advanceBatterOrder','orderedLiveBatters','emptyPlayerStats','formatInningsFromOuts','calculatePlayerStatsFromLogs','revisionRuns','legacyRevisionState','revisionMemberId'];
 vm.runInContext(names.map(extract).join('\n'),p);
 const bridgeStart=html.indexOf('    // v9.9 bridge:');const bridgeEnd=html.indexOf('    // Keep browsing context',bridgeStart);
 vm.runInContext(html.slice(bridgeStart,bridgeEnd),p);
 Object.assign(c.api.state,initial);
 Object.assign(c.api.siteBridge,{connected,side,members,battingOrder:members.map(m=>m.id),batterId:'p1',pitcherId:'p9',fieldingPositions:{p9:'投'}});
 function flush(){let n=0;while(tasks.length){if(++n>100)throw Error('message loop');tasks.shift()();}}
 function runner(base,id='p2'){c.api.state.bases[base]={id,name:members.find(m=>m.id===id)?.name||id,team:half==='表'?'self':'opponent'};}
 function ball(kind,dest,outcomes=[]){c.api.state.selectedPosition='中堅';c.api.state.selectedBallResult={kind,label:kind==='hit'?'安打':kind==='error'?'中失':kind==='ground'?'中ゴロ':'中飛'};c.api.beginBatterDestination(dest);for(const to of outcomes)c.api.chooseRunnerOutcome(to);}
 function action(base,act){vm.runInContext(`selectedRunnerBase=${JSON.stringify(base)}`,c);c.api.runnerAction(act);}
 return {c,p,document,messages,tasks,flush,runner,ball,action,state:c.api.state,stats:()=>p.calculatePlayerStatsFromLogs(liveState.logs),ls:liveState};
}
const results=[];
function check(id,name,expected,run){try{const actual=run();results.push({id,name,expected,actual,pass:JSON.stringify(actual)===JSON.stringify(expected)});}catch(e){results.push({id,name,error:String(e),pass:false});}}
function logs(f){return f.ls.logs.map(x=>x.result);}
function stat(f,id='p1'){return f.stats().get(id);}
check('B01','単打：一塁走者と1打席1打数1安打',{base:'p1',pa:1,ab:1,h:1},()=>{const f=fixture();f.ball('hit','first');f.flush();const s=stat(f);return {base:f.state.bases.first?.id,pa:s.batting.pa,ab:s.batting.ab,h:s.batting.h};});
for(const [id,dest,key]of [['B02','second','doubles'],['B03','third','triples']])check(id,dest==='second'?'二塁打':'三塁打',{base:'p1',h:1,type:1},()=>{const f=fixture();f.ball('hit',dest);f.flush();const s=stat(f);return {base:f.state.bases[dest]?.id,h:s.batting.h,type:s.batting[key]};});
check('B04','満塁本塁打：4得点4打点',{score:4,runs:4,rbi:4,hr:1},()=>{const f=fixture();f.runner('first','p2');f.runner('second','p3');f.runner('third','p4');f.ball('hit','home',['home','home','home']);f.flush();return {score:f.ls.teamScore,runs:f.ls.logs.reduce((n,p)=>n+p.runs,0),rbi:stat(f).batting.rbi,hr:stat(f).batting.hr};});
for(const [id,action,label]of [['B05','walk','四球'],['B06','hbp','死球'],['B07','ibb','敬遠']])check(id,label+'：満塁押し出しの1打点',{score:1,rbi:1,pa:1,ab:0},()=>{const f=fixture();f.runner('first','p2');f.runner('second','p3');f.runner('third','p4');f.c.api.noBallAction(action);f.flush();const s=stat(f).batting;return {score:f.ls.teamScore,rbi:s.rbi,pa:s.pa,ab:s.ab};});
check('B08','四球：二・三塁だけなら走者は押し出さない',{first:'p1',second:'p3',third:'p4',score:0},()=>{const f=fixture();f.runner('second','p3');f.runner('third','p4');f.c.api.noBallAction('walk');f.flush();return {first:f.state.bases.first?.id,second:f.state.bases.second?.id,third:f.state.bases.third?.id,score:f.ls.teamScore};});
check('B09','三振：1アウト1打数1三振',{out:1,ab:1,so:1},()=>{const f=fixture();f.c.api.noBallAction('strikeout');f.flush();return {out:f.state.outs,ab:stat(f).batting.ab,so:stat(f).batting.so};});
check('B10','3アウトで裏に交代し塁・カウントを空にする',{half:'裏',out:0,first:null,ball:0,strike:0},()=>{const f=fixture({outs:2});f.runner('first');f.c.api.noBallAction('strikeout');f.flush();return {half:f.ls.half,out:f.ls.out,first:f.state.bases.first,ball:f.ls.ball,strike:f.ls.strike};});
check('B11','守備側の三振：投手に三振とアウト',{so:1,out:1},()=>{const f=fixture({half:'裏'});f.c.api.noBallAction('strikeout');f.flush();return {so:stat(f,'p9').pitching.so,out:stat(f,'p9').pitching.outs};});
check('B12','守備側の敬遠：与四球に含める',1,()=>{const f=fixture({half:'裏'});f.c.api.noBallAction('ibb');f.flush();return stat(f,'p9').pitching.bb;});
check('B13','振り逃げ：一塁空なら出塁し三振打数記録',{first:'p1',out:0,so:1,ab:1},()=>{const f=fixture();f.c.api.noBallAction('dropped');f.flush();return {first:f.state.bases.first?.id,out:f.state.outs,so:stat(f).batting.so,ab:stat(f).batting.ab};});
check('B14','振り逃げ：二死一塁ありでも入力できる',{accepted:true,first:'p1',second:'p2'},()=>{const f=fixture({outs:2});f.runner('first');f.c.api.noBallAction('dropped');f.c.api.chooseRunnerOutcome('second');f.flush();return {accepted:f.ls.logs.some(p=>p.result==='振り逃げ'),first:f.state.bases.first?.id,second:f.state.bases.second?.id};});
check('B15','振り逃げ：一塁あり二死未満は拒否',{logs:0,first:'p2'},()=>{const f=fixture();f.runner('first');f.c.api.noBallAction('dropped');f.flush();return {logs:f.ls.logs.length,first:f.state.bases.first?.id};});
check('B16','守備側の振り逃げも投手の奪三振',1,()=>{const f=fixture({half:'裏'});f.c.api.noBallAction('dropped');f.flush();return stat(f,'p9').pitching.so;});
check('B17','犠牲フライ：犠飛1・打数0・打点1',{result:'犠飛',ab:0,sf:1,rbi:1},()=>{const f=fixture();f.runner('third');f.ball('fly','out',['home']);f.flush();const s=stat(f).batting;return {result:f.ls.logs.at(-1).result,ab:s.ab,sf:s.sf,rbi:s.rbi};});
check('B18','ゴロの出塁（野手選択相当）：打席打数に含める',{pa:1,ab:1},()=>{const f=fixture();f.runner('first');f.ball('ground','first',['out']);f.flush();const s=stat(f).batting;return {pa:s.pa,ab:s.ab};});
check('B19','併殺：投手アウトを重複させず2個',{stateOuts:2,pitchingOuts:2},()=>{const f=fixture({half:'裏'});f.runner('first','opponent');f.ball('ground','out',['out']);f.flush();return {stateOuts:f.state.outs,pitchingOuts:stat(f,'p9').pitching.outs};});
check('B20','併殺の送球順・フォース/タッグを入力する手段',true,()=>/送球順/.test(payload)&&/out-force/.test(payload)&&/out-tag/.test(payload));
check('B21','二死満塁：第三アウトがフォースなら得点なし',0,()=>{const f=fixture({outs:2});f.runner('third','p4');f.runner('second','p3');f.runner('first','p2');f.ball('ground','first',['home','third','out']);f.flush();return f.ls.teamScore;});
check('B22','ゴロの間の生還：打点を付けられる',1,()=>{const f=fixture();f.runner('third');f.ball('ground','out',['home']);f.flush();return stat(f).batting.rbi;});
check('B23','生還走者ログの選手IDを維持','p2',()=>{const f=fixture();f.runner('third');f.ball('hit','first',['home']);f.flush();return f.ls.logs.find(p=>p.result==='生還').playerId;});
check('B24','失策出塁：打数1・安打0',{ab:1,h:0},()=>{const f=fixture();f.ball('error','first');f.flush();return {ab:stat(f).batting.ab,h:stat(f).batting.h};});
check('R01','盗塁：一塁から二塁・走者の盗塁1',{first:null,second:'p2',sb:1},()=>{const f=fixture();f.runner('first');f.action('first','steal-success');f.flush();return {first:f.state.bases.first,second:f.state.bases.second?.id,sb:stat(f,'p2').batting.sb};});
check('R02','盗塁死：走者消去・1アウト',{first:null,out:1},()=>{const f=fixture();f.runner('first');f.action('first','steal-failed');f.flush();return {first:f.state.bases.first,out:f.state.outs};});
check('R03','本盗：得点1・盗塁1',{score:1,runs:1,sb:1},()=>{const f=fixture();f.runner('third');f.action('third','steal-success');f.flush();return {score:f.ls.teamScore,runs:f.ls.logs.at(-1).runs,sb:stat(f,'p2').batting.sb};});
check('R04','進塁で本塁：表示得点とログ得点を一致',{score:1,runs:1},()=>{const f=fixture();f.runner('third');f.action('third','advance');f.flush();return {score:f.ls.teamScore,runs:f.ls.logs.at(-1).runs};});
check('R05','生還ボタン：得点加算・打点0',{score:1,rbi:0},()=>{const f=fixture();f.runner('third');f.action('third','score');f.flush();return {score:f.ls.teamScore,rbi:f.ls.logs.at(-1).rbi};});
check('R06','満塁の一塁走者を生還させると前位走者も生還する',{score:3,second:null,third:null},()=>{const f=fixture();f.runner('first','p2');f.runner('second','p3');f.runner('third','p4');f.action('first','score');f.flush();return {score:f.ls.teamScore,second:f.state.bases.second?.id||null,third:f.state.bases.third?.id||null};});
check('R07','次塁が埋まる場合は盗塁拒否・状態維持',{first:'p2',second:'p3',logs:0},()=>{const f=fixture();f.runner('first');f.runner('second','p3');f.action('first','steal-success');f.flush();return {first:f.state.bases.first?.id,second:f.state.bases.second?.id,logs:f.ls.logs.length};});
check('R08','進塁・残塁は打席を進めない',{batter:'p1',index:0},()=>{const f=fixture();f.runner('first');f.action('first','advance');f.flush();return {batter:f.ls.batterId,index:f.ls.battingIndex};});
check('R09','守備で進塁による生還：投手失点にも1点反映',{score:1,pitchingRuns:1},()=>{const f=fixture({half:'裏'});f.runner('third','opponent');f.action('third','advance');f.flush();return {score:f.ls.opponentScore,pitchingRuns:stat(f,'p9').pitching.runs};});
check('S01','打者完了後に次の打者へ',{batter:'p2',index:1},()=>{const f=fixture();f.c.api.noBallAction('walk');f.flush();return {batter:f.ls.batterId,index:f.ls.battingIndex};});
check('S02','Undoで親側のプレーログも元に戻す',{childLogs:0,parentLogs:0,index:0},()=>{const f=fixture();f.c.api.noBallAction('walk');f.flush();f.document.getElementById('undoBtn').click();f.flush();return {childLogs:f.state.logs.length,parentLogs:f.ls.logs.length,index:f.ls.battingIndex};});
check('S03','走者を保存用親状態へ渡す',true,()=>{const f=fixture();f.c.api.noBallAction('walk');f.flush();return !!f.ls.scoreState?.bases?.first;});
check('S04','保存から開き直しても走者が戻る','p1',()=>{const f=fixture();f.c.api.noBallAction('walk');f.flush();const g=fixture();g.c.dispatch({type:'OG_LIVE_PARENT_SYNC',...JSON.parse(JSON.stringify(f.ls)),side:'先攻',members:f.p.currentMembers,logs:f.ls.logs});return g.state.bases.first?.id||null;});
check('S05','4球目で四球、3ストライクで見逃し三振',{balls:0,strikes:0,logs:['四球','見逃し三振']},()=>{const f=fixture();for(let i=0;i<4;i++)f.c.api.addCount('ball');f.flush();for(let i=0;i<3;i++)f.c.api.addCount('strike');f.flush();return {balls:f.state.balls,strikes:f.state.strikes,logs:f.ls.logs.map(p=>p.result)};});
check('S06','打球結果の取消は得点・ログを変えない',{score:0,logs:0},()=>{const f=fixture();f.c.api.history.push(JSON.parse(JSON.stringify(f.state)));f.state.selectedPosition='中堅';f.document.getElementById('battedBallCancel').click();f.flush();return {score:f.ls.teamScore,logs:f.ls.logs.length};});
check('S07','走者結果の取消は得点・ログを変えない',{score:0,first:'p2',logs:0},()=>{const f=fixture();f.runner('first');f.ball('hit','first');f.document.getElementById('runnerConfirmCancel').click();f.flush();return {score:f.ls.teamScore,first:f.state.bases.first?.id,logs:f.ls.logs.length};});
check('S08','後攻は1回裏の安打を自チーム打撃として記録','攻撃',()=>{const f=fixture({half:'裏',side:'後攻'});f.ball('hit','first');f.flush();return f.ls.logs.at(-1).mode;});
check('S09','選手未選択で打撃記録を確定させない',0,()=>{const f=fixture();f.c.api.siteBridge.batterId='';f.c.api.noBallAction('walk');f.flush();return f.ls.logs.length;});
check('S10','投手未選択で守備記録を確定させない',0,()=>{const f=fixture({half:'裏'});f.c.api.siteBridge.pitcherId='';f.c.api.noBallAction('strikeout');f.flush();return f.ls.logs.length;});

check('N01','犠打：進塁を記録し打数を増やさない',{sh:1,ab:0,pa:1,second:'p2'},()=>{const f=fixture();f.runner('first');f.ball('sacrifice','out',['second']);f.flush();return {sh:stat(f).batting.sh,ab:stat(f).batting.ab,pa:stat(f).batting.pa,second:f.state.bases.second?.id};});
check('N02','二死で犠打を確定させない',0,()=>{const f=fixture({outs:2});f.runner('first');f.ball('sacrifice','out');f.flush();return f.ls.logs.length;});
check('N03','二死で犠飛を確定させない',0,()=>{const f=fixture({outs:2});f.runner('third');f.ball('sacfly','out');f.flush();return f.ls.logs.length;});
check('N04','打撃妨害：打席に含め打数から除く',{pa:1,ab:0,first:'p1'},()=>{const f=fixture();f.c.api.noBallAction('interference');f.flush();return {pa:stat(f).batting.pa,ab:stat(f).batting.ab,first:f.state.bases.first?.id};});
check('N05','内野安打は安打1',1,()=>{const f=fixture();f.ball('infield-hit','first');f.flush();return stat(f).batting.h;});
check('N06','バント安打は犠打と混同しない',{h:1,sh:0},()=>{const f=fixture();f.ball('bunt-hit','first');f.flush();return {h:stat(f).batting.h,sh:stat(f).batting.sh};});
check('N07','2ストライク後のファウルは三振にならない',{out:0,strikes:2,logs:0},()=>{const f=fixture();f.state.strikes=2;f.c.api.addCount('foul');f.flush();return {out:f.state.outs,strikes:f.state.strikes,logs:f.ls.logs.length};});
check('N08','ファウルチップの第3ストライクは三振',{out:1,so:1,result:'ファウルチップ三振'},()=>{const f=fixture();f.state.strikes=2;f.c.api.addCount('foul-tip');f.flush();return {out:f.state.outs,so:stat(f).batting.so,result:f.ls.logs.at(-1).result};});
check('N09','見逃しと空振りを区別し両方を三振集計',{results:['見逃し三振','空振り三振'],so:1},()=>{const f=fixture();f.c.api.noBallAction('strikeout-looking');f.flush();f.c.api.noBallAction('strikeout-swing');f.flush();return {results:f.ls.logs.map(p=>p.result),so:stat(f,'p2').batting.so};});
check('N10','第3アウトが生還後のタッグなら得点を認める',1,()=>{const f=fixture({outs:2});f.runner('third','p4');f.runner('first','p2');f.ball('hit','first',['home','out-tag-after']);f.flush();return f.ls.teamScore;});
check('N11','第3アウトが生還前のタッグなら得点を認めない',0,()=>{const f=fixture({outs:2});f.runner('third','p4');f.runner('first','p2');f.ball('hit','first',['home','out-tag-before']);f.flush();return f.ls.teamScore;});
check('N12','三重殺は投手アウト3個とし重複させない',{out:3,half:'表'},()=>{const f=fixture({half:'裏'});f.runner('first','opponent_1');f.runner('second','opponent_2');f.ball('line','out',['out-tag-before','out-tag-before']);f.flush();return {out:stat(f,'p9').pitching.outs,half:f.ls.half};});
check('N13','フライ併殺を打者のゴロ併殺打に含めない',0,()=>{const f=fixture();f.runner('first');f.ball('fly','out',['out-tag-before']);f.flush();return stat(f).batting.gdp;});
check('N14','三重殺になっても既に2アウトなら投手アウトは1個だけ加算',1,()=>{const f=fixture({half:'裏',outs:2});f.runner('first','opponent_1');f.runner('second','opponent_2');f.ball('ground','out');f.flush();return stat(f,'p9').pitching.outs;});
check('N15','失策による二塁到達と二塁打を区別する',{h:0,ab:1,result:'失策',second:'p1'},()=>{const f=fixture();f.ball('error','second');f.flush();return {h:stat(f).batting.h,ab:stat(f).batting.ab,result:f.ls.logs.at(-1).result,second:f.state.bases.second?.id};});
check('N16','送球順と打点を走者なしのプレーにも保存できる','6-3',()=>{const f=fixture();f.state.selectedPosition='遊撃';f.state.selectedBallResult={kind:'ground',label:'遊ゴロ'};f.c.beginBatterDestination('out',{fieldingSequence:'6-3',rbi:0});f.flush();return f.ls.logs.at(-1).fieldingSequence;});
check('N17','四球→3アウト→Undoで前の回の走者と親ログも復元',{half:'表',out:2,first:'p2',logs:0,completed:0},()=>{const f=fixture({outs:2});f.runner('first');f.c.api.noBallAction('strikeout');f.flush();f.document.getElementById('undoBtn').click();f.flush();return {half:f.ls.half,out:f.ls.out,first:f.ls.scoreState.bases.first?.id,logs:f.ls.logs.length,completed:f.ls.completedHalves.length};});
check('N18','再開後の既存ログを次プレーで消さない',2,()=>{const f=fixture();f.c.api.noBallAction('walk');f.flush();const g=fixture();g.c.dispatch({type:'OG_LIVE_PARENT_SYNC',...JSON.parse(JSON.stringify(f.ls)),side:'先攻',gameId:'test-game',members:f.p.currentMembers});g.c.api.noBallAction('strikeout');g.flush();return g.ls.logs.filter(p=>p.plateAppearance).length;});
check('N19','ログ表示の記録名と詳細をHTMLとして解釈させない',true,()=>{const f=fixture();f.state.logs.push({result:'<img src=x onerror=1>',detail:'<svg onload=1>',inning:'1表',player:'検証'});f.c.api.render();const markup=f.document.getElementById('logList').innerHTML;return markup.includes('&lt;img')&&markup.includes('&lt;svg')&&!markup.includes('<svg');});
check('N20','ボークをソフトボールに記録しない',true,()=>{const f=fixture();f.runner('third');assert.throws(()=>f.c.recordRunnerReason('third',{reason:'ボーク',to:'home'}),/不正投球/);return f.ls.logs.length===0;});
check('N21','野球ではボークによる生還を記録できる',{runs:1,balks:1},()=>{const f=fixture({half:'裏'});f.state.rules={sport:'baseball'};f.runner('third','opponent_1');f.c.recordRunnerReason('third',{reason:'ボーク',to:'home',earned:'yes'});f.flush();return {runs:stat(f,'p9').pitching.runs,balks:stat(f,'p9').pitching.balks};});
check('N22','同一暴投で2走者が進んでも暴投は1回',{runs:2,wp:1},()=>{const f=fixture({half:'裏'});f.runner('third','opponent_1');f.runner('second','opponent_2');f.c.recordRunnerReason('third',{reason:'暴投',to:'home',earned:'yes'});f.c.recordRunnerReason('second',{reason:'暴投',to:'home',incident:'previous',earned:'yes'});f.flush();return {runs:stat(f,'p9').pitching.runs,wp:stat(f,'p9').pitching.wp};});
check('N23','不正投球を野球に記録しない',true,()=>{const f=fixture();f.state.rules={sport:'baseball'};f.runner('first');assert.throws(()=>f.c.recordRunnerReason('first',{reason:'不正投球',to:'second'}),/ボーク/);return true;});
check('N24','別の理由のプレーに暴投を連結しない',true,()=>{const f=fixture();f.runner('first');assert.throws(()=>f.c.recordRunnerReason('first',{reason:'暴投',to:'second',incident:'previous'}),/直前/);return true;});
check('N25','塁の重複指定では状態を変更しない',true,()=>{const f=fixture();assert.throws(()=>f.c.setInitialRunners({first:'p2',second:'p2',third:'',reason:'タイブレーク'}),/複数/);return f.state.bases.first===null;});
check('N26','タイブレーク走者に打席・打数を付けない',{pa:0,second:'p2',earned:false},()=>{const f=fixture();f.c.setInitialRunners({first:'',second:'p2',third:'',reason:'タイブレーク'});f.flush();return {pa:[...f.stats().values()].reduce((n,s)=>n+s.batting.pa,0),second:f.state.bases.second.id,earned:f.state.bases.second.earned};});
check('N27','守備時のタイブレーク走者は相手のIDにする',{id:'opponent_2',name:'相手走者2'},()=>{const f=fixture({half:'裏'});f.c.setInitialRunners({first:'',second:'opponent_2',third:'',reason:'タイブレーク'});f.flush();return {id:f.state.bases.second.id,name:f.state.bases.second.name};});
check('N28','自責点を未判定のまま自動的に確定しない',{unknown:1,er:0,era:null},()=>{const f=fixture({half:'裏'});f.runner('third','opponent_1');f.action('third','score');f.flush();const s=stat(f,'p9').pitching;return {unknown:s.unclassifiedRuns,er:s.earnedRuns,era:s.era};});
check('N29','投手交代後も塁上走者の責任投手を保つ',{old:1,current:0},()=>{const f=fixture({half:'裏'});f.runner('third','opponent_1');f.state.bases.third.responsiblePitcherId='p8';f.c.recordRunnerReason('third',{reason:'暴投',to:'home',earned:'yes'});f.flush();return {old:stat(f,'p8').pitching.runs,current:stat(f,'p9').pitching.runs};});
check('N30','ソフトボールの自責点は7回換算で防御率を計算',21,()=>{const f=fixture({half:'裏'});f.runner('third','opponent_1');f.c.recordRunnerReason('third',{reason:'暴投',to:'home',earned:'yes'});f.c.api.noBallAction('strikeout');f.flush();return stat(f,'p9').pitching.era;});
function bench(f){for(let i=10;i<=12;i++)f.c.api.siteBridge.members.push({id:'p'+i,name:'検証控え'+i,num:String(i)});}
check('T01','代打は元の打順を引き継ぐ',{first:'p10',batter:'p10',logs:0},()=>{const f=fixture();bench(f);f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});f.flush();return {first:f.ls.battingOrder[0],batter:f.ls.batterId,logs:[...f.stats().values()].length};});
check('T02','代走は走者の責任投手を保持する',{runner:'p10',pitcher:'p8'},()=>{const f=fixture();bench(f);f.runner('first','p2');f.state.bases.first.responsiblePitcherId='p8';f.c.applyScoreSubstitution({kind:'代走',outgoing:'p2',incoming:'p10'});f.flush();return {runner:f.state.bases.first.id,pitcher:f.state.bases.first.responsiblePitcherId};});
check('T03','出場中の選手を二重に登録しない',true,()=>{const f=fixture();assert.throws(()=>f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p2'}),/既に/);return true;});
check('T04','ソフトの先発は元の打順へ一度だけ再出場可能',true,()=>{const f=fixture();bench(f);f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});f.c.applyScoreSubstitution({kind:'再出場',outgoing:'p10',incoming:'p1'});f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p11'});assert.throws(()=>f.c.applyScoreSubstitution({kind:'再出場',outgoing:'p11',incoming:'p1'}),/再出場/);return f.c.api.siteBridge.battingOrder[0]==='p11';});
check('T05','野球では退いた選手を再出場させない',true,()=>{const f=fixture();bench(f);f.state.rules={sport:'baseball'};f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});assert.throws(()=>f.c.applyScoreSubstitution({kind:'再出場',outgoing:'p10',incoming:'p1'}),/再出場/);return true;});
check('T06','再出場は元の打順以外に入れない',true,()=>{const f=fixture();bench(f);f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});assert.throws(()=>f.c.applyScoreSubstitution({kind:'再出場',outgoing:'p2',incoming:'p1'}),/元の打順/);return true;});
check('T07','代打の取り消しで打順と選手を復元する','p1',()=>{const f=fixture();bench(f);f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});f.flush();f.document.getElementById('undoBtn').click();f.flush();return f.ls.battingOrder[0];});
check('T08','DPとFPを分けて投手をFPにする',{order:9,dp:'',fp:'投',pitcher:'p10'},()=>{const f=fixture();bench(f);f.state.rules={sport:'softball',lineupMode:'dpfp'};f.c.applyDesignatedPlayers({offense:'p9',defense:'p10',position:'投',operation:'separate'});f.flush();return {order:f.ls.battingOrder.length,dp:f.ls.fieldingPositions.p9,fp:f.ls.fieldingPositions.p10,pitcher:f.ls.pitcherId};});
check('T09','DPの守備兼務→FP再出場は一度だけ',true,()=>{const f=fixture();bench(f);f.state.rules={sport:'softball',lineupMode:'dpfp'};const v={offense:'p9',defense:'p10',position:'投'};f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'dp-defense'});f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'dp-defense'});assert.throws(()=>f.c.applyDesignatedPlayers({...v,operation:'separate'}),/再出場/);return true;});
check('T10','FPの打撃兼務解除でDPと現在の打者を戻す',{order:'p9',batter:'p9',fp:'投'},()=>{const f=fixture();bench(f);f.c.api.siteBridge.batterId='p9';f.state.rules={sport:'softball',lineupMode:'dpfp'};const v={offense:'p9',defense:'p10',position:'投'};f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'fp-batting'});f.c.applyDesignatedPlayers({...v,operation:'separate'});f.flush();return {order:f.ls.battingOrder[8],batter:f.ls.batterId,fp:f.ls.fieldingPositions.p10};});
check('T11','DPが他選手の守備を兼務したら元の選手をOPOにする',{dp:'左',opo:'',fp:'投'},()=>{const f=fixture();bench(f);f.c.api.siteBridge.fieldingPositions.p7='左';f.state.rules={sport:'softball',lineupMode:'dpfp'};const v={offense:'p9',defense:'p10',position:'投'};f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'opo-defense',opo:'p7'});f.flush();return {dp:f.ls.fieldingPositions.p9,opo:f.ls.fieldingPositions.p7,fp:f.ls.fieldingPositions.p10};});
check('T12','DHの守備選手は打順外に保持する',{order:9,dh:'',defense:'投'},()=>{const f=fixture();bench(f);f.state.rules={sport:'baseball',lineupMode:'dh'};f.c.applyDesignatedPlayers({offense:'p9',defense:'p10',position:'投',operation:'separate'});f.flush();return {order:f.ls.battingOrder.length,dh:f.ls.fieldingPositions.p9,defense:f.ls.fieldingPositions.p10};});
check('T13','選手交代を保存再開しても打順と役割を保持',{first:'p10',initial:'p1'},()=>{const f=fixture();bench(f);f.c.applyScoreSubstitution({kind:'代打',outgoing:'p1',incoming:'p10'});f.flush();const g=fixture();bench(g);g.c.dispatch({type:'OG_LIVE_PARENT_SYNC',...JSON.parse(JSON.stringify(f.ls)),side:'先攻',gameId:'test-game',members:g.p.currentMembers});return {first:g.c.api.siteBridge.battingOrder[0],initial:g.state.roster.initial[0]};});
check('T14','刺殺・補殺の手動記録を投手アウトと二重計上しない',{putout:1,out:0},()=>{const f=fixture({half:'裏'});f.c.recordFielding({fielder:'p2',kind:'putout',count:1});f.flush();return {putout:stat(f,'p2').fielding.putout,out:stat(f,'p2').pitching.outs};});
check('T15','守備失策と失策出塁を別の選手成績として記録する',1,()=>{const f=fixture({half:'裏'});f.c.recordFielding({fielder:'p2',kind:'error',count:1});f.flush();return stat(f,'p2').fielding.error;});
check('T16','守備記録を攻撃中に確定させない',true,()=>{const f=fixture();assert.throws(()=>f.c.recordFielding({fielder:'p2',kind:'assist',count:1}),/守備/);return true;});
check('T17','古い併殺ログの走塁死を重複集計しない',2,()=>{const f=fixture();return f.p.calculatePlayerStatsFromLogs([{id:'a',mode:'守備',pitcherId:'p9',playId:'old',result:'走塁死'},{id:'b',mode:'守備',pitcherId:'p9',playId:'old',result:'併殺'}]).get('p9').pitching.outs;});
check('T18','古い振り逃げと敬遠も投手成績に反映',{so:1,bb:1},()=>{const f=fixture();const s=f.p.calculatePlayerStatsFromLogs([{mode:'守備',pitcherId:'p9',result:'振り逃げ'},{mode:'守備',pitcherId:'p9',result:'敬遠'}]).get('p9').pitching;return {so:s.so,bb:s.bb};});
check('T19','記録・設定のフォームを開いて取消してもプレーを作らない',0,()=>{const f=fixture();f.c.openScoreSettings();f.c.closeScoreDialog();f.flush();return f.ls.logs.length;});
check('T20','DH解除後は守備専門選手がDHの打順に入る',{mode:'standard',ninth:'p10',terminated:true},()=>{const f=fixture();bench(f);f.state.rules={sport:'baseball',lineupMode:'dh'};const v={offense:'p9',defense:'p10',position:'投'};f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'end-dh'});f.flush();return {mode:f.ls.scoreRules.lineupMode,ninth:f.ls.battingOrder[8],terminated:f.ls.scoreState.roster.dhTerminated};});
check('T21','打者の打点指定を実得点より多く記録しない',1,()=>{const f=fixture();f.runner('third');f.state.selectedPosition='遊撃';f.state.selectedBallResult={kind:'hit',label:'安打'};f.c.beginBatterDestination('first',{rbi:4});f.c.api.chooseRunnerOutcome('home');f.flush();return stat(f).batting.rbi;});
check('T22','終了判定で指定した投手の勝利を保存し打席に加算しない',{wins:1,pa:0},()=>{const f=fixture();f.c.openGameConclusion();const form=f.document.getElementById('scoreToolsForm');form.children[1].children[0].value='p9';form.onsubmit({preventDefault(){}});f.flush();return {wins:stat(f,'p9').pitching.wins,pa:stat(f,'p9').batting.pa};});
check('T23','野球の自責点は9回換算で防御率を計算',27,()=>{const f=fixture({half:'裏'});f.state.rules={sport:'baseball'};f.runner('third','opponent_1');f.c.recordRunnerReason('third',{reason:'暴投',to:'home',earned:'yes'});f.c.api.noBallAction('strikeout');f.flush();return stat(f,'p9').pitching.era;});
check('T24','ファウルフライ捕球を出塁として確定しない',0,()=>{const f=fixture();f.ball('foul-fly','first');f.flush();return f.ls.logs.length;});
check('T25','強襲安打を野手選択へ誤分類しない',1,()=>{const f=fixture();f.ball('hard-hit','first');f.flush();return stat(f).batting.h;});
check('T26','DPのOPO兼務解除で元の守備を戻す',{dp:'',opo:'左',fp:'投'},()=>{const f=fixture();bench(f);f.c.api.siteBridge.fieldingPositions.p7='左';f.state.rules={sport:'softball',lineupMode:'dpfp'};const v={offense:'p9',defense:'p10',position:'投'};f.c.applyDesignatedPlayers({...v,operation:'separate'});f.c.applyDesignatedPlayers({...v,operation:'opo-defense',opo:'p7'});f.c.applyDesignatedPlayers({...v,operation:'separate'});f.flush();return {dp:f.ls.fieldingPositions.p9,opo:f.ls.fieldingPositions.p7,fp:f.ls.fieldingPositions.p10};});

for(const r of results)console.log((r.pass?'PASS':'FAIL')+' '+r.id+' '+r.name+(r.pass?'':' expected '+JSON.stringify(r.expected)+' actual '+JSON.stringify(r.actual??r.error)));
console.log(JSON.stringify({total:results.length,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length}));
assert.ok(results.every(x=>x.pass),'All score regression cases must pass');
