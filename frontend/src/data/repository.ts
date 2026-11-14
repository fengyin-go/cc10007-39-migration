/**
 * 版本仓（version repository）：把 localStorage 里的裸条目对象升级为带格式代号、
 * 模块签名、逐条校验结果与原对象指纹的仓库结构。
 *
 * 设计要点：
 * - 旧数据键 `data-layer-studio:entries` 迁移后只读保留，绝不覆写；
 * - 迁移按模块签收，签收表写在仓库里，中断后可从最后一个签收点续装；
 * - 迁移锁写在 localStorage，拿到锁的标签页在每次写入前复核锁归属，抢不到的一方
 *   返回 lock_abort，不写仓库；写入失败或锁丢失时整次升级回滚；
 * - 无法识别、类型漂移、身份冲突的旧条目进隔离匣，原对象与原因都保留，绝不静默清除。
 */
import { canonicalJson, fingerprintOf, hashText, stableIdentity } from './fingerprint'
import { MODULES, MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow, ModuleMeta } from './types'

export const FORMAT_CODE = 'verrepo/v1'
export const LEGACY_FORMAT_CODE = 'raw-entries/v1'
export const LEGACY_STORAGE_KEY = 'data-layer-studio:entries'
export const REPOSITORY_STORAGE_KEY = 'data-layer-studio:repository'
export const RUNS_STORAGE_KEY = 'data-layer-studio:migration-runs'
export const LOCK_STORAGE_KEY = 'data-layer-studio:migration-lock'
export const LOCK_TTL_MS = 30_000
const MAX_RUN_HISTORY = 30

export type ValidationStatus = 'passed' | 'passed_with_issues'
export type EntryOrigin = 'legacy' | 'seed' | 'runtime'

export type EntryValidation = {
  status: ValidationStatus
  issues: string[]
  checkedAt: string
  fieldVersion: string
  moduleSignature: string
}

export type LegacyTrace = {
  format: typeof LEGACY_FORMAT_CODE
  module: string
  identity: string
  fingerprint: string
  importedAt: string
  runId: string
}

export type RepoEntry = {
  identity: string
  module: string
  id: number
  origin: EntryOrigin
  /** 业务字节：与迁移前旧对象字段值一致，动作流转只在这里改。 */
  payload: EntryRow
  /** 原对象指纹（迁移那一刻的旧对象），动作流转后仍保留。 */
  fingerprint: string
  validation: EntryValidation
  legacy: LegacyTrace | null
  revision: number
}

export type QuarantineReasonCode =
  | 'unrecognized_module'
  | 'unrecognized_shape'
  | 'identity_missing'
  | 'type_drift'
  | 'unknown_status'
  | 'identity_conflict'
  | 'module_signed'

export type QuarantineRecord = {
  id: string
  module: string
  identity: string | null
  reasonCode: QuarantineReasonCode
  reason: string
  /** 原对象原样保留，不做清洗，避免静默丢失。 */
  raw: unknown
  fingerprint: string
  fieldVersion: string
  runId: string
  at: string
}

export type ModuleReceipt = {
  module: string
  status: 'signed'
  format: typeof FORMAT_CODE
  runId: string
  moduleSignature: string
  fieldVersion: string
  entryCount: number
  quarantinedCount: number
  signedAt: string
}

export type RepoModule = {
  key: string
  name: string
  entity: string
  format: typeof FORMAT_CODE
  moduleSignature: string
  fieldVersion: string
  receipt: ModuleReceipt | null
  entries: RepoEntry[]
}

export type RepositoryState = {
  format: typeof FORMAT_CODE
  createdAt: string
  updatedAt: string
  runId: string | null
  modules: Record<string, RepoModule>
  quarantine: QuarantineRecord[]
}

export type MigrationCode = 'ok' | 'lock_abort' | 'apply_fail' | 'no_match'
export type MigrationRunStatus = 'running' | 'completed' | 'rolled_back' | 'lock_abort'

export type MigrationCounts = {
  imported: number
  skipped: number
  deduped: number
  quarantined: number
}

export type MigrationRecovery = {
  signedModules: string[]
  pendingModules: string[]
}

export type MigrationRun = {
  runId: string
  status: MigrationRunStatus
  code: MigrationCode
  format: typeof FORMAT_CODE
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  receipts: Record<string, ModuleReceipt>
  counts: MigrationCounts
  error: string | null
  recovery: MigrationRecovery
}

export type MigrationResult = {
  ok: boolean
  code: MigrationCode
  message: string
  runId: string
  status: MigrationRunStatus | 'idle'
  recovery: MigrationRecovery
  counts: MigrationCounts
  receipts: Record<string, ModuleReceipt>
}

