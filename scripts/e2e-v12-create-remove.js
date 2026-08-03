// [V12] Live E2E via create() (deploys ONE pool internally, unlike launch which
// deploys two and never lands on this devnet node). Proves the full creator
// flow: deploy test token -> create(WOCT/token pool) -> accept_ownership ->
// verify getters -> remove_liquidity (drain) -> remove_pool -> verify removed.
// Usage: MNEMONIC="..." node scripts/e2e-v12-create-remove.js
const crypto = require('crypto'); const nacl = require('tweetnacl'); const bs58 = require('bs58');
const fs = require('fs'); const path = require('path');
const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const D = JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
const FACTORY = D.SwapFactory, WOCT = D.WOCT, ROUTER = D.Router;

async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const d=await r.json();if(d.error)throw new Error(m+': '+d.error.message);return d.result;}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
async function receipt(h,max=90){for(let i=0;i<max;i++){try{const r=await rpc('contract_receipt',[h]);if(r&&r.success!==undefined)return r;}catch{}await new Promise(r=>setTimeout(r,2000));}throw new Error('receipt timeout '+h);}
const N={v:0}; async function seed(a){N.v=(await rpc('octra_balance',[a])).nonce;}
async function fee(t){try{const f=await rpc('octra_recommendedFee',[t]);return String(f.recommended||f.minimum||(t==='deploy'?'200000':'2000'));}catch{return t==='deploy'?'200000':'2000';}}
function scalar(r){return r&&typeof r==='object'?(r.result??null):r;}
async function view(a,m,p=[]){return rpc('contract_call',[a,m,p]);}
async function call(from,to_,method,params,sk,label,ou,maxWait=90){
  N.v+=1; let ts=Date.now()/1000; if(ts%1===0)ts+=1e-6;
  const tx={from,to_,amount:'0',nonce:N.v,ou:ou||await fee('call'),timestamp:ts,op_type:'call',encrypted_data:method,message:JSON.stringify(params)};
  sign(tx,sk); const r=await rpc('octra_submit',[tx]); const rc=await receipt(r.tx_hash,maxWait);
  console.log(`  ${rc.success?'OK':'FAIL'} ${label} (${r.tx_hash.slice(0,10)}… effort ${rc.effort})`);
  if(!rc.success)throw new Error(label+' failed: '+rc.error); return rc;
}
async function deposit(from,micro,sk){N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from,to_:WOCT,amount:micro,nonce:N.v,ou:await fee('call'),timestamp:ts,op_type:'call',encrypted_data:'deposit',message:'[]'};sign(tx,sk);const r=await rpc('octra_submit',[tx]);const rc=await receipt(r.tx_hash);console.log(`  ${rc.success?'OK':'FAIL'} deposit ${micro}`);if(!rc.success)throw new Error('deposit '+rc.error);}
async function deployToken(from,sk,supplyRaw){
  const src=fs.readFileSync(path.join(__dirname,'..','contracts','Token.aml'),'utf-8');
  const bc=(await rpc('octra_compileAml',[src])).bytecode;
  N.v+=1; const nonce=N.v;
  const addr=(await rpc('octra_computeContractAddress',[bc,from,nonce])).address;
  const args=JSON.stringify(['E2ECreate','E2C','E2C Token',supplyRaw,'6',from,from,'0','0','0','0',from,'0',true,true,true,true,false,false,false,false,false,ROUTER,'','','','']);
  let ts=Date.now()/1000; if(ts%1===0)ts+=1e-6;
  const tx={from,to_:addr,amount:'0',nonce,ou:await fee('deploy'),timestamp:ts,op_type:'deploy',encrypted_data:bc,message:args};
  sign(tx,sk); const r=await rpc('octra_submit',[tx]); const rc=await receipt(r.tx_hash);
  console.log(`  ${rc.success?'OK':'FAIL'} deploy token -> ${addr} (effort ${rc.effort})`);
  if(!rc.success)throw new Error('token deploy '+rc.error); return addr;
}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}

