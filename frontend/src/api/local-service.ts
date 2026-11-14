import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  getMigrationRun,
  listQuarantine,
  listMigrationRuns,
  migrationStatus,
  resumeMigration,
  reviewEntry,
  reviewModule,
  startMigration,
} from '@/data/repository'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import type {
  EntryReview,
  MigrationResult,
  MigrationRun,
  MigrationStatus,
  ModuleReview,
  QuarantineRecord,
} from '@/data/repository'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    // 空态码：只有筛选/读取真的没有命中时才返回 no_match。
    code: matched.length === 0 ? 'no_match' : 'ok',
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return {
      ok: false,
      code: 'apply_fail',
      message: `${meta.entity}没有登记「${action}」这个动作`,
    }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, code: 'no_match', message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return {
      ok: false,
      code: 'apply_fail',
      message: `${meta.entity}已经是「${target}」，不用重复操作`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, code: 'ok', message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 版本仓 / 迁移入口：页面与诊断脚本共用同一套结果码。
// ---------------------------------------------------------------------------

export function loadMigrationStatus(): MigrationStatus {
  return migrationStatus()
}

/** 开始一次全新迁移；重试不会复用旧 run，总是创建新 run。 */
export function beginMigration(options: { owner?: string } = {}): MigrationResult {
  return startMigration(options)
}

/** 从中断点续装；不传 runId 时取最近一次可续的 run。 */
export function continueMigration(
  runId?: string,
  options: { owner?: string } = {},
): MigrationResult {
  return resumeMigration(runId, options)
}

export function loadMigrationRuns(limit = 10): MigrationRun[] {
  return listMigrationRuns(limit)
}

export function loadMigrationRun(runId: string): MigrationRun | null {
  return getMigrationRun(runId)
}

/** 回看单个条目：核对字段版本，并给出旧格式来源 / 隔离原因。 */
export function reviewEntryTrace(key: string, id: number): EntryReview {
  return reviewEntry(key, id)
}

/** 回看整个模块：核对模块签名与字段版本。 */
export function reviewModuleTrace(key: string): ModuleReview {
  return reviewModule(key)
}

export function loadQuarantine(key?: string): QuarantineRecord[] {
  return listQuarantine(key)
}
