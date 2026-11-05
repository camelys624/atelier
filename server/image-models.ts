import { db } from './store'
import { HttpError } from './http'

export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Quality = typeof IMAGE_QUALITIES[number]
export type ImageModel = { id: string; name: string; source: 'web' | 'codex' | 'openai'; upstreamModel?: string; description: string; sizes: readonly string[]; qualities: readonly Quality[]; enabled: boolean }

const standardSizes = ['1024x1024', '1536x1024', '1024x1536', 'auto']
const standardQualities: Quality[] = ['auto', 'low', 'medium', 'high']
const defaults: ImageModel[] = ([
  { id: 'gpt-image-2', name: 'GPT Image 2', source: 'web', description: '使用 ChatGPT 网页账号生成', sizes: standardSizes, qualities: standardQualities },
  { id: 'codex-gpt-image-2', name: 'GPT Image 2', source: 'codex', description: '使用 Codex 账号生成', sizes: standardSizes, qualities: standardQualities },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', source: 'codex', description: '使用 Codex 账号生成，quality 额外支持 xhigh、max', sizes: standardSizes, qualities: IMAGE_QUALITIES },
  { id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', source: 'codex', description: '使用 Codex 账号生成，适合精细构图和图片编辑', sizes: standardSizes, qualities: IMAGE_QUALITIES },
  { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', source: 'codex', description: '使用 Codex 账号生成，适合快速生成和迭代', sizes: standardSizes, qualities: IMAGE_QUALITIES },
] satisfies Omit<ImageModel, 'enabled'>[]).map(model => ({ ...model, enabled: true }))
const invalid = (message: string): never => { throw new HttpError(400, message) }

function openAIPixelSize(value: string) {
  const match = value.match(/^(\d+)\s*[x×*]\s*(\d+)$/)
  if (!match) return invalid('OpenAI API 的 size 请使用 auto 或像素尺寸，例如 3840x2160；4K 竖图可使用 2160x3840')
  const width = Number(match[1]), height = Number(match[2]), pixels = width * height
  if (width <= 0 || height <= 0 || width % 16 || height % 16 || width > 3840 || height > 3840 || width / height < 1 / 3 || width / height > 3 || pixels < 655_360 || pixels > 8_294_400) return invalid('OpenAI API 尺寸要求：宽高为 16 的倍数，每边不超过 3840，比例介于 1:3～3:1，总像素为 655360～8294400；4K 请使用 3840x2160 或 2160x3840，不支持 4096x4096')
  return `${width}x${height}`
}

/** Validate once before committing an administrator's changes. */
function parseModel(input: unknown): ImageModel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('模型配置需要是对象')
  const row = input as Record<string, unknown>
  for (const key of Object.keys(row)) if (!['id', 'name', 'source', 'upstreamModel', 'description', 'sizes', 'qualities', 'enabled'].includes(key)) return invalid(`模型配置有未知字段 ${key}`)
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.id)) return invalid('模型 ID 需要 1～128 个字母、数字、点、下划线或连字符，并以字母或数字开头')
  const id = row.id
  const known = defaults.find(model => model.id === id)
  const source = row.source === undefined ? known?.source : row.source
  if (source !== 'web' && source !== 'codex' && source !== 'openai') return invalid(`${id} 的 source 必须为 web、codex 或 openai`)
  // The retained web protocol only recognizes this ID. Keep historical tasks on their original source.
  if ((source === 'web') !== (id === 'gpt-image-2')) return invalid('网页来源仅支持 gpt-image-2；其他模型请使用 codex 或 openai 来源')
  if (source === 'openai' && (typeof row.upstreamModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.upstreamModel))) return invalid('请填写有效的 OpenAI 上游模型 ID，最多 128 个字符')
  if (source !== 'openai' && row.upstreamModel !== undefined) return invalid('上游模型映射仅适用于 OpenAI API 来源')
  const name = row.name === undefined ? known?.name ?? id : row.name
  const description = row.description === undefined ? known?.description ?? (source === 'openai' ? '使用 OpenAI API 生成' : `使用 ${source === 'codex' ? 'Codex' : 'ChatGPT 网页'}账号生成`) : row.description
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof description !== 'string' || description.length > 500) return invalid('模型名称不能为空且最多 100 字，说明最多 500 字')
  const sizes = row.sizes === undefined ? known?.sizes ?? standardSizes : row.sizes
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 32 || sizes.some(size => {
    if (size === 'auto') return false
    if (typeof size !== 'string' || !/^\d{2,4}x\d{2,4}$/.test(size)) return true
    const [width, height] = size.split('x').map(Number)
    return !width || !height || width % 16 !== 0 || height % 16 !== 0 || width / height < 1 / 3 || width / height > 3
  }) || !sizes.some(size => size !== 'auto') || new Set(sizes).size !== sizes.length) return invalid(`${id} 的 sizes 需要不重复的尺寸数组，至少一个明确尺寸，宽高为 16 的倍数且比例介于 1:3～3:1；可包含 auto`)
  if (source === 'openai') for (const size of sizes) if (size !== 'auto') openAIPixelSize(size)
  const qualities = row.qualities === undefined ? known?.qualities ?? standardQualities : row.qualities
  if (!Array.isArray(qualities) || !qualities.length || qualities.some(quality => !IMAGE_QUALITIES.includes(quality)) || new Set(qualities).size !== qualities.length) return invalid(`${id} 的 qualities 需要不重复的质量档位数组：${IMAGE_QUALITIES.join('、')}`)
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') return invalid('启用状态必须是布尔值')
  return { id, name: name.trim(), source, ...(source === 'openai' ? { upstreamModel: row.upstreamModel as string } : {}), description: description.trim(), sizes, qualities, enabled: row.enabled ?? true }
}

