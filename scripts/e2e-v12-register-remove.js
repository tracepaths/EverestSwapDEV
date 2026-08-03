// [V12] Live E2E via register_pool (no internal deploy — this devnet node drops
// txs that SPAWN a contract from inside a call, so create()/launch() never land).
// Proves the remove_pool fix end-to-end: deploy token + pool separately, seed
// liquidity, register, verify NEW getters, drain, remove_pool, verify removed.
// The deployer is the pool owner directly (register path), so remove_pool's
// owner check + total_liquidity==0 gate are exercised exactly.
// Usage: MNEMONIC="..." node scripts/e2e-v12-register-remove.js
const crypto=require('crypto'),nacl=require('tweetnacl'),bs58=require('bs58'),fs=require('fs'),path=require('path');
const RPC=process.env.RPC_URL||'https://devnet.octrascan.io/rpc';
const D=JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
const FACTORY=D.SwapFactory,WOCT=D.WOCT,ROUTER=D.Router;
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const d=await r.json();if(d.error)throw new Error(m+': '+d.error.message);return d.result;}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
async function receipt(h,max=90){for(let i=0;i<max;i++){try{const r=await rpc('contract_receipt',[h]);if(r&&r.success!==undefined)return r;}catch{}await new Promise(r=>setTimeout(r,2000));}throw new Error('receipt timeout '+h);}
const N={v:0};async function seed(a){N.v=(await rpc('octra_balance',[a])).nonce;}
async function fee(t){try{const f=await rpc('octra_recommendedFee',[t]);return String(f.recommended||f.minimum||(t==='deploy'?'200000':'2000'));}catch{return t==='deploy'?'200000':'2000';}}
function scalar(r){return r&&typeof r==='object'?(r.result??null):r;}
async function view(a,m,p=[]){return rpc('contract_call',[a,m,p]);}
async function call(from,to_,method,params,sk,label,ou,mw=90){N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from,to_,amount:'0',nonce:N.v,ou:ou||await fee('call'),timestamp:ts,op_type:'call',encrypted_data:method,message:JSON.stringify(params)};sign(tx,sk);const r=await rpc('octra_submit',[tx]);const rc=await receipt(r.tx_hash,mw);console.log(`  ${rc.success?'OK':'FAIL'} ${label} (${r.tx_hash.slice(0,10)}… effort ${rc.effort})`);if(!rc.success)throw new Error(label+' failed: '+rc.error);return rc;}
async function deposit(from,micro,sk){N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from,to_:WOCT,amount:micro,nonce:N.v,ou:await fee('call'),timestamp:ts,op_type:'call',encrypted_data:'deposit',message:'[]'};sign(tx,sk);const r=await rpc('octra_submit',[tx]);const rc=await receipt(r.tx_hash);console.log(`  ${rc.success?'OK':'FAIL'} deposit ${micro}`);if(!rc.success)throw new Error('deposit '+rc.error);}
async function deployRaw(from,sk,bc,args,label){N.v+=1;const nonce=N.v;const addr=(await rpc('octra_computeContractAddress',[bc,from,nonce])).address;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from,to_:addr,amount:'0',nonce,ou:await fee('deploy'),timestamp:ts,op_type:'deploy',encrypted_data:bc};if(args)tx.message=args;sign(tx,sk);const r=await rpc('octra_submit',[tx]);const rc=await receipt(r.tx_hash);console.log(`  ${rc.success?'OK':'FAIL'} deploy ${label} -> ${addr} (effort ${rc.effort})`);if(!rc.success)throw new Error(label+' deploy '+rc.error);return addr;}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}

