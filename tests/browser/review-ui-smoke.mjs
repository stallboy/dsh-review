import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const browser = process.env.DSH_REVIEW_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await access(browser).catch(() => { throw new Error('请通过 DSH_REVIEW_BROWSER 指定已安装的 Chromium/Edge 浏览器程序'); });
await mkdir(path.join(root, '.tmp'), { recursive: true });
const profile = await mkdtemp(path.join(root, '.tmp', 'edge-review-'));
const patch = ['a.ts', 'b.ts'].map(name => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`).join('');
const bootstrap = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CandidatePage,UserContext} from './apps/web/src/App.tsx';
const h=React.createElement;
const patch=${JSON.stringify(patch)};
const status={controlToken:'control',configured:false,enabled:false,mode:'local',reviewIdentity:'',centerUrl:'',centralId:'',nodeId:'',phase:'stopped',nodeOnline:false,generation:1,hasCredentials:false,localAvailable:true,candidates:[],projects:[],logs:[]};
window.test={status,writes:0,cleanups:[],errors:[],root:createRoot(document.getElementById('review-mount'))};
window.addEventListener('error',event=>test.errors.push(String(event.error||event.message)));
window.__ModuleLoader__={load({factory}){factory(()=>React).apply({get(){},effect(callback){const clean=callback();if(clean)test.cleanups.push(clean)},locale:{register(){return()=>{}},bind(){return()=> '评审'}},slots:{inject(name,callback){callback()},register(options,component){test.view=component;return()=>{}}}})}};
window.fetch=async(url,init={})=>{
    let value;
    if(String(url).includes('/connection')){
        if(init.method==='POST'){
            test.writes++;
            const body=JSON.parse(init.body||'{}');
            if(String(url).includes('/apply')){
                status.phase='starting';
                await new Promise(resolve=>setTimeout(resolve,120));
                Object.assign(status,{configured:true,enabled:true,phase:'ready',nodeOnline:true,reviewIdentity:body.reviewIdentity,centerUrl:'http://127.0.0.1:40000',centralId:'central',nodeId:'node'});
            }
        }
        value={...status};
    }else if(String(url).includes('/candidate?')){
        value={data:{candidate:{id:'2026-11/demo',meta:{title:'Demo',owner:'张三',status:'pending',currentRevision:2,updatedAt:'2026-11-17T00:00:00Z',humanDecisions:[],comments:[],revisions:[{id:1},{id:2}],gateChecks:[],approval:null},sections:{},humanJudgmentDeclared:true,humanJudgment:[]},patchText:patch,comments:[],validation:[],isBaseBehind:false}};
    }else if(String(url).includes('/diff?')) value={data:{unifiedDiff:patch}};
    else value={project:{projectId:'project-a',name:'Demo',target:'main',vcsType:'git'},writable:true,vcsSnapshot:'v1',freshness:'synced',online:true};
    return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
};
test.mountReview=()=>flushSync(()=>test.root.render(h(test.view,{sessionId:'browser-case'})));
test.hideReview=()=>flushSync(()=>test.root.render(null));
test.mountCandidate=()=>{
    test.queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
    test.candidateRoot=createRoot(document.getElementById('candidate-mount'));
    test.candidateRoot.render(h(QueryClientProvider,{client:test.queryClient},h(UserContext.Provider,{value:{userId:'user-a',username:'local',reviewIdentity:'张三'}},h(MemoryRouter,{initialEntries:['/projects/project-a/candidates/2026-11/demo']},h(Routes,null,h(Route,{path:'/projects/:projectId/candidates/*',element:h(CandidatePage)}))))));
};
`;
const bundled = await build({ stdin: { contents: bootstrap, resolveDir: root, loader: 'tsx' }, bundle: true, write: false,
    outfile: path.join(root, '.tmp/browser.js'), format: 'iife', jsx: 'automatic', plugins: [{ name: 'fixture-exports', setup(builder) {
        builder.onLoad({ filter: /apps[\\/]web[\\/]src[\\/]App\.tsx$/ }, async args => ({ contents: `${await readFile(args.path, 'utf8')}\nexport {CandidatePage,UserContext};`, loader: 'tsx' }));
    } }] });
const js = bundled.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const client = await readFile(path.join(root, 'packages/dsh-plugin/dist/client.js'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div data-conversation-scroll id="review-scroll"><div id="review-mount"></div><div data-composer-seat id="seat" style="height:180px">Agent Loop 输入框和任务列表</div></div>
<div data-conversation-scroll id="other-scroll"><div data-composer-seat id="other-seat" style="height:80px">其他会话输入框</div></div>
<div id="candidate-mount"></div><script src="/bootstrap.js"></script><script src="/client.js"></script><script>test.mountReview()</script></body></html>`;
const server = createServer((req, res) => {
    const route = req.url === '/bootstrap.js' ? [js, 'text/javascript'] : req.url === '/client.js' ? [client, 'text/javascript'] : [html, 'text/html'];
    res.writeHead(200, { 'content-type': route[1] }); res.end(route[0]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(browser, ['--headless=new', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws, nextId = 0;
const pending = new Map(), checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
};
const waitFor = async expression => { for (let turn = 0; turn < 80; turn++) { if (await evaluate(expression)) return; await pause(100); } throw new Error(`等待失败：${expression}`); };
const check = async (name, expression) => { const passed = Boolean(await evaluate(expression)); checks.push({ name, passed }); if (!passed) console.log('FAIL', name); };
const click = label => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)throw Error('缺少按钮');b.click()})()`);
try {
    let port;
    for (let turn = 0; turn < 80; turn++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(100); } }
    if (!port) throw new Error('Edge 未打开测试调试端口');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); const handler = pending.get(message.id); if (handler) { pending.delete(message.id); message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result); } });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await send('Page.bringToFront');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor(`document.querySelector('input[aria-label="审核身份"]')!==null`);
    await check('仅评审会话底部隐藏且零高度', `getComputedStyle(document.getElementById('seat')).display==='none' && document.getElementById('seat').offsetHeight===0 && document.getElementById('other-seat').offsetHeight===80`);
    await evaluate(`(()=>{const input=document.querySelector('input[aria-label="审核身份"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'张三');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='应用并启动'&&!b.disabled)`);
    await click('应用并启动');
    await waitFor(`document.body.textContent.includes('中央已连接')`);
    await check('成功转为摘要且只应用一次', `test.writes===1&&!document.querySelector('input')&&![...document.querySelectorAll('button')].some(b=>b.textContent==='应用并启动')`);
    await click('修改连接');
    await check('未变配置禁止再次应用', `[...document.querySelectorAll('button')].find(b=>b.textContent==='应用更改').disabled`);
    await click('取消修改');
    await evaluate('test.hideReview()');
    await check('切回聊天恢复底部及高度', `getComputedStyle(document.getElementById('seat')).display!=='none'&&document.getElementById('seat').offsetHeight===180`);
    await evaluate('test.mountReview()');
    await waitFor(`document.body.textContent.includes('中央已连接')`);
    await evaluate('test.root.unmount();for(const clean of test.cleanups.reverse())clean();test.mountCandidate()');
    await check('卸载移除样式并恢复底部', `document.getElementById('seat').offsetHeight===180&&!document.querySelector('style[data-dsh-code-review]')`);
    await waitFor(`document.body.textContent.includes('方案与证据')`);
    await click('代码差异');
    await waitFor(`document.querySelectorAll('#candidate-mount details:has(> summary > span)[open]').length===2`);
    await evaluate(`document.querySelector('#candidate-mount details:has(> summary > span) summary').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await pause(200);
    await waitFor(`!document.querySelector('#candidate-mount details:has(> summary > span)').open`);
    await check('键盘独立折叠且第二文件不受影响', `document.querySelectorAll('#candidate-mount details:has(> summary > span)')[1].open`);
    await click('审核意见 · 0'); await click('代码差异');
    await check('切换审核标签保留折叠', `!document.querySelector('#candidate-mount details:has(> summary > span)').open`);
    await evaluate('test.queryClient.invalidateQueries()'); await pause(250);
    await check('同范围刷新保留折叠', `!document.querySelector('#candidate-mount details:has(> summary > span)').open`);
    await evaluate(`(()=>{const select=document.querySelector('#candidate-mount select');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(`document.querySelector('#candidate-mount details:has(> summary > span)')?.open`);
    await evaluate(`(()=>{const select=document.querySelector('#candidate-mount select');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await pause(200);
    await check('范围来回切换重新展开', `document.querySelector('#candidate-mount details:has(> summary > span)').open`);
    await click('全部收起'); await pause(150);
    await check('批量收起全部文件', `[...document.querySelectorAll('#candidate-mount details:has(> summary > span)')].every(file=>!file.open)`);
    await click('全部展开'); await pause(150);
    await check('批量展开全部文件', `[...document.querySelectorAll('#candidate-mount details:has(> summary > span)')].every(file=>file.open)`);
    await check('浏览器无异常', `test.errors.length===0`);
    console.log(JSON.stringify(checks, null, 2));
    await writeFile(path.join(root, '.tmp/review-ui-browser-result.json'), JSON.stringify(checks, null, 2));
    if (checks.some(check => !check.passed)) process.exitCode = 1;
} finally {
    if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
    await pause(1000);
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
