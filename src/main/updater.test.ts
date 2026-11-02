import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildManifest } from '@cujuju/electron-updates/node';
import { expect, it } from 'vitest';

// Real Electron is needed: Node's fs does not intercept .asar paths.
it.skipIf(process.platform === 'linux')('downloads and stages ASAR bundle bytes in Electron', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spillway-updater-test-'));
  try {
    const source = join(dir, 'Spillway.app');
    const contents = join(source, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources', 'app.asar.unpacked'), { recursive: true });
    await writeFile(join(contents, 'MacOS', 'Spillway'), 'executable');
    await writeFile(join(contents, 'Info.plist'), '<string>1.0.1</string>');
    // Deliberately not an archive: any virtual-ASAR access must fail this test.
    const asar = Buffer.from('raw archive bytes');
    await writeFile(join(contents, 'Resources', 'app.asar'), asar);
    await writeFile(join(contents, 'Resources', 'app.asar.unpacked', 'native.node'), 'native bytes');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyFile = join(dir, 'private.pem');
    const publicKeyFile = join(dir, 'public.pem');
    await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(publicKeyFile, publicPem);
    const manifest = await buildManifest({
      appName: 'Spillway', repo: 'test/spillway', signatureContext: 'test-v1', dist: dir, keyFile, publicKeyFile,
      version: () => '1.0.1', archs: { darwin: ['arm64'] }, updateSource: () => 'Spillway.app',
    }, 'darwin', '1.0.1');
    const listing = manifest.files[0]!;
    const pack = 'update-darwin-arm64.pack';
    const require = createRequire(import.meta.url);
    const moduleUrl = import.meta.resolve('@cujuju/electron-updates');
    const script = join(dir, 'main.cjs');
    await writeFile(script, `
const {app}=require('electron');
const fs=require('original-fs');
app.setPath('userData',${JSON.stringify(join(dir, 'userdata'))});
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{try{
  const {createUpdater}=await import(${JSON.stringify(moduleUrl)});
  const assets=${JSON.stringify(['update-darwin.json', listing.name, pack])}.map(name=>({name,browser_download_url:name}));
  const fetch=async(url,init)=>{
    if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify([{tag_name:'v1.0.1',prerelease:true,assets}]));
    if(url==='update-darwin.json')return new Response(${JSON.stringify(JSON.stringify(manifest))});
    const data=fs.readFileSync(${JSON.stringify(dir)}+'/'+url);
    const range=init?.headers?.Range;
    if(!range)return new Response(data);
    const [start,end]=range.slice(6).split('-').map(Number);
    return new Response(data.subarray(start,end+1),{status:206,headers:{'Content-Range': 'bytes '+start+'-'+end+'/'+data.length}});
  };
  const updater=createUpdater({app:{isPackaged:true,getVersion:()=> '1.0.0',on(){},quit(){throw Error('unexpected install')}},
    appName:'Spillway',repo:'test/spillway',publicKey:${JSON.stringify(publicPem)},signatureContext:'test-v1',channel:()=> 'nightly',
    dir:${JSON.stringify(join(dir, 'updates'))},fetch,platform:'darwin',arch:'arm64',exe:${JSON.stringify(join(source, 'Contents', 'MacOS', 'Spillway').replaceAll('\\', '/'))}});
  await updater.check();await updater.download();
  if(updater.status().state!=='ready')throw Error(JSON.stringify(updater.status()));
  console.log('update ready');app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require('electron') as string, [script], { env, timeout: 20_000 });
    expect(stdout).toContain('update ready');
    const rebuilt = join(dir, 'updates', 'staged', 'Spillway.app', 'Contents', 'Resources');
    expect(await readFile(join(rebuilt, 'app.asar'))).toEqual(asar);
    expect(await readFile(join(rebuilt, 'app.asar.unpacked', 'native.node'), 'utf8')).toBe('native bytes');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
