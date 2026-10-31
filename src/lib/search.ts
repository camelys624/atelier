export type TaskSearch = { task?: string }
export const validateTaskSearch = (search: Record<string, unknown>): TaskSearch => search.task == null || search.task === '' ? {} : { task: String(search.task) }
