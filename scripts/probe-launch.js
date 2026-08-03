// Minimal launch probe: submit ONE launch and print the raw octra_submit
// response + poll the receipt. Diagnoses why launch never lands.
const crypto = require('crypto'); const nacl = require('tweetnacl'); const bs58 = require('bs58');
const fs = require('fs'); const path = require('path');
const RPC = process.env.RPC_URL || 'https://devnet.octrascan.io/rpc';
const D = JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
const F = D.SwapFactory, WOCT = D.WOCT;
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return r.json();}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}
(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC); const sk=kp.secretKey;
  const bal=(await rpc('octra_balance',[me])).result;
  const epoch=(await rpc('epoch_current',[])).result.epoch_id;
  const nonce=bal.nonce+1;
  const sym='PRB'+String(Date.now()).slice(-4);
  const params=['Probe '+sym,sym,sym+'Token','1000000000','6',me,F,'0','0','0','0',me,'0',false,false,false,false,false,false,false,false,false,'','','','','',3,1000,0,'1000000','100000',1,epoch+100,0];
  let ts=Date.now()/1000; if(ts%1===0)ts+=1e-6;
  const tx={from:me,to_:F,amount:'0',nonce,ou:'3000000',timestamp:ts,op_type:'call',encrypted_data:'launch',message:JSON.stringify(params)};
  sign(tx,sk);
  console.log('epoch',epoch,'nonce',nonce,'msg.len',tx.message.length);
  const res=await rpc('octra_submit',[tx]);
  console.log('SUBMIT RESPONSE:',JSON.stringify(res));
  if(res.result&&res.result.tx_hash){
    const h=res.result.tx_hash;
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const rc=await rpc('contract_receipt',[h]);if(rc.result&&rc.result.success!==undefined){console.log('RECEIPT:',JSON.stringify(rc.result).slice(0,400));return;}}
    console.log('no receipt after 120s for',h);
    const b2=(await rpc('octra_balance',[me])).result; console.log('nonce now',b2.nonce);
  }
})().catch(e=>console.error('ERR',e.message));
