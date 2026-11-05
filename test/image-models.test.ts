import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      console.log(JSON.stringify({status:response.status}));db.close();
    `)).toEqual({ status: 201 })
    const saved = await run(`
      const config=await (await request('/api/models')).json();
      const catalog=await (await request('/v1/models')).json();
      console.log(JSON.stringify({config,catalog}));db.close();
    `)
    expect(saved.config.models).toHaveLength(6)
    expect(saved.config.responsesModel).toBe('persisted-calling-model')
    expect(saved.config.models.find((model: any) => model.id === 'persisted-image')).toMatchObject({ name: '网页保存的模型', isDefault: true, enabled: true, sizes: ['1536x864'], qualities: ['high', 'max'] })
    expect(saved.config.models.find((model: any) => model.id === 'gpt-image-2.6-flare').enabled).toBe(false)
    expect(saved.catalog.data).toHaveLength(5)
    expect(saved.catalog.data.find((model: any) => model.id === 'persisted-image').isDefault).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
