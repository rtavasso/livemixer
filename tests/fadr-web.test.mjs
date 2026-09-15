import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPlaylist } from '../scripts/fadr-web.mjs';

for (const uploadError of ['timeout of 20000ms exceeded', 'Network Error']) test(`Pro UI recovers from ${uploadError}, downloads all stems, and resumes`, { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fadr-test-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(3000);
    const roles = ['Bass', 'Drums', 'Vocals', 'Guitar', 'Piano', 'Pro-other', 'Kick', 'Snare', 'Vocals-lead', 'Vocals-background', 'Drums-other'];
    const labels = roles.map(role => ({ 'Pro-other': 'Melodies', 'Vocals-lead': 'Lead Vocals', 'Vocals-background': 'Background Vocals', 'Drums-other': 'Other Drums' })[role] ?? role);
    const archive = Buffer.from(zipSync(Object.fromEntries(roles.map(role => [`Nested/${role} - Test.mp3`, strToU8('test stem')]))));
    const mp3 = Buffer.from('test input');
    await writeFile(join(root, 'Test [test].mp3'), mp3);
    const manifest = join(root, 'playlist.local.json');
    await writeFile(manifest, JSON.stringify({ stems: 'pro', tracks: [{ id: 'test', artist: 'Artist', title: 'Test' }] }));
    await writeFile(join(root, 'audio.local.json'), JSON.stringify({ test: {
      mp3: 'Test [test].mp3', sha256: createHash('sha256').update(mp3).digest('hex'),
    } }));
    const html = `<style>.mask{position:fixed;inset:0;z-index:20}.context-menu{position:fixed;top:80px;left:30px;z-index:21;background:white}.download-stems-bank label{display:block}</style><div class="page _stems"><header><button class="switch">Pro<div class="switch-slider on"></div></button></header>
      <div class="upload"><input type="file"></div><div id="cards"></div></div>
      <script>
      window.uploads=0;
      window.retries=0;
      window.subdivisions=0;
      const roles=${JSON.stringify(labels)};
      const zipBytes=${JSON.stringify([...archive])};
      document.querySelector('input[type=file]').onchange = event => {
        window.uploads++;
        const card=document.createElement('div'); card.className='stems song';
        card.innerHTML='<div class="song-header"><div class="song-title"><h3></h3></div><button title="Close stems">X</button></div><div class="actions"><div id="more"><button id="moreButton">More Stems</button></div><div class="context-menu-container" id="downloads"><button class="download-remix-button">Download Stems</button></div></div>';
        card.querySelector('h3').textContent=event.target.files[0].name;
        card.querySelector('[title="Close stems"]').onclick=()=>card.remove();
        const remaining=['Separate Vocals','Separate Drums'];
        card.querySelector('#moreButton').onclick=()=>{
          const theme=document.createElement('div'); theme.className='theme';
          const mask=document.createElement('div'); mask.className='mask'; mask.onclick=()=>theme.remove();
          const menu=document.createElement('div'); menu.className='context-menu more-stems';
          remaining.forEach(label=>{
            const button=document.createElement('button'); button.className='context-menu-option'; button.innerHTML='<span>'+label+'</span>';
            button.onclick=()=>setTimeout(()=>{window.subdivisions++;remaining.splice(remaining.indexOf(label),1);button.remove();if(!remaining.length)card.querySelector('#more').remove();},50);
            menu.append(button);
          });
          theme.append(mask,menu); card.querySelector('#more').append(theme);
        };
        card.querySelector('.download-remix-button').onclick=()=>{
          const container=card.querySelector('#downloads');
          if(container.querySelector('.theme')) { container.querySelector('.theme').remove(); return; }
          const theme=document.createElement('div'); theme.className='theme';
          const mask=document.createElement('div'); mask.className='mask'; mask.onclick=()=>theme.remove();
          const menu=document.createElement('div'); menu.className='context-menu';
          menu.innerHTML='<button class="toggle"><div class="toggle-option _active">Download</div><div class="toggle-option">Combine</div></button><div class="download-stems-bank"></div><button id="quality">mp3<div class="switch-slider on"></div>wav</button><button class="context-menu-option" id="start"><div class="icon download"></div>Download Stems</button>';
          const bank=available=>{
            menu.querySelector('.download-stems-bank').innerHTML='<label title="Toggle all" for="all"><input type="checkbox" id="all">All</label>'+available.map(role=>'<label title="Toggle '+role+'"><input type="checkbox">'+role+'</label>').join('');
            menu.querySelector('#all').onclick=event=>menu.querySelectorAll('input').forEach(input=>input.checked=event.target.checked);
          };
          bank(roles.slice(0,6));
          menu.querySelector('.toggle').onclick=()=>{
            menu.querySelectorAll('.toggle-option').forEach(option=>option.classList.toggle('_active'));
            bank(window.subdivisions===2?roles:roles.slice(0,6));
          };
          menu.querySelector('#quality').onclick=()=>menu.querySelector('.switch-slider').classList.toggle('on');
          menu.querySelector('#start').onclick=()=>{
            if(![...menu.querySelectorAll('input')].every(input=>input.checked)) throw Error('Not all stems selected');
            if(menu.querySelector('.switch-slider.on')) throw Error('MP3 format not selected');
            const link=document.createElement('a'); link.href=URL.createObjectURL(new Blob([new Uint8Array(zipBytes)],{type:'application/zip'})); link.download='Test.zip'; document.body.append(link); link.click(); link.remove();
          };
          theme.append(mask,menu); container.append(theme);
        };
        const actions=card.querySelector('.actions'), pending=document.createDocumentFragment();
        [...actions.children].forEach(child=>pending.append(child));
        const retry=document.createElement('button'); retry.textContent=${JSON.stringify(uploadError)};
        retry.onclick=()=>{ window.retries++; actions.replaceChildren(pending); };
        actions.append(retry);
        document.querySelector('#cards').append(card);
      };
      </script>`;
    await page.route('**/*', route => route.fulfill(route.request().url().endsWith('/test.zip')
      ? { status: 200, contentType: 'application/zip', headers: { 'content-disposition': 'attachment; filename="Test.zip"' }, body: archive }
      : { status: 200, contentType: 'text/html', body: html }));
    assert.equal(await splitPlaylist(page, manifest, { timeout: 10_000 }), true);
    assert.equal(await page.evaluate(() => window.uploads), 1);
    assert.equal(await page.evaluate(() => window.retries), 1);
    assert.equal(await page.evaluate(() => window.subdivisions), 2);
    const state = JSON.parse(await readFile(join(root, 'stems.local.json'), 'utf8'));
    assert.deepEqual(state.test.roles, labels);
    const inventory = JSON.parse(await readFile(join(root, 'stems/test/_stems.local.json'), 'utf8'));
    assert.equal(inventory.files.length, roles.length);
    await page.close();
    // A completed ZIP must be reusable even with no browser/session available.
    assert.equal(await splitPlaylist(null, manifest), true);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
