/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

/** 列表空态码：筛选/读取没有命中时返回 no_match，页面据此渲染空态。 */
export type EmptyStateCode = 'ok' | 'no_match'

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  code: EmptyStateCode
}

/** 动作结果码：找不到记录用 no_match，写入/状态机拒绝用 apply_fail。 */
export type ActionResultCode = 'ok' | 'no_match' | 'apply_fail'

export type ActionResult = {
  ok: boolean
  code: ActionResultCode
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
