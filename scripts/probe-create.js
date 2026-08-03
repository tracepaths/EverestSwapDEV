// Diagnostic: does this devnet node honor `ou` for a call that SPAWNs a pool?
// Deploys a token, grants, then submits create() with ou=400000 and prints the
// raw submit response (ou_cost) + polls the receipt.
const crypto=require('crypto'),nacl=require('tweetnacl'),bs58=require('bs58'),fs=require('fs'),path=require('path');
const RPC=process.env.RPC_URL||'https://devnet.octrascan.io/rpc';
const D=JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
const F=D.SwapFactory,WOCT=D.WOCT,ROUTER=D.Router;
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return r.json();}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}
async function rec(h){for(let i=0;i<40;i++){await new Promise(x=>setTimeout(x,3000));const rc=await rpc('contract_receipt',[h]);if(rc.result&&rc.result.success!==undefined)return rc.result;}return null;}
const N={v:0};
async function call(from,to,m,params,sk,ou){N.v+=1;let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from,to_:to,amount:'0',nonce:N.v,ou:ou||'1000',timestamp:ts,op_type:'call',encrypted_data:m,message:JSON.stringify(params)};sign(tx,sk);const r=await rpc('octra_submit',[tx]);console.log(`  ${m} submit:`,JSON.stringify(r.result||r.error));if(!r.result)return null;const rc=await rec(r.result.tx_hash);console.log('    receipt:',rc?('success='+rc.success+' err='+rc.error+' effort='+rc.effort):'NONE ('+r.result.tx_hash+')');return {sub:r.result,rc};}
(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC);const sk=kp.secretKey;
  N.v=(await rpc('octra_balance',[me])).result.nonce;
  console.log('deploy token');
  const tokenBc=(await rpc('octra_compileAml',[fs.readFileSync(path.join(__dirname,'..','contracts','Token.aml'),'utf-8')])).result.bytecode;
  N.v+=1; const addr=(await rpc('octra_computeContractAddress',[tokenBc,me,N.v])).result.address;
  const args=JSON.stringify(['PC','PC','PC','1000000000','6',me,me,'0','0','0','0',me,'0',true,true,true,true,false,false,false,false,false,ROUTER,'','','','']);
  {let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;const tx={from:me,to_:addr,amount:'0',nonce:N.v,ou:'200000',timestamp:ts,op_type:'deploy',encrypted_data:tokenBc,message:args};sign(tx,sk);const r=await rpc('octra_submit',[tx]);console.log('  token submit:',JSON.stringify(r.result||r.error));const rc=await rec(r.result.tx_hash);console.log('  token receipt success=',rc&&rc.success,'->',addr);}
  console.log('grants');
  await call(me,WOCT,'grant',[F,'200000'],sk);
  await call(me,addr,'grant',[F,'2000000'],sk);
  const ep=(await rpc('epoch_current',[])).result.epoch_id;
  console.log('create() with ou=400000 (deploy-sized):');
  await call(me,F,'create',[addr,WOCT,3,1000,0,'2000000','200000',1,ep+200,0],sk,'400000');
})().catch(e=>console.error('ERR',e.message));
