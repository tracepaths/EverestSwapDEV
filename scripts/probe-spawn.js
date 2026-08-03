// Isolate SPAWN-from-call: deploy SpawnProbe, set it to spawn a tiny template
// (reuse SwapPool bytecode), then call do_spawn() and see if it reverts.
const crypto=require('crypto'),nacl=require('tweetnacl'),bs58=require('bs58'),fs=require('fs'),path=require('path');
const RPC=process.env.RPC_URL||'https://devnet.octrascan.io/rpc';
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return r.json();}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}
async function rec(h,max=50){for(let i=0;i<max;i++){await new Promise(x=>setTimeout(x,3000));const rc=await rpc('contract_receipt',[h]);if(rc.result&&rc.result.success!==undefined)return rc.result;}return null;}
const N={v:0};
(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC);const sk=kp.secretKey;
  N.v=(await rpc('octra_balance',[me])).result.nonce;
  const probeBc=(await rpc('octra_compileAml',[fs.readFileSync(path.join(__dirname,'..','contracts','SpawnProbe.aml'),'utf-8')])).result.bytecode;
  // a tiny template to spawn: reuse SpawnProbe itself (small)
  const tmplBc=probeBc;
  console.log('deploy SpawnProbe');
  N.v+=1;const probe=(await rpc('octra_computeContractAddress',[probeBc,me,N.v])).result.address;
  {let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from:me,to_:probe,amount:'0',nonce:N.v,ou:'200000',timestamp:ts,op_type:'deploy',encrypted_data:probeBc};sign(tx,sk);const r=await rpc('octra_submit',[tx]);const rc=await rec(r.result.tx_hash);console.log('  probe deploy success=',rc&&rc.success,'->',probe);}
  console.log('set_tmpl (store a template to spawn)');
  {N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from:me,to_:probe,amount:'0',nonce:N.v,ou:'1000',timestamp:ts,op_type:'call',encrypted_data:'set_tmpl',message:JSON.stringify([tmplBc])};sign(tx,sk);const r=await rpc('octra_submit',[tx]);console.log('  set_tmpl submit ou_cost=',r.result&&r.result.ou_cost);const rc=await rec(r.result.tx_hash);console.log('  set_tmpl success=',rc&&rc.success,'err=',rc&&rc.error);}
  console.log('do_spawn() ou=1000');
  {N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from:me,to_:probe,amount:'0',nonce:N.v,ou:'1000',timestamp:ts,op_type:'call',encrypted_data:'do_spawn',message:'[]'};sign(tx,sk);const r=await rpc('octra_submit',[tx]);console.log('  submit:',JSON.stringify(r.result||r.error));const rc=await rec(r.result.tx_hash);console.log('  do_spawn receipt:',rc?('success='+rc.success+' err='+rc.error+' effort='+rc.effort):'NONE');}
  const cnt=await rpc('contract_call',[probe,'get_count',[]]);
  console.log('  get_count:',cnt.result&&(cnt.result.result??cnt.result));
  const after=(await rpc('octra_balance',[me])).result;console.log('nonce now',after.nonce);
})().catch(e=>console.error('ERR',e.message));
