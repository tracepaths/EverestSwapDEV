const crypto=require('crypto'),nacl=require('tweetnacl'),bs58=require('bs58'),fs=require('fs'),path=require('path');
const RPC=process.env.RPC_URL||'https://devnet.octrascan.io/rpc';
const D=JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
const F=D.SwapFactory,W=D.WOCT;
const POOL=process.argv[2], TOKEN=process.argv[3];
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return r.json();}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}
async function rec(h,max=50){for(let i=0;i<max;i++){await new Promise(x=>setTimeout(x,3000));try{const rc=await rpc('contract_receipt',[h]);if(rc.result&&rc.result.success!==undefined)return rc.result;}catch{}}return null;}
// [FIX] Retry with a bumped fee on 'duplicate nonce (fee rate bump < 10%)'.
// A revert consumes NO nonce on this node, so re-reading octra_balance hands
// back the same nonce and the node rejects the resend unless the fee rises >=10%.
async function call(me,sk,to,m,params,ou){
  let feeOu=parseInt(ou||'1000',10);
  for(let attempt=1;attempt<=4;attempt++){
    const n=(await rpc('octra_balance',[me])).result.nonce+1;
    let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;
    const tx={from:me,to_:to,amount:'0',nonce:n,ou:String(feeOu),timestamp:ts,op_type:'call',encrypted_data:m,message:JSON.stringify(params)};
    sign(tx,sk);
    const r=await rpc('octra_submit',[tx]);
    if(!r.result){
      const d=(r.error&&(r.error.data||r.error.message))||'';
      console.log(`  ${m} submit err (attempt ${attempt}):`,d);
      if(/duplicate nonce|fee rate bump/i.test(String(d))){feeOu=Math.ceil(feeOu*1.25);await new Promise(x=>setTimeout(x,2500));continue;}
      return null;
    }
    const rc=await rec(r.result.tx_hash);
    console.log(`  ${m}: ${rc?('success='+rc.success+' err='+rc.error+' effort='+rc.effort):'NO RECEIPT (may have reverted)'}`);
    if(rc) return rc;
    // no receipt -> likely revert; bump fee and retry once more
    feeOu=Math.ceil(feeOu*1.25);
    await new Promise(x=>setTimeout(x,2500));
  }
  return null;
}
async function v(a,m,p=[]){const r=await rpc('contract_call',[a,m,p]);return r.result&&(r.result.result??null);}
(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC);const sk=kp.secretKey;
  const curOwner=await v(POOL,'get_owner');
  if(curOwner===me){
    console.log('1) accept_ownership — SKIP (already owner)');
  }else{
    console.log('1) accept_ownership');
    await call(me,sk,POOL,'accept_ownership',[]);
    console.log('   owner now:',await v(POOL,'get_owner'),'(me='+me+')');
  }
  console.log('2) remove_liquidity #1 (drain)');
  const ep=(await rpc('epoch_current',[])).result.epoch_id;
  await call(me,sk,POOL,'remove_liquidity',[1,0,0,ep+150]);
  console.log('   total_liquidity:',await v(POOL,'get_total_liquidity'),' total_lp_supply:',await v(POOL,'total_lp_supply'));
  console.log('3) remove_pool');
  await call(me,sk,F,'remove_pool',[POOL]);
  console.log('4) verify');
  console.log('   pools_length:',await v(F,'pools_length'),' get_pool:',JSON.stringify(await v(F,'get_pool',[TOKEN,W])));
  const b=(await rpc('octra_balance',[me])).result;console.log('balance',b.balance);
})().catch(e=>console.error('ERR',e.message));