export type MigrationModuleStatus = {
  key: string
  name: string
  format: typeof FORMAT_CODE
  signed: boolean
  receiptRunId: string | null
  signedAt: string | null
  moduleSignature: string
  storedFieldVersion: string | null
  currentFieldVersion: string
  fieldVersionMatch: boolean
  entries: number
  quarantined: number
}

export type MigrationStatus = {
  code: 'ok' | 'no_match'
  repository: boolean
  format: typeof FORMAT_CODE | typeof LEGACY_FORMAT_CODE
  runId: string | null
  runStatus: MigrationRunStatus | 'idle'
  modules: MigrationModuleStatus[]
  totals: {
    modules: number
    signedModules: number
    entries: number
    quarantined: number
    legacyEntries: number
  }
}

export type FieldVersionCheck = {
  stored: string | null
  current: string
  match: boolean
}

export type EntryReview = {
  code: 'ok' | 'no_match'
  module: string
  identity: string | null
  fieldVersion: FieldVersionCheck
  entry: RepoEntry | null
  quarantine: QuarantineRecord[]
  message: string
}

export type ModuleReview = {
  code: 'ok' | 'no_match'
  module: string
  fieldVersion: FieldVersionCheck
  moduleSignature: string
  currentModuleSignature: string
  signatureMatch: boolean
  entries: RepoEntry[]
  quarantine: QuarantineRecord[]
  message: string
}

