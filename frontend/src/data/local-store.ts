/**
 * 本地持久化门面。
 *
 * 旧结构是 `data-layer-studio:entries` 下的裸对象数组；迁移后读写统一走
 * 版本仓 `data-layer-studio:repository`，旧键只读保留。页面和 local-service
 * 仍按原来的 `EntryRow[]` 语义取数，保证升级前后业务字节不变。
 */
import { SEED_ROWS } from './seed'
import {
  FORMAT_CODE,
  LEGACY_STORAGE_KEY,
  LEGACY_FORMAT_CODE,
  REPOSITORY_STORAGE_KEY,
  currentFieldVersion,
  currentModuleSignature,
  readLegacyRows,
  readRepository,
  writeLegacyRows,
  type EntryValidation,
  type LegacyTrace,
  type RepoEntry,
  type RepositoryState,
} from './repository'
import { MODULE_BY_KEY } from './modules'
import { fingerprintOf, stableIdentity } from './fingerprint'
import type { EntryRow } from './types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 首次打开播种：与旧行为一致，只在旧键为空时写入示例数据。 */
function ensureSeed(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const current = readLegacyRows()
  if (Object.keys(current).length > 0) {
    return
  }
  writeLegacyRows(clone(SEED_ROWS))
}

function repositoryRows(state: RepositoryState): Record<string, EntryRow[]> {
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, moduleState] of Object.entries(state.modules)) {
    // 只有已签收的组才从版本仓读；未签收（迁移中断）仍读旧裸对象，
    // 保证半途中断时页面看到的业务字节不会被“清空”。
    if (moduleState.receipt) {
      rows[key] = moduleState.entries.map((entry) => clone(entry.payload))
    }
  }
  return rows
}

/** 读取全量业务字节；已签收模块读版本仓，其余沿用旧裸对象。 */
export function allRows(): Record<string, EntryRow[]> {
  if (typeof window !== 'undefined' && window.localStorage) {
    const repo = readRepository()
    if (repo) {
      ensureSeed()
      return { ...readLegacyRows(), ...repositoryRows(repo) }
    }
  }
  ensureSeed()
  return readLegacyRows()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 该模块是否已签收到版本仓：决定运行时写入落在仓库还是旧键。 */
function moduleIsSigned(key: string): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }
  return Boolean(readRepository()?.modules?.[key]?.receipt)
}

function freshEntry(moduleKey: string, row: EntryRow, at: string): RepoEntry {
  const meta = MODULE_BY_KEY.get(moduleKey)
  const fieldVersion = meta ? currentFieldVersion(meta) : ''
  const signature = meta ? currentModuleSignature(meta) : ''
  const payload = clone(row)
  return {
    identity: stableIdentity(moduleKey, row.id),
    module: moduleKey,
    id: Number(row.id),
    origin: 'runtime',
    payload,
    fingerprint: fingerprintOf(payload),
    validation: {
      status: 'passed',
      issues: [],
      checkedAt: at,
      fieldVersion,
      moduleSignature: signature,
    },
    legacy: null,
    revision: 1,
  }
}

function writeRepositoryRows(state: RepositoryState, key: string, rows: EntryRow[]): void {
  const meta = MODULE_BY_KEY.get(key)
  const moduleState = state.modules[key]
  if (!meta || !moduleState) {
    throw new Error(`版本仓里没有登记名为 ${key} 的业务模块`)
  }
  const at = new Date().toISOString()
  const previous = new Map(moduleState.entries.map((entry) => [entry.identity, entry]))
  const next: RepoEntry[] = rows.map((row) => {
    const identity = stableIdentity(key, row.id)
    const existing = previous.get(identity)
    if (!existing) {
      return freshEntry(key, row, at)
    }
    return {
      ...existing,
      payload: clone(row),
      revision: existing.revision + 1,
    }
  })
  moduleState.entries = next
  // 模块签名/字段版本保持迁移签收时的快照，运行期动作不改签收语义。
  state.updatedAt = at
  window.localStorage.setItem(REPOSITORY_STORAGE_KEY, JSON.stringify(state))
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    const repo = readRepository()
    if (repo && moduleIsSigned(key)) {
      writeRepositoryRows(repo, key, rows)
      return
    }
  }
  ensureSeed()
  const next = { ...readLegacyRows(), [key]: rows }
  writeLegacyRows(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return LEGACY_STORAGE_KEY
}

export function activeStorageKey(): string {
  return typeof window !== 'undefined' && window.localStorage && readRepository()
    ? REPOSITORY_STORAGE_KEY
    : LEGACY_STORAGE_KEY
}

export function activeFormat(): typeof FORMAT_CODE | typeof LEGACY_FORMAT_CODE {
  return activeStorageKey() === REPOSITORY_STORAGE_KEY ? FORMAT_CODE : LEGACY_FORMAT_CODE
}

/** 诊断用：当前模块的旧对象来源追踪。 */
export function legacyTraceOf(key: string, id: number): LegacyTrace | null {
  const repo = readRepository()
  const entry = repo?.modules?.[key]?.entries.find(
    (item) => item.identity === stableIdentity(key, id),
  )
  return entry?.legacy ?? null
}

/** 诊断用：当前模块的逐条校验结果。 */
export function validationOf(key: string, id: number): EntryValidation | null {
  const repo = readRepository()
  const entry = repo?.modules?.[key]?.entries.find(
    (item) => item.identity === stableIdentity(key, id),
  )
  return entry?.validation ?? null
}