(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC); const sk=kp.secretKey;
  const bal0=await rpc('octra_balance',[me]); console.log(`Creator ${me} | ${bal0.balance} OCT | factory ${FACTORY}\n`);
  await seed(me);
  const LIQ_TOKEN='1000000', LIQ_WOCT='100000', SUPPLY='1000000000';

  console.log('1) Deploy test token');
  const token=await deployToken(me,sk,SUPPLY);

  console.log('2) Ensure WOCT balance & grant WOCT + token to factory');
  const wbal=scalar(await view(WOCT,'balance_of',[me]));
  if(!wbal||BigInt(wbal)<BigInt(LIQ_WOCT)){await deposit(me,'100000',sk);}else{console.log('  WOCT balance',wbal,'ok');}
  await call(me,WOCT,'grant',[FACTORY,LIQ_WOCT],sk,'grant WOCT');
  await call(me,token,'grant',[FACTORY,LIQ_TOKEN],sk,'grant token');

  console.log('3) create() pool (token / WOCT) — deploys ONE pool internally');
  // create(token_a, token_b, fee_num, fee_den, max_ratio, liq_a, liq_b, min_lp, deadline, lock_duration)
  // token_a=token (creator supply), token_b=WOCT. Both pre-approved above.
  const epoch=(await rpc('epoch_current',[])).epoch_id;
  await call(me,FACTORY,'create',[token,WOCT,3,1000,0,LIQ_TOKEN,LIQ_WOCT,1,epoch+120,0],sk,'create','2000000',150);
  const plen=Number(scalar(await view(FACTORY,'pools_length')));
  const pool=scalar(await view(FACTORY,'get_pool',[token,WOCT]));
  console.log(`  pools_length=${plen}  pool=${pool}`);
  if(!pool)throw new Error('pool not created');

  console.log('4) Verify NEW getters');
  for(const m of ['get_owner','get_pending_owner','get_reserve_a','get_reserve_b','total_lp_supply','get_total_liquidity','is_active','get_fee_numerator','get_fee_denominator']){
    console.log(`  ${m.padEnd(20)} = ${JSON.stringify(scalar(await view(pool,m)))}`);
  }
  const ownerB=scalar(await view(pool,'get_owner')); const pendB=scalar(await view(pool,'get_pending_owner'));
  console.log(`  owner=${ownerB}\n  pending=${pendB}  (expect owner=factory, pending=me=${me})`);

  console.log('5) accept_ownership');
  await call(me,pool,'accept_ownership',[],sk,'accept_ownership');
  const ownerA=scalar(await view(pool,'get_owner'));
  console.log(`  owner now = ${ownerA} ${ownerA===me?'OK creator owns pool':'FAIL'}`);

  console.log('6) drain: remove_liquidity position #1');
  console.log('  position #1 =',JSON.stringify(scalar(await view(pool,'get_position',[1]))));
  const ep2=(await rpc('epoch_current',[])).epoch_id;
  await call(me,pool,'remove_liquidity',[1,0,0,ep2+120],sk,'remove_liquidity');
  const tl=scalar(await view(pool,'get_total_liquidity'));
  console.log(`  total_liquidity = ${tl} ${String(tl)==='0'?'OK drained':'FAIL'}`);

  console.log('7) remove_pool (previously impossible for creators)');
  await call(me,FACTORY,'remove_pool',[pool],sk,'remove_pool');

  console.log('8) Verify deregistered');
  const plen2=Number(scalar(await view(FACTORY,'pools_length')));
  const gp=scalar(await view(FACTORY,'get_pool',[token,WOCT]));
  console.log(`  pools_length ${plen} -> ${plen2}  get_pool='${gp}' ${(!gp||gp==='')?'OK REMOVED':'FAIL still registered'}`);

  const bal1=await rpc('octra_balance',[me]);
  console.log(`\nDONE. Balance ${bal0.balance} -> ${bal1.balance} OCT (spent ${(Number(bal0.balance)-Number(bal1.balance)).toFixed(6)})`);
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