(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC);const sk=kp.secretKey;
  const bal0=await rpc('octra_balance',[me]);console.log(`Creator ${me} | ${bal0.balance} OCT | factory ${FACTORY}\n`);
  await seed(me);
  const LIQ_TOKEN='2000000',LIQ_WOCT='200000',SUPPLY='1000000000';

  console.log('1) Compile + deploy Token and SwapPool (separately, from account)');
  const tokenBc=(await rpc('octra_compileAml',[fs.readFileSync(path.join(__dirname,'..','contracts','Token.aml'),'utf-8')])).bytecode;
  const poolBc =(await rpc('octra_compileAml',[fs.readFileSync(path.join(__dirname,'..','contracts','SwapPool.aml'),'utf-8')])).bytecode;
  const tokenArgs=JSON.stringify(['E2EReg','E2R','E2R Token',SUPPLY,'6',me,me,'0','0','0','0',me,'0',true,true,true,true,false,false,false,false,false,ROUTER,'','','','']);
  const token=await deployRaw(me,sk,tokenBc,tokenArgs,'Token');
  const pool =await deployRaw(me,sk,poolBc,null,'SwapPool');

  console.log('2) Configure pool');
  await call(me,pool,'set_tokens',[token,WOCT],sk,'set_tokens');
  await call(me,pool,'set_factory',[FACTORY],sk,'set_factory');
  await call(me,pool,'set_fee_params',[3,1000],sk,'set_fee_params');

  console.log('3) Fund + seed liquidity (deployer is owner -> first-liq allowed)');
  const wbal=scalar(await view(WOCT,'balance_of',[me]));
  if(!wbal||BigInt(wbal)<BigInt(LIQ_WOCT)){await deposit(me,String(BigInt(LIQ_WOCT)-BigInt(wbal||'0')),sk);}
  await call(me,token,'grant',[pool,LIQ_TOKEN],sk,'grant token->pool');
  await call(me,WOCT,'grant',[pool,LIQ_WOCT],sk,'grant WOCT->pool');
  const ep=(await rpc('epoch_current',[])).epoch_id;
  await call(me,pool,'add_liquidity',[LIQ_TOKEN,LIQ_WOCT,1,ep+120,0],sk,'add_liquidity',null,120);

  console.log('4) register_pool on factory');
  await call(me,FACTORY,'register_pool',[token,WOCT,pool],sk,'register_pool');
  const plen=Number(scalar(await view(FACTORY,'pools_length')));
  console.log('  pools_length =',plen,' get_pool=',scalar(await view(FACTORY,'get_pool',[token,WOCT])));

  console.log('5) Verify NEW getters (the whole point of V12)');
  for(const m of ['get_owner','get_pending_owner','get_reserve_a','get_reserve_b','total_lp_supply','get_total_liquidity','is_active','get_fee_numerator','get_fee_denominator']){
    console.log(`  ${m.padEnd(20)} = ${JSON.stringify(scalar(await view(pool,m)))}`);
  }
  const owner=scalar(await view(pool,'get_owner'));
  console.log(`  owner = ${owner} ${owner===me?'OK (deployer owns pool)':'FAIL'}`);

  console.log('6) drain user liquidity (remove_liquidity #1)');
  console.log('  position #1 =',JSON.stringify(scalar(await view(pool,'get_position',[1]))));
  const ep2=(await rpc('epoch_current',[])).epoch_id;
  await call(me,pool,'remove_liquidity',[1,0,0,ep2+120],sk,'remove_liquidity',null,120);
  const tl=scalar(await view(pool,'get_total_liquidity'));
  console.log(`  total_liquidity = ${tl} ${String(tl)==='0'?'OK drained':'FAIL not drained'}`);
  console.log(`  total_lp_supply = ${scalar(await view(pool,'total_lp_supply'))} (stays >0: burned minimum — this is why the old reserves/total_lp gate was impossible)`);

  console.log('7) remove_pool — the fix under test');
  await call(me,FACTORY,'remove_pool',[pool],sk,'remove_pool');

  console.log('8) Verify deregistered');
  const plen2=Number(scalar(await view(FACTORY,'pools_length')));
  const gp=scalar(await view(FACTORY,'get_pool',[token,WOCT]));
  console.log(`  pools_length ${plen} -> ${plen2}  get_pool='${gp}' ${(!gp||gp===''||gp==='0')?'OK REMOVED ✓':'FAIL still registered'}`);

  const bal1=await rpc('octra_balance',[me]);
  console.log(`\nDONE. Balance ${bal0.balance} -> ${bal1.balance} OCT (spent ${(Number(bal0.balance)-Number(bal1.balance)).toFixed(6)})`);
  console.log(`Pool ${pool}\nToken ${token}`);
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
