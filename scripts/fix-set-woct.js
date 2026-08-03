const crypto=require('crypto'),nacl=require('tweetnacl'),bs58=require('bs58'),fs=require('fs'),path=require('path');
const RPC=process.env.RPC_URL||'https://devnet.octrascan.io/rpc';
const D=JSON.parse(fs.readFileSync(path.join(__dirname,'..','deployments.json'),'utf-8'));
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const d=await r.json();if(d.error)throw new Error(d.error.message);return d.result;}
function esc(s){return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');}
function canon(t){let s=`{"from":"${esc(t.from)}","to_":"${esc(t.to_)}","amount":"${esc(t.amount)}","nonce":${t.nonce},"ou":"${esc(t.ou)}","timestamp":${t.timestamp},"op_type":"${esc(t.op_type)}"`;if(t.encrypted_data)s+=`,"encrypted_data":"${esc(t.encrypted_data)}"`;if(t.message)s+=`,"message":"${esc(t.message)}"`;return s+'}';}
function sign(t,sk){t.signature=Buffer.from(nacl.sign.detached(Buffer.from(canon(t),'utf-8'),sk)).toString('base64');t.public_key=Buffer.from(sk.slice(32,64)).toString('base64');}
function A(mn){const s=crypto.pbkdf2Sync(mn,'mnemonic',2048,64,'sha512');const h=crypto.createHmac('sha512','Octra seed');h.update(Buffer.from(s));const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(h.digest().slice(0,32)));const sha=crypto.createHash('sha256').update(Buffer.from(kp.publicKey)).digest();let b=bs58.default.encode(sha);while(b.length<44)b='1'+b;return{kp,address:'oct'+b};}
async function rec(h,max=50){for(let i=0;i<max;i++){await new Promise(x=>setTimeout(x,3000));try{const rc=await rpc('contract_receipt',[h]);if(rc&&rc.success!==undefined)return rc;}catch{}}return null;}
(async()=>{
  const {kp,address:me}=A(process.env.MNEMONIC);const sk=kp.secretKey;
  const F=D.SwapFactory,W=D.WOCT;
  const n=(await rpc('octra_balance',[me])).nonce+1;
  let ts=Date.now()/1000;if(ts%1===0)ts+=1e-6;
  const tx={from:me,to_:F,amount:'0',nonce:n,ou:'1000',timestamp:ts,op_type:'call',encrypted_data:'set_woct_token',message:JSON.stringify([W])};
  sign(tx,sk);const r=await rpc('octra_submit',[tx]);console.log('submit',r.tx_hash,'nonce',n);
  const rc=await rec(r.tx_hash);console.log('receipt success=',rc&&rc.success,'err=',rc&&rc.error);
  const v=await rpc('contract_call',[F,'get_woct_token',[]]);console.log('woct_token now:',v.result??v);
})().catch(e=>console.error('ERR',e.message));
