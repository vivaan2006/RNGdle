import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

test('production disables test rooms and commands while keeping normal Mafia hosting', {timeout:15000}, async t => {
  const probe=createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const server=spawn(process.execPath,['server.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,PORT:String(port),NODE_ENV:'production'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>server.kill());
  await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(String(d).includes('server running'))resolve();});server.once('error',reject);server.once('exit',code=>reject(Error(`Exited ${code}`)));});
  const origin=`http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(origin+'/api/mafia-config')).json(),{localTesting:false});
  const html=await (await fetch(origin+'/mafia.html')).text();
  assert.match(html,/<section class="panel test-entry hidden" id="testEntry">/);
  assert.match(html,/<script src="\/qr.js"><\/script>/);
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(()=>ws.close());
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  async function request(message,type) {
    const reply=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.removeEventListener('message',receive);reject(Error('Response timed out'));},3000);
      function receive(event){const data=JSON.parse(event.data);if(data.type===type){clearTimeout(timer);ws.removeEventListener('message',receive);resolve(data);}}
      ws.addEventListener('message',receive);
    });
    ws.send(JSON.stringify(message));return reply;
  }
  assert.match((await request({type:'host',game:'mafia',testMode:true},'error')).msg,/unavailable/);
  const hosted=await request({type:'host',game:'mafia'},'hosted');
  assert.equal(hosted.game,'mafia');assert.match(hosted.code,/^[A-Z0-9]{4}$/);
  assert.match((await request({type:'mafiaTestPlayers',count:5,phase:'lobby'},'error')).msg,/unavailable/);
});
