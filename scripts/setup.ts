import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
if (!existsSync('.env')) {
  const python = existsSync('../.venv/bin/python') ? new URL('../../.venv/bin/python', import.meta.url).pathname : 'python3'
  writeFileSync('.env', `ADMIN_KEY=sk-admin-${randomBytes(24).toString('base64url')}\nMASTER_KEY=${randomBytes(32).toString('hex')}\nHOST=127.0.0.1\nPORT=3080\nBASE_URL=http://127.0.0.1:3080\nDATA_DIR=./data\nPYTHON_BIN=${python}\n`, { mode: 0o600 })
  console.log('已生成 .env，管理员登录密钥为其中的 ADMIN_KEY。请保留 MASTER_KEY 以解密账号凭证。')
} else console.log('.env 已存在，保留当前配置。')
mkdirSync('data', { recursive: true, mode: 0o700 })
