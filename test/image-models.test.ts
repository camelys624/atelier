import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

test('migrates the old single API Key into the account pool once and preserves an existing key record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-key-pool-upgrade-'))
  const key = 'sk-proj-migrated-fixture-key-0123456789'
  async function run(script: string) {
    const child = Bun.spawn([process.execPath, '--eval', `const {db,seal,unseal}=await import('./server/store.ts');${script};db.close();`], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: directory, ADMIN_KEY: 'sk-migration-test-only-0123456789', MASTER_KEY: '33'.repeat(32) }, stdout: 'pipe', stderr: 'pipe' })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, error }).toEqual({ exit: 0, error: '' })
    return output ? JSON.parse(output) : null
  }
  const inspect = `const row=db.query("SELECT * FROM accounts WHERE source='openai'").get();console.log(JSON.stringify({id:row.id,slots:row.slots,status:row.status,name:row.name,success:row.success,keyPreserved:unseal(row.secret).api_key===${JSON.stringify(key)},count:db.query('SELECT COUNT(*) AS n FROM accounts').get().n,legacy:db.query('SELECT COUNT(*) AS n FROM openai_api_config').get().n}))`
  try {
    await run(`db.run('INSERT INTO openai_api_config(id,secret) VALUES(1,?)',[seal({apiKey:${JSON.stringify(key)},concurrency:3})])`)
    const migrated = await run(inspect)
    expect(migrated).toMatchObject({ slots: 3, status: 'ready', keyPreserved: true, count: 1, legacy: 0 })
    await run(`db.run("UPDATE accounts SET slots=7,name='custom name',status='disabled',success=5 WHERE source='openai'");db.run('INSERT INTO openai_api_config(id,secret) VALUES(1,?)',[seal({apiKey:${JSON.stringify(key)},concurrency:3})])`)
    const deduplicated = await run(inspect)
    expect(deduplicated).toMatchObject({ id: migrated.id, slots: 7, status: 'disabled', name: 'custom name', success: 5, keyPreserved: true, count: 1, legacy: 0 })
    expect(await run(inspect)).toEqual(deduplicated)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('upgrades queued tasks created before provider routing was stored without changing their source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-routing-upgrade-'))
  const legacy = new Database(join(directory, 'atelier.sqlite'), { create: true })
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT, fingerprint TEXT NOT NULL, prompt TEXT NOT NULL,
    model TEXT NOT NULL, n INTEGER NOT NULL, refs TEXT NOT NULL DEFAULT '[]', demo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', created INTEGER NOT NULL, updated INTEGER NOT NULL, error TEXT,
    UNIQUE(owner,client_id)
  );`)
  for (const model of ['gpt-image-2', 'gpt-image-2.6-sunburst']) legacy.run('INSERT INTO tasks(id,owner,fingerprint,prompt,model,n,created,updated) VALUES(?,?,?,?,?,1,1,1)', [model, 'admin', model, 'preserve queued task', model])
  legacy.close()
  try {
    const child = Bun.spawn([process.execPath, '--eval', `const {db}=await import('./server/store.ts');console.log(JSON.stringify(db.query('SELECT model,source,upstream_model,size,quality,status FROM tasks ORDER BY model').all()));db.close();`], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: directory, ADMIN_KEY: 'sk-routing-test-only-0123456789', MASTER_KEY: '22'.repeat(32) }, stdout: 'pipe', stderr: 'pipe' })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, error }).toEqual({ exit: 0, error: '' })
    expect(JSON.parse(output)).toEqual([
      { model: 'gpt-image-2', source: 'web', upstream_model: null, size: '1024x1024', quality: 'auto', status: 'queued' },
      { model: 'gpt-image-2.6-sunburst', source: 'codex', upstream_model: null, size: '1024x1024', quality: 'auto', status: 'queued' },
    ])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('web model configuration persists across fresh server processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-model-persistence-'))
  const prefix = `
    const {handleApi}=await import('./server/api.ts');
    const {db}=await import('./server/store.ts');
    const headers={Authorization:'Bearer '+process.env.ADMIN_KEY,'Content-Type':'application/json'};
    const request=(path,body,method)=>handleApi(new Request('http://localhost'+path,{headers,method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined}));
  `
  async function run(script: string) {
    const child = Bun.spawn([process.execPath, '--eval', prefix + script], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: directory, ADMIN_KEY: 'sk-model-config-test-only-0123456789', MASTER_KEY: '22'.repeat(32) }, stdout: 'pipe', stderr: 'pipe' })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, error }).toEqual({ exit: 0, error: '' })
    return JSON.parse(output)
  }
  try {
    expect(await run(`
      const response=await request('/api/models',{id:'persisted-image',name:'网页保存的模型',source:'codex',sizes:['1536x864'],qualities:['high','max']});
      await request('/api/models/persisted-image/default',{});
      await request('/api/models/gpt-image-2.6-flare',{enabled:false},'PATCH');
      await request('/api/model-settings',{responsesModel:'persisted-calling-model'});
      await request('/api/accounts',{source:'openai',items:{api_key:'sk-proj-persisted-fixture-key-0123456789',slots:4}});
      await request('/api/models',{id:'gpt-imag-2.6-sunburst-api',name:'Sunburst API',source:'openai',upstreamModel:'gpt-image-2.6-sunburst'});
      const {submitTask}=await import('./server/scheduler.ts');
      submitTask({owner:'admin',prompt:'persisted route',model:'gpt-imag-2.6-sunburst-api',n:1,refs:[]});
      console.log(JSON.stringify({status:response.status}));db.close();
    `)).toEqual({ status: 201 })
    const saved = await run(`
      const config=await (await request('/api/models')).json();
      const catalog=await (await request('/v1/models')).json();
      const {unseal}=await import('./server/store.ts');
      const apiAccount=db.query("SELECT secret,slots FROM accounts WHERE source='openai'").get();
      const task=db.query('SELECT source,upstream_model FROM tasks LIMIT 1').get();
      console.log(JSON.stringify({config,catalog,task,keyPreserved:unseal(apiAccount.secret).api_key==='sk-proj-persisted-fixture-key-0123456789',slots:apiAccount.slots}));db.close();
    `)
    expect(saved.config.models).toHaveLength(7)
    expect(saved.config.responsesModel).toBe('persisted-calling-model')
    expect(saved.config.models.find((model: any) => model.id === 'persisted-image')).toMatchObject({ name: '网页保存的模型', isDefault: true, enabled: true, sizes: ['1536x864'], qualities: ['high', 'max'] })
    expect(saved.config.models.find((model: any) => model.id === 'gpt-image-2.6-flare').enabled).toBe(false)
    expect(saved.catalog.data).toHaveLength(6)
    expect(saved.catalog.data.find((model: any) => model.id === 'persisted-image').isDefault).toBe(true)
    expect(saved.config.models.find((model: any) => model.id === 'gpt-imag-2.6-sunburst-api')).toMatchObject({ source: 'openai', upstreamModel: 'gpt-image-2.6-sunburst', accounts: 1 })
    expect(saved.slots).toBe(4)
    expect(saved.keyPreserved).toBe(true)
    expect(saved.task).toEqual({ source: 'openai', upstream_model: 'gpt-image-2.6-sunburst' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
