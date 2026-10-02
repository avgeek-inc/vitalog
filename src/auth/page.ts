import { createHash } from "node:crypto";

const styles = String.raw`
:root{color-scheme:light dark;--canvas:#f6f5f1;--surface:#fff;--text:#202820;--muted:#5b665b;--border:rgba(32,40,32,.15);--accent:#28563f;--error:#a52d29;--focus:#38724f;--input:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(100% - 40px,480px);margin:clamp(32px,9vh,88px) auto;padding-bottom:max(32px,env(safe-area-inset-bottom))}.brand{font-weight:650;letter-spacing:-.025em;margin:0 0 32px}.panel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.025)}h1,h2{font-size:28px;line-height:1.2;letter-spacing:-.035em;margin:0 0 12px;font-weight:650}p{margin:0 0 24px;color:var(--muted)}form{display:grid;gap:20px}.field{display:grid;gap:8px}label{font-weight:550;font-size:14px}.optional{color:var(--muted);font-weight:400}input,textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--input);color:var(--text);font:inherit;font-size:16px;min-height:48px}input[aria-invalid="true"]{border-color:var(--error)}input:hover,textarea:hover{border-color:var(--muted)}input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button{min-height:48px;padding:12px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;transition:background-color 150ms,transform 150ms}button:active:not(:disabled){transform:scale(.98)}button:disabled{cursor:wait;background:var(--muted)}.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}.actions{display:grid;gap:12px;margin-top:16px}.error{color:var(--error);font-size:14px;margin:0}.hint{font-size:13px;margin:20px 0 0}.key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;resize:none;overflow-wrap:anywhere;min-height:104px}.expiry{font-size:14px;margin:12px 0 20px}#copy-status{font-size:14px;min-height:21px;margin:12px 0 0}footer{font-size:13px;color:var(--muted);margin-top:20px}footer p{margin:0}#result:focus{outline:none}[hidden]{display:none!important}
@media(hover:hover)and(pointer:fine){button:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 85%,black)}button.secondary:hover{background:var(--canvas)}}
@media(prefers-color-scheme:dark){:root{--canvas:#141b16;--surface:#1b241e;--text:#e9eee9;--muted:#aab7ac;--border:#3b493e;--accent:#316849;--error:#ffaca4;--focus:#89bc99;--input:#172019}}
@media(max-width:400px){.panel{padding:22px}h1,h2{font-size:26px}}
@media(prefers-reduced-motion:reduce){button{transition:none}button:active:not(:disabled){transform:none}}
`;

const script = String.raw`
const form=document.getElementById('key-form');
const button=document.getElementById('generate');
const email=document.getElementById('email');
const password=document.getElementById('password');
const name=document.getElementById('name');
const error=document.getElementById('form-error');
const result=document.getElementById('result');
const token=document.getElementById('api-key');
const status=document.getElementById('copy-status');
for(const input of [email,password,name])input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');error.hidden=true;});
form.addEventListener('submit',async(event)=>{
  event.preventDefault();if(button.disabled)return;
  button.disabled=true;button.textContent='Generating key…';error.hidden=true;
  email.removeAttribute('aria-invalid');password.removeAttribute('aria-invalid');
  try{
    const body={email:email.value,password:password.value};
    if(name.value.trim())body.name=name.value.trim();
    const response=await fetch('/auth/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error'});
    const data=await response.json();
    if(!response.ok){
      if(response.status===401){email.setAttribute('aria-invalid','true');password.setAttribute('aria-invalid','true');}
      throw new Error(response.status===401?'Check your email and password and try again.':response.status===429?'Too many attempts. Wait a minute and try again.':response.status===503?'Key generation is unavailable. Check the root configuration.':'The key could not be generated. Try again.');
    }
    token.value=data.api_key;
    const expiry=document.getElementById('expires-at');expiry.dateTime=data.expires_at;
    expiry.textContent=new Date(data.expires_at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
    form.hidden=true;document.getElementById('intro').hidden=true;result.hidden=false;result.focus();
  }catch(failure){error.textContent='Error: '+(failure instanceof TypeError?'Unable to connect. Check your connection and try again.':failure.message);error.hidden=false;}
  finally{password.value='';button.disabled=false;button.textContent='Generate API key';}
});
document.getElementById('copy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(token.value);status.textContent='API key copied.';}
  catch{token.focus();token.select();status.textContent='Select and copy the API key above.';}
});
document.getElementById('another').addEventListener('click',()=>{
  token.value='';status.textContent='';result.hidden=true;form.hidden=false;document.getElementById('intro').hidden=false;password.focus();
});
window.addEventListener('pagehide',()=>{token.value='';password.value='';});
`;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64");
export const keyPageCsp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(styles)}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
export const keyPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Generate an API key · Vitalog</title><style>${styles}</style></head>
<body><main><div class="brand">Vitalog</div><section class="panel" aria-label="API key generation">
<div id="intro"><h1>Generate an API key</h1><p>Sign in with your root credentials to create a key valid for 30 days.</p></div>
<form id="key-form" action="/auth/api-keys" method="post">
<div class="field"><label for="email">Root email</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" required aria-describedby="form-error"></div>
<div class="field"><label for="password">Root password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required aria-describedby="form-error"></div>
<div class="field"><label for="name">Key name <span class="optional">(optional)</span></label><input id="name" name="name" autocomplete="off" maxlength="80" placeholder="For example, personal automation"></div>
<p class="error" id="form-error" role="alert" hidden></p><button id="generate" type="submit">Generate API key</button>
</form>
<section id="result" tabindex="-1" hidden aria-label="Your new API key"><h2>Your API key is ready</h2><p>Copy this key now. It will only be shown once.</p><label for="api-key">API key</label><textarea class="key" id="api-key" readonly spellcheck="false" autocomplete="off" rows="3"></textarea><p class="expiry">Expires <time id="expires-at"></time></p><div class="actions"><button id="copy" type="button">Copy API key</button><button id="another" type="button" class="secondary">Generate another key</button></div><p id="copy-status" role="status" aria-live="polite"></p></section>
<noscript><p class="error">Enable JavaScript to generate an API key.</p></noscript>
</section><footer><p>Generated keys can access your health ledger through REST and MCP. Key management requires the primary auth key.</p></footer></main><script>${script}</script></body></html>`;