export function modelConfiguration(): { models: ImageModel[]; defaultModel: string; responsesModel: string } {
  const query = db.query<{ models: string; default_model: string; responses_model: string }, []>('SELECT models,default_model,responses_model FROM image_model_config WHERE id=1')
  let row = query.get()
  if (!row) {
    db.run('INSERT OR IGNORE INTO image_model_config(id,models,default_model) VALUES(1,?,?)', [JSON.stringify(defaults), defaults[0].id])
    row = query.get()!
  }
  return { models: JSON.parse(row.models), defaultModel: row.default_model, responsesModel: row.responses_model }
}
export function saveResponsesModel(input: unknown) {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.trim())) return invalid('请输入有效的 Codex 调用模型 ID，最多 128 个字符')
  modelConfiguration()
  db.run('UPDATE image_model_config SET responses_model=? WHERE id=1', [input.trim()])
}
export const imageModels = () => modelConfiguration().models.filter(model => model.enabled)
export const defaultImageModel = () => modelConfiguration().defaultModel
function persist(models: ImageModel[], defaultModel: string) {
  db.run('UPDATE image_model_config SET models=?,default_model=? WHERE id=1', [JSON.stringify(models), defaultModel])
}
export function saveImageModel(input: unknown, existingId?: string) {
  return db.transaction(() => {
    const config = modelConfiguration()
    const previous = existingId ? config.models.find(model => model.id === existingId) : undefined
    if (existingId && !previous) throw new HttpError(404, '模型不存在')
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('模型配置需要是对象')
    if (existingId && 'id' in input && input.id !== existingId) return invalid('模型 ID 不可修改，请添加新模型')
    const value = parseModel({ ...previous, ...input })
    if (previous && previous.source !== value.source) return invalid('模型来源不可修改，请添加新模型')
    if (!previous && config.models.some(model => model.id === value.id)) throw new HttpError(409, '模型 ID 已存在')
    if (!previous && config.models.length >= 100) return invalid('最多可配置 100 个模型')
    if (value.id === config.defaultModel && !value.enabled) throw new HttpError(409, '请先将其他启用的模型设为默认，再停用此模型')
    persist(previous ? config.models.map(model => model.id === existingId ? value : model) : [...config.models, value], config.defaultModel)
    return value
  }).immediate()
}
export function setDefaultImageModel(id: string) {
  db.transaction(() => {
    const config = modelConfiguration(), model = config.models.find(item => item.id === id)
    if (!model) throw new HttpError(404, '模型不存在')
    if (!model.enabled) throw new HttpError(409, '请先启用模型，再设为默认')
    persist(config.models, id)
  }).immediate()
}
export function deleteImageModel(id: string) {
  db.transaction(() => {
    const config = modelConfiguration()
    if (!config.models.some(model => model.id === id)) throw new HttpError(404, '模型不存在')
    if (id === config.defaultModel) throw new HttpError(409, '请先将其他模型设为默认，再删除此模型')
    persist(config.models.filter(model => model.id !== id), config.defaultModel)
  }).immediate()
}

// Removed models can still have queued or retryable tasks. Preserve their original source.
export const accountSource = (model: string) => modelConfiguration().models.find(item => item.id === model)?.source ?? (model === 'gpt-image-2' ? 'web' : 'codex')

const parseRatio = (value: unknown) => {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*[x×*:/]\s*(\d+(?:\.\d+)?)$/i)
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined
}
const parseDimensions = (value: unknown) => {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i)
  if (!match) return undefined
  const width = Number(match[1]), height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined
}
export function normalizeSize(size: unknown, model = defaultImageModel()) {
  const sizes = modelConfiguration().models.find(item => item.id === model)?.sizes ?? standardSizes
  const text = String(size ?? '').trim().toLowerCase()
  if (sizes.includes(text)) return text
  const explicit = sizes.filter(value => value !== 'auto')
  const dimensions = parseDimensions(size)
  if (dimensions) {
    // Match both shape and scale. Comparing ratio alone makes same-ratio 4K
    // requests pick the first (often 1K) preset regardless of their pixel size.
    const distance = (value: string) => {
      const candidate = parseDimensions(value)!
      const width = Math.log(candidate.width / dimensions.width), height = Math.log(candidate.height / dimensions.height)
      const shape = width - height, scale = (width + height) / 2
      return 4 * shape * shape + scale * scale
    }
    return explicit.reduce((best, value) => distance(value) < distance(best) - 1e-12 ? value : best)
  }
  const ratio = parseRatio(size)
  if (ratio === undefined) return explicit[0]
  return explicit.reduce((best, value) => Math.abs(Math.log(parseRatio(value)! / ratio)) < Math.abs(Math.log(parseRatio(best)! / ratio)) ? value : best)
}
const QUALITY_ALIASES: Record<string, string> = { standard: 'medium', normal: 'medium', hd: 'high', ultra: 'xhigh', highest: 'max', best: 'max' }
export function normalizeQuality(quality: unknown, model: string) {
  const qualities = modelConfiguration().models.find(item => item.id === model)?.qualities ?? standardQualities
  const text = String(quality ?? '').trim().toLowerCase()
  const value = (QUALITY_ALIASES[text] ?? text) as Quality
  if (qualities.includes(value)) return value
  const rank = IMAGE_QUALITIES.indexOf(value)
  if (rank > 0) {
    const lower = IMAGE_QUALITIES.slice(1, rank).filter(item => qualities.includes(item))
    if (lower.length) return lower[lower.length - 1]
  }
  return qualities.includes('auto') ? 'auto' : qualities[0]
}