// ---------------------------------------------------------------------------
// 基础存储
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readJson<T>(key: string): T | null {
  if (!hasStorage()) {
    return null
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  if (!hasStorage()) {
    return
  }
  window.localStorage.setItem(key, JSON.stringify(value))
}

function removeKey(key: string): void {
  if (hasStorage()) {
    window.localStorage.removeItem(key)
  }
}

const TAB_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function newRunId(now: number): string {
  return `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// 模块签名 / 字段版本
// ---------------------------------------------------------------------------

/** 模块签名：字段、状态、动作、流转目标任一变化都会换签名。 */
export function currentModuleSignature(meta: ModuleMeta): string {
  return hashText(
    canonicalJson({
      fields: meta.fields,
      statuses: meta.statuses,
      actions: meta.actions,
      actionTargets: meta.actionTargets,
    }),
  )
}

/** 字段定义版本：只对字段清单取哈希，回看时用于核对字段定义。 */
export function currentFieldVersion(meta: ModuleMeta): string {
  return hashText(canonicalJson(meta.fields))
}

// ---------------------------------------------------------------------------
// 旧数据读取
// ---------------------------------------------------------------------------

/** 未迁移时仍按原语义读取旧裸对象；首次打开由 local-store 负责播种。 */
export function readLegacyRows(): Record<string, EntryRow[]> {
  return readJson<Record<string, EntryRow[]>>(LEGACY_STORAGE_KEY) ?? {}
}

/**
 * 迁移入口的旧数据视图：旧键缺失时按原始语义用示例数据播种，
 * 保证「迁移前后同一业务字节」在首次打开时也成立。
 */
export function ensureLegacyRows(): Record<string, EntryRow[]> {
  const current = readLegacyRows()
  if (Object.keys(current).length > 0) {
    return current
  }
  const seeded = clone(SEED_ROWS)
  writeLegacyRows(seeded)
  return seeded
}

export function writeLegacyRows(rows: Record<string, EntryRow[]>): void {
  writeJson(LEGACY_STORAGE_KEY, rows)
}

// ---------------------------------------------------------------------------
// 仓库读写
// ---------------------------------------------------------------------------

function emptyModules(): Record<string, RepoModule> {
  const modules: Record<string, RepoModule> = {}
  for (const meta of MODULES) {
    modules[meta.key] = {
      key: meta.key,
      name: meta.name,
      entity: meta.entity,
      format: FORMAT_CODE,
      moduleSignature: currentModuleSignature(meta),
      fieldVersion: currentFieldVersion(meta),
      receipt: null,
      entries: [],
    }
  }
  return modules
}

export function readRepository(): RepositoryState | null {
  const raw = readJson<RepositoryState>(REPOSITORY_STORAGE_KEY)
  if (!raw || raw.format !== FORMAT_CODE || !raw.modules) {
    return null
  }
  for (const meta of MODULES) {
    if (!raw.modules[meta.key]) {
      raw.modules[meta.key] = {
        key: meta.key,
        name: meta.name,
        entity: meta.entity,
        format: FORMAT_CODE,
        moduleSignature: currentModuleSignature(meta),
        fieldVersion: currentFieldVersion(meta),
        receipt: null,
        entries: [],
      }
    }
  }
  if (!Array.isArray(raw.quarantine)) {
    raw.quarantine = []
  }
  return raw
}

function writeRepository(state: RepositoryState): void {
  writeJson(REPOSITORY_STORAGE_KEY, state)
}

export function repositoryExists(): boolean {
  return readRepository() !== null
}

function readModuleReceipt(state: RepositoryState | null, key: string): ModuleReceipt | null {
  return state?.modules?.[key]?.receipt ?? null
}

function recoveryOf(state: RepositoryState | null): MigrationRecovery {
  const signedModules = MODULES.filter((meta) => Boolean(readModuleReceipt(state, meta.key))).map(
    (meta) => meta.key,
  )
  return {
    signedModules,
    pendingModules: MODULES.filter((meta) => !signedModules.includes(meta.key)).map((meta) => meta.key),
  }
}

// ---------------------------------------------------------------------------
// 迁移锁
// ---------------------------------------------------------------------------

type LockRecord = {
  owner: string
  tab: string
  runId: string
  acquiredAt: number
  expiresAt: number
}

/**
 * 抢占迁移锁。localStorage 没有 CAS，摸到锁后立刻复核一次；
 * 两个标签页同时抢时，后写的一方会看到自己的 token，先写的一方在提交前复核失败。
 */
function acquireLock(owner: string, runId: string): boolean {
  if (!hasStorage()) {
    return true
  }
  const now = Date.now()
  const current = readJson<LockRecord>(LOCK_STORAGE_KEY)
  if (current && current.owner !== owner && current.expiresAt > now) {
    return false
  }
  writeJson(LOCK_STORAGE_KEY, {
    owner,
    tab: TAB_ID,
    runId,
    acquiredAt: now,
    expiresAt: now + LOCK_TTL_MS,
  } satisfies LockRecord)
  return ownsLock(owner)
}

function ownsLock(owner: string): boolean {
  if (!hasStorage()) {
    return true
  }
  const current = readJson<LockRecord>(LOCK_STORAGE_KEY)
  return Boolean(current && current.owner === owner && current.expiresAt > Date.now())
}

function refreshLock(owner: string, runId: string): void {
  if (!hasStorage()) {
    return
  }
  const current = readJson<LockRecord>(LOCK_STORAGE_KEY)
  if (current && current.owner === owner) {
    writeJson(LOCK_STORAGE_KEY, {
      ...current,
      runId,
      expiresAt: Date.now() + LOCK_TTL_MS,
    })
  }
}

function releaseLock(owner: string): void {
  if (!hasStorage()) {
    return
  }
  const current = readJson<LockRecord>(LOCK_STORAGE_KEY)
  if (current && current.owner === owner) {
    removeKey(LOCK_STORAGE_KEY)
  }
}

/** 测试/诊断用：查看当前锁归属，不修改任何数据。 */
export function inspectMigrationLock(): { tab: string; runId: string; expiresAt: number } | null {
  const current = readJson<LockRecord>(LOCK_STORAGE_KEY)
  return current ? { tab: current.tab, runId: current.runId, expiresAt: current.expiresAt } : null
}

// ---------------------------------------------------------------------------
// 运行历史
// ---------------------------------------------------------------------------

type RunHistory = { runs: MigrationRun[] }

function readRunHistory(): RunHistory {
  const history = readJson<RunHistory>(RUNS_STORAGE_KEY)
  if (!history || !Array.isArray(history.runs)) {
    return { runs: [] }
  }
  return history
}

function saveRun(run: MigrationRun): void {
  const history = readRunHistory()
  const index = history.runs.findIndex((item) => item.runId === run.runId)
  if (index >= 0) {
    history.runs[index] = clone(run)
  } else {
    history.runs.unshift(clone(run))
  }
  history.runs = history.runs.slice(0, MAX_RUN_HISTORY)
  writeJson(RUNS_STORAGE_KEY, history)
}

export function getMigrationRun(runId: string): MigrationRun | null {
  return readRunHistory().runs.find((item) => item.runId === runId) ?? null
}

export function listMigrationRuns(limit = 10): MigrationRun[] {
  return readRunHistory().runs.slice(0, limit)
}

function latestInterruptedRun(): MigrationRun | null {
  const interrupted = readRunHistory().runs.find(
    (item) => item.status === 'running' || item.status === 'lock_abort' || item.status === 'rolled_back',
  )
  if (interrupted) {
    return interrupted
  }
  // run 记录丢失但仓库里留有未签收组：仍可从签收表续装。
  const repo = readRepository()
  if (!repo) {
    return null
  }
  const recovery = recoveryOf(repo)
  if (recovery.pendingModules.length === 0) {
    return null
  }
  const now = new Date().toISOString()
  return {
    runId: repo.runId ?? newRunId(Date.now()),
    status: 'running',
    code: 'ok',
    format: FORMAT_CODE,
    startedAt: repo.updatedAt ?? now,
    updatedAt: repo.updatedAt ?? now,
    finishedAt: null,
    receipts: {},
    counts: emptyCounts(),
    error: null,
    recovery,
  }
}

// ---------------------------------------------------------------------------
// 逐条校验
// ---------------------------------------------------------------------------

type ValidationOk = {
  ok: true
  id: number
  fingerprint: string
  issues: string[]
  status: ValidationStatus
  payload: EntryRow
}

type ValidationFailed = {
  ok: false
  id: number | null
  reasonCode: QuarantineReasonCode
  reason: string
  fingerprint: string
  payload: unknown
}

type ValidationOutcome = ValidationOk | ValidationFailed

const ID_PATTERN = /^\d+$/

function validateLegacyEntry(moduleKey: string, raw: unknown): ValidationOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      id: null,
      reasonCode: 'unrecognized_shape',
      reason: `「${moduleKey}」下的旧条目不是对象，无法识别`,
      fingerprint: fingerprintOf(raw),
      payload: raw,
    }
  }
  const record = raw as Record<string, unknown>
  const fingerprint = fingerprintOf(record)
  const issues: string[] = []

  const rawId = record.id
  let id: number | null = null
  if (typeof rawId === 'number' && Number.isInteger(rawId) && rawId >= 0) {
    id = rawId
  } else if (typeof rawId === 'string' && ID_PATTERN.test(rawId)) {
    id = Number(rawId)
    issues.push(`id_type_coerced:${JSON.stringify(rawId)}`)
  }
  if (id === null) {
    return {
      ok: false,
      id: null,
      reasonCode: 'identity_missing',
      reason: `旧条目缺少可用的稳定身份 id（实际为 ${rawId === null ? 'null' : typeof rawId}）`,
      fingerprint,
      payload: raw,
    }
  }

  const meta = MODULE_BY_KEY.get(moduleKey)
  if (!meta) {
    return {
      ok: false,
      id,
      reasonCode: 'unrecognized_module',
      reason: `没有登记名为 ${moduleKey} 的模块，无法识别归属`,
      fingerprint,
      payload: raw,
    }
  }

  if (typeof record.status !== 'string') {
    return {
      ok: false,
      id,
      reasonCode: 'type_drift',
      reason: `status 类型漂移：期望 string，实际 ${record.status === null ? 'null' : typeof record.status}`,
      fingerprint,
      payload: raw,
    }
  }
  if (!meta.statuses.includes(record.status)) {
    return {
      ok: false,
      id,
      reasonCode: 'unknown_status',
      reason: `状态「${record.status}」不在模块状态机 ${meta.statuses.join('/')} 内`,
      fingerprint,
      payload: raw,
    }
  }

  for (const flag of ['pending', 'abnormal'] as const) {
    const value = record[flag]
    if (value === undefined) {
      issues.push(`missing_flag:${flag}`)
      continue
    }
    if (typeof value !== 'boolean') {
      return {
        ok: false,
        id,
        reasonCode: 'type_drift',
        reason: `${flag} 类型漂移：期望 boolean，实际 ${value === null ? 'null' : typeof value}`,
        fingerprint,
        payload: raw,
      }
    }
  }

  for (const field of meta.fields) {
    const value = record[field]
    if (value === undefined) {
      issues.push(`missing_field:${field}`)
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return {
        ok: false,
        id,
        reasonCode: 'type_drift',
        reason: `字段「${field}」类型漂移：期望标量，实际 ${
          value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        }`,
        fingerprint,
        payload: raw,
      }
    }
  }

  const known = new Set(['id', 'status', 'pending', 'abnormal', ...meta.fields])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push(`unknown_field:${key}`)
    }
  }

  return {
    ok: true,
    id,
    fingerprint,
    issues,
    status: issues.length ? 'passed_with_issues' : 'passed',
    payload: clone(record) as EntryRow,
  }
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

class MigrationAbort extends Error {
  code: MigrationCode

  constructor(code: MigrationCode, message: string) {
    super(message)
    this.code = code
  }
}

function emptyCounts(): MigrationCounts {
  return { imported: 0, skipped: 0, deduped: 0, quarantined: 0 }
}

function addCounts(target: MigrationCounts, source: MigrationCounts): void {
  target.imported += source.imported
  target.skipped += source.skipped
  target.deduped += source.deduped
  target.quarantined += source.quarantined
}

function makeQuarantine(
  state: RepositoryState,
  runId: string,
  moduleKey: string,
  identity: string | null,
  reasonCode: QuarantineReasonCode,
  reason: string,
  raw: unknown,
  fingerprint: string,
  fieldVersion: string,
  at: string,
): boolean {
  const duplicate = state.quarantine.some(
    (item) =>
      item.fingerprint === fingerprint && item.module === moduleKey && item.reasonCode === reasonCode,
  )
  if (duplicate) {
    return false
  }
  state.quarantine.push({
    id: `q-${runId}-${state.quarantine.length + 1}`,
    module: moduleKey,
    identity,
    reasonCode,
    reason,
    raw: clone(raw),
    fingerprint,
    fieldVersion,
    runId,
    at,
  })
  return true
}

function migrateModule(
  state: RepositoryState,
  meta: ModuleMeta,
  legacyRows: unknown[],
  runId: string,
  at: string,
): { receipt: ModuleReceipt; counts: MigrationCounts } {
  const fieldVersion = currentFieldVersion(meta)
  const signature = currentModuleSignature(meta)
  if (!state.modules[meta.key]) {
    state.modules[meta.key] = {
      key: meta.key,
      name: meta.name,
      entity: meta.entity,
      format: FORMAT_CODE,
      moduleSignature: signature,
      fieldVersion,
      receipt: null,
      entries: [],
    }
  }
  const moduleState = state.modules[meta.key]
  const sealed = Boolean(moduleState.receipt)
  if (sealed) {
    // 已签收的组保留签收时的签名/字段版本快照，便于回看时发现漂移。
    moduleState.moduleSignature = moduleState.receipt!.moduleSignature
    moduleState.fieldVersion = moduleState.receipt!.fieldVersion
  } else {
    moduleState.moduleSignature = signature
    moduleState.fieldVersion = fieldVersion
  }

  const counts = emptyCounts()
  const byIdentity = new Map(moduleState.entries.map((entry) => [entry.identity, entry]))
  const seenInLegacy = new Set<string>()

  for (const raw of legacyRows) {
    const outcome = validateLegacyEntry(meta.key, raw)

    if (sealed && outcome.ok) {
      // 已签收的组不二次接收：同一稳定身份且指纹一致直接跳过，其余只记隔离原因，
      // 绝不把新对象塞进已签收的组。
      const identity = stableIdentity(meta.key, outcome.id)
      if (byIdentity.get(identity)?.fingerprint === outcome.fingerprint) {
        counts.skipped += 1
        continue
      }
      if (
        makeQuarantine(
          state,
          runId,
          meta.key,
          identity,
          byIdentity.has(identity) ? 'identity_conflict' : 'module_signed',
          byIdentity.has(identity)
            ? '稳定身份已在已签收组登记且原对象指纹不同，新对象转入隔离匣'
            : `模块已于 ${moduleState.receipt?.signedAt ?? '更早批次'} 签收，不再二次接收新对象`,
          outcome.payload,
          outcome.fingerprint,
          fieldVersion,
          at,
        )
      ) {
        counts.quarantined += 1
      }
      continue
    }

    if (!outcome.ok) {
      if (
        makeQuarantine(
          state,
          runId,
          meta.key,
          outcome.id === null ? null : stableIdentity(meta.key, outcome.id),
          outcome.reasonCode,
          outcome.reason,
          outcome.payload,
          outcome.fingerprint,
          fieldVersion,
          at,
        )
      ) {
        counts.quarantined += 1
      }
      continue
    }

    const identity = stableIdentity(meta.key, outcome.id)
    if (seenInLegacy.has(identity)) {
      // 同一稳定身份的重复旧对象：求交去重，只保留首条，不升级为冲突。
      counts.deduped += 1
      continue
    }
    seenInLegacy.add(identity)

    const existing = byIdentity.get(identity)
    if (existing) {
      // 稳定身份求交：同一身份只保留一份；指纹一致视为重复，否则转隔离匣。
      if (existing.fingerprint === outcome.fingerprint) {
        counts.skipped += 1
        continue
      }
      counts.deduped += 1
      if (
        makeQuarantine(
          state,
          runId,
          meta.key,
          identity,
          'identity_conflict',
          '稳定身份已在版本仓登记且原对象指纹不同，保留仓库条目，新对象转入隔离匣',
          outcome.payload,
          outcome.fingerprint,
          fieldVersion,
          at,
        )
      ) {
        counts.quarantined += 1
      }
      continue
    }

    const entry: RepoEntry = {
      identity,
      module: meta.key,
      id: outcome.id,
      origin: 'legacy',
      payload: outcome.payload,
      fingerprint: outcome.fingerprint,
      validation: {
        status: outcome.status,
        issues: outcome.issues,
        checkedAt: at,
        fieldVersion,
        moduleSignature: signature,
      },
      legacy: {
        format: LEGACY_FORMAT_CODE,
        module: meta.key,
        identity,
        fingerprint: outcome.fingerprint,
        importedAt: at,
        runId,
      },
      revision: 1,
    }
    moduleState.entries.push(entry)
    byIdentity.set(identity, entry)
    counts.imported += 1
  }

  if (sealed) {
    return { receipt: moduleState.receipt as ModuleReceipt, counts }
  }

  const receipt: ModuleReceipt = {
    module: meta.key,
    status: 'signed',
    format: FORMAT_CODE,
    runId,
    moduleSignature: signature,
    fieldVersion,
    entryCount: moduleState.entries.length,
    quarantinedCount: counts.quarantined,
    signedAt: at,
  }
  moduleState.receipt = receipt
  return { receipt, counts }
}

function quarantineUnknownGroups(
  state: RepositoryState,
  legacy: Record<string, unknown>,
  runId: string,
  at: string,
): number {
  let added = 0
  for (const [key, group] of Object.entries(legacy)) {
    if (MODULE_BY_KEY.has(key)) {
      continue
    }
    const rows = Array.isArray(group) ? group : [group]
    for (const raw of rows) {
      const rawId =
        raw && typeof raw === 'object' && 'id' in (raw as Record<string, unknown>)
          ? String((raw as Record<string, unknown>).id)
          : null
      if (
        makeQuarantine(
          state,
          runId,
          key,
          rawId === null ? null : stableIdentity(key, rawId),
          'unrecognized_module',
          `旧数据分组「${key}」没有登记为业务模块，整组转入隔离匣`,
          raw,
          fingerprintOf(raw),
          '',
          at,
        )
      ) {
        added += 1
      }
    }
  }
  return added
}

function runMigration(runId: string, owner: string): MigrationResult {
  const startedAt = new Date().toISOString()
  const previous = readRepository()
  const recovery = recoveryOf(previous)
  const base = {
    runId,
    recovery,
    counts: emptyCounts(),
    receipts: {},
  }

  if (!acquireLock(owner, runId)) {
    const aborted: MigrationRun = {
      runId,
      status: 'lock_abort',
      code: 'lock_abort',
      format: FORMAT_CODE,
      startedAt,
      updatedAt: startedAt,
      finishedAt: startedAt,
      receipts: {},
      counts: emptyCounts(),
      error: '迁移锁被其他标签页持有',
      recovery,
    }
    saveRun(aborted)
    return {
      ...base,
      ok: false,
      code: 'lock_abort',
      message: '另一个标签页正在迁移，本次未写入仓库；可稍后从恢复点续装',
      status: 'lock_abort',
    }
  }

  const snapshot = previous ? clone(previous) : null
  // 迁移前仓库若仍有未签收模块，说明它是本次升级中断留下的半成品：
  // 失败时不能只退回半成品，否则「整次升级」等于没撤销。只有迁移前已是完整
  // 仓库（例如对已完成仓库做重试）才回滚到该快照。
  const previousIncomplete =
    previous !== null && MODULES.some((meta) => !readModuleReceipt(previous, meta.key))
  const state: RepositoryState = previous
    ? clone(previous)
    : {
        format: FORMAT_CODE,
        createdAt: startedAt,
        updatedAt: startedAt,
        runId: null,
        modules: emptyModules(),
        quarantine: [],
      }
  state.runId = runId

  const existingRun = getMigrationRun(runId)
  const run: MigrationRun = {
    runId,
    status: 'running',
    code: 'ok',
    format: FORMAT_CODE,
    // 续装沿用原 run 的开始时间，保证追溯链不断。
    startedAt: existingRun?.startedAt ?? startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    receipts: {},
    counts: emptyCounts(),
    error: null,
    recovery,
  }
  saveRun(run)

  let committed = false
  try {
    const legacy = ensureLegacyRows() as Record<string, unknown>

    for (const meta of MODULES) {
      if (!ownsLock(owner)) {
        throw new MigrationAbort('lock_abort', '迁移锁在提交过程中丢失')
      }
      const rows = Array.isArray(legacy[meta.key]) ? (legacy[meta.key] as unknown[]) : []
      const sealedBefore = Boolean(readModuleReceipt(state, meta.key))
      const result = migrateModule(state, meta, rows, runId, new Date().toISOString())
      run.receipts[meta.key] = result.receipt
      addCounts(run.counts, result.counts)
      if (!sealedBefore) {
        // 每签收一组就落盘，中断后从签收表续装。
        state.updatedAt = new Date().toISOString()
        run.updatedAt = state.updatedAt
        run.recovery = recoveryOf(state)
        if (!ownsLock(owner)) {
          throw new MigrationAbort('lock_abort', '迁移锁在提交过程中丢失')
        }
        writeRepository(state)
        committed = true
        saveRun(run)
        refreshLock(owner, runId)
      }
    }

    const added = quarantineUnknownGroups(state, legacy, runId, new Date().toISOString())
    if (added > 0) {
      run.counts.quarantined += added
      state.updatedAt = new Date().toISOString()
      if (!ownsLock(owner)) {
        throw new MigrationAbort('lock_abort', '迁移锁在收尾时丢失')
      }
      writeRepository(state)
      committed = true
    }

    state.updatedAt = new Date().toISOString()
    state.runId = runId
    run.status = 'completed'
    run.code = 'ok'
    run.finishedAt = state.updatedAt
    run.updatedAt = state.updatedAt
    run.recovery = recoveryOf(state)
    if (!ownsLock(owner)) {
      throw new MigrationAbort('lock_abort', '迁移锁在收尾时丢失')
    }
    writeRepository(state)
    committed = true
    saveRun(run)
    releaseLock(owner)
    return {
      ok: true,
      code: 'ok',
      message: `已完成 ${MODULES.length} 组业务条目的版本仓迁移`,
      runId,
      status: 'completed',
      recovery: run.recovery,
      counts: run.counts,
      receipts: run.receipts,
    }
  } catch (error) {
    const abort = error instanceof MigrationAbort ? error : null
    const code: MigrationCode = abort?.code ?? 'apply_fail'
    const message = error instanceof Error ? error.message : '迁移写入失败'
    // 整次升级撤销：恢复迁移前快照；如果仓库已被另一个 run 接管，不再覆盖别人的写入。
    const current = readRepository()
    let rollbackError: string | null = null
    if (committed && current && current.runId === runId) {
      try {
        if (snapshot && !previousIncomplete) {
          writeRepository(snapshot)
        } else {
          removeKey(REPOSITORY_STORAGE_KEY)
        }
      } catch (rollbackFailure) {
        rollbackError =
          rollbackFailure instanceof Error ? rollbackFailure.message : '回滚快照写入失败'
      }
    }
    run.status = 'rolled_back'
    run.code = code
    run.error = rollbackError ? `${message}；回滚未完成：${rollbackError}` : message
    run.finishedAt = new Date().toISOString()
    run.updatedAt = run.finishedAt
    run.recovery = recoveryOf(readRepository())
    saveRun(run)
    releaseLock(owner)
    return {
      ok: false,
      code,
      message:
        code === 'lock_abort'
          ? `迁移锁丢失，本次升级已撤销：${message}`
          : `迁移失败，本次升级已撤销：${message}`,
      runId,
      status: 'rolled_back',
      recovery: run.recovery,
      counts: run.counts,
      receipts: run.receipts,
    }
  }
}

/** 开始一次全新迁移 run；重试永远创建新 run。 */
export function startMigration(options: { owner?: string } = {}): MigrationResult {
  return runMigration(newRunId(Date.now()), options.owner ?? TAB_ID)
}

/** 从中断/锁冲突的恢复点续装；不传 runId 时取最近一次可续的 run。 */
export function resumeMigration(runId?: string, options: { owner?: string } = {}): MigrationResult {
  const target = runId ? getMigrationRun(runId) : latestInterruptedRun()
  if (!target) {
    return {
      ok: false,
      code: 'no_match',
      message: '没有可续装的迁移恢复点',
      runId: runId ?? '',
      status: 'idle',
      recovery: recoveryOf(readRepository()),
      counts: emptyCounts(),
      receipts: {},
    }
  }
  if (target.status === 'completed') {
    return {
      ok: true,
      code: 'ok',
      message: '该 run 已完成签收，无需续装',
      runId: target.runId,
      status: 'completed',
      recovery: recoveryOf(readRepository()),
      counts: target.counts,
      receipts: target.receipts,
    }
  }
  // 续装沿用原 run：已签收的组由签收表跳过，未签收的组继续接收对象。
  return runMigration(target.runId, options.owner ?? TAB_ID)
}

// ---------------------------------------------------------------------------
// 状态 / 回看 / 隔离匣
// ---------------------------------------------------------------------------

export function migrationStatus(): MigrationStatus {
  const repo = readRepository()
  const latest = readRunHistory().runs[0] ?? null
  const modules: MigrationModuleStatus[] = MODULES.map((meta) => {
    const moduleState = repo?.modules?.[meta.key]
    const receipt = moduleState?.receipt ?? null
    const currentField = currentFieldVersion(meta)
    const storedField = receipt?.fieldVersion ?? moduleState?.fieldVersion ?? null
    return {
      key: meta.key,
      name: meta.name,
      format: FORMAT_CODE,
      signed: Boolean(receipt),
      receiptRunId: receipt?.runId ?? null,
      signedAt: receipt?.signedAt ?? null,
      moduleSignature: currentModuleSignature(meta),
      storedFieldVersion: storedField,
      currentFieldVersion: currentField,
      fieldVersionMatch: storedField !== null && storedField === currentField,
      entries: moduleState?.entries.length ?? 0,
      quarantined: repo?.quarantine.filter((item) => item.module === meta.key).length ?? 0,
    }
  })
  const legacyEntries = Object.values(readLegacyRows()).reduce(
    (sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0),
    0,
  )
  return {
    code: repo ? 'ok' : 'no_match',
    repository: Boolean(repo),
    format: repo ? FORMAT_CODE : LEGACY_FORMAT_CODE,
    runId: latest?.runId ?? null,
    runStatus: latest?.status ?? 'idle',
    modules,
    totals: {
      modules: MODULES.length,
      signedModules: modules.filter((item) => item.signed).length,
      entries: modules.reduce((sum, item) => sum + item.entries, 0),
      quarantined: repo?.quarantine.length ?? 0,
      legacyEntries,
    },
  }
}

function checkFieldVersion(meta: ModuleMeta, moduleState: RepoModule | undefined): FieldVersionCheck {
  const stored = moduleState?.receipt?.fieldVersion ?? moduleState?.fieldVersion ?? null
  const current = currentFieldVersion(meta)
  return { stored, current, match: stored !== null && stored === current }
}

export function listQuarantine(moduleKey?: string): QuarantineRecord[] {
  const repo = readRepository()
  if (!repo) {
    return []
  }
  return moduleKey ? repo.quarantine.filter((item) => item.module === moduleKey) : repo.quarantine
}

export function reviewModule(moduleKey: string): ModuleReview {
  const meta = MODULE_BY_KEY.get(moduleKey)
  if (!meta) {
    return {
      code: 'no_match',
      module: moduleKey,
      fieldVersion: { stored: null, current: '', match: false },
      moduleSignature: '',
      currentModuleSignature: '',
      signatureMatch: false,
      entries: [],
      quarantine: [],
      message: `没有登记名为 ${moduleKey} 的模块`,
    }
  }
  const repo = readRepository()
  const moduleState = repo?.modules?.[moduleKey]
  const storedSignature = moduleState?.receipt?.moduleSignature ?? moduleState?.moduleSignature ?? ''
  const signature = currentModuleSignature(meta)
  return {
    code: moduleState ? 'ok' : 'no_match',
    module: moduleKey,
    fieldVersion: checkFieldVersion(meta, moduleState),
    moduleSignature: storedSignature,
    currentModuleSignature: signature,
    signatureMatch: storedSignature === signature,
    entries: moduleState?.entries ?? [],
    quarantine: repo?.quarantine.filter((item) => item.module === moduleKey) ?? [],
    message: moduleState ? '已按版本仓回看' : '该模块尚未迁移到版本仓',
  }
}

export function reviewEntry(moduleKey: string, id: number): EntryReview {
  const meta = MODULE_BY_KEY.get(moduleKey)
  const repo = readRepository()
  const moduleState = repo?.modules?.[moduleKey]
  const identity = stableIdentity(moduleKey, id)
  const entry = moduleState?.entries.find((item) => item.identity === identity) ?? null
  const version = meta
    ? checkFieldVersion(meta, moduleState)
    : { stored: null, current: '', match: false }
  if (!entry) {
    return {
      code: 'no_match',
      module: moduleKey,
      identity,
      fieldVersion: version,
      entry: null,
      quarantine: repo?.quarantine.filter((item) => item.identity === identity) ?? [],
      message: `版本仓里没有找到 ${identity}`,
    }
  }
  return {
    code: 'ok',
    module: moduleKey,
    identity,
    fieldVersion: version,
    entry,
    quarantine: repo?.quarantine.filter((item) => item.identity === identity) ?? [],
    message: version.match ? '字段版本一致' : '字段版本与迁移签收时不一致，请核对字段定义',
  }
}
