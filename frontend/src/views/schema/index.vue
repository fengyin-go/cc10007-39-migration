<template>
  <section class="page" data-module="schema">
    <header class="page-head">
      <div>
        <h2>元数据管理管理</h2>
        <p class="page-desc">维护元数据字段定义的输入、执行约束与结果记录，为元数据管理提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记字段定义</button>
        <button class="btn" type="button" @click="exportRows">导出元数据管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="repo-panel" data-repo-panel>
      <header class="repo-head">
        <div>
          <h3 class="repo-title">版本仓迁移</h3>
          <p class="repo-desc">
            当前存储格式：<code>{{ migration.format }}</code>
            · 已签收 {{ migration.totals.signedModules }}/{{ migration.totals.modules }} 组
            · 仓库条目 {{ migration.totals.entries }} 条 · 隔离 {{ migration.totals.quarantined }} 条
            · 旧裸对象 {{ migration.totals.legacyEntries }} 条（只读保留）
          </p>
          <p class="repo-desc">
            run：<code>{{ migration.runId ?? '—' }}</code> · 状态 {{ migration.runStatus }}
            · 字段版本
            <code>{{ fieldVersionStatus.match ? '一致' : '不一致' }}</code>
            (<code>{{ fieldVersionStatus.stored ?? '—' }}</code> →
            <code>{{ fieldVersionStatus.current }}</code>)
          </p>
        </div>
        <div class="repo-actions">
          <button class="btn primary" type="button" @click="beginUpgrade">开始迁移</button>
          <button class="btn" type="button" @click="resumeUpgrade">从中断点续装</button>
          <button class="btn" type="button" @click="toggleQuarantine">
            {{ showQuarantine ? '收起隔离匣' : '查看隔离匣' }}
          </button>
        </div>
      </header>
      <p v-if="migrationMessage" class="repo-message" :data-code="migrationCode">
        [{{ migrationCode }}] {{ migrationMessage }}
      </p>

      <table v-if="showQuarantine" class="data-table repo-quarantine">
        <thead>
          <tr><th>隔离编号</th><th>模块</th><th>身份</th><th>原因码</th><th>原因</th><th>原对象指纹</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in quarantine" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.module }}</td>
            <td>{{ item.identity ?? '—' }}</td>
            <td>{{ item.reasonCode }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.fingerprint }}</td>
          </tr>
          <tr v-if="!quarantine.length">
            <td colspan="6" class="empty-state">隔离匣为空</td>
          </tr>
        </tbody>
      </table>

      <table class="data-table repo-modules">
        <thead>
          <tr>
            <th>业务模块</th><th>格式</th><th>签收</th><th>签收 run</th>
            <th>条目</th><th>隔离</th><th>字段版本</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in migration.modules" :key="item.key">
            <td>{{ item.name }}</td>
            <td>{{ item.format }}</td>
            <td>{{ item.signed ? '已签收' : '未签收' }}</td>
            <td>{{ item.receiptRunId ?? '—' }}</td>
            <td>{{ item.entries }}</td>
            <td>{{ item.quarantined }}</td>
            <td>{{ item.fieldVersionMatch ? '一致' : '不一致' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="inspectRow(row)">回看来源</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state" data-empty-code="no_match">
            暂无元数据管理数据，可先登记字段定义
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="reviewMessage" class="repo-message" data-review>
      {{ reviewMessage }}
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条元数据管理记录</span>
      <span v-if="errorMessage" class="error-text" data-code="apply_fail">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  beginMigration,
  continueMigration,
  downloadEntries,
  loadMigrationStatus,
  loadQuarantine,
  listEntries,
  moduleMeta,
  reviewEntryTrace,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type {
  MigrationCode,
  MigrationStatus,
  QuarantineRecord,
} from '@/data/repository'

const meta = moduleMeta('schema')
const columns = ["字段编号", "所属表名", "字段名称", "字段类型", "可空标识", "默认值", "业务含义", "版本号"]
const actions = ["提交审核", "生效发布", "作废下线"]
const statuses = ["草稿", "待审核", "已生效", "已作废"]
const stats = [{"label": "字段定义总数", "value": 0}, {"label": "已生效字段", "value": 0}, {"label": "待审核字段", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const migration = ref<MigrationStatus>(loadMigrationStatus())
const migrationMessage = ref('')
const migrationCode = ref<MigrationCode>('ok')
const showQuarantine = ref(false)
const quarantine = ref<QuarantineRecord[]>([])
const reviewMessage = ref('')

const fieldVersionStatus = computed(() => {
  const self = migration.value.modules.find((item) => item.key === meta.key)
  return {
    match: Boolean(self?.fieldVersionMatch),
    stored: self?.storedFieldVersion ?? null,
    current: self?.currentFieldVersion ?? '',
  }
})

function refreshMigration() {
  migration.value = loadMigrationStatus()
  if (showQuarantine.value) {
    quarantine.value = loadQuarantine()
  }
}

function applyMigrationResult(result: { code: MigrationCode; message: string }) {
  migrationCode.value = result.code
  migrationMessage.value = result.message
  showQuarantine.value = true
  quarantine.value = loadQuarantine()
  refreshMigration()
  reload()
}

function beginUpgrade() {
  applyMigrationResult(beginMigration())
}

function resumeUpgrade() {
  applyMigrationResult(continueMigration())
}

function toggleQuarantine() {
  showQuarantine.value = !showQuarantine.value
  quarantine.value = showQuarantine.value ? loadQuarantine() : []
}

function inspectRow(row: EntryRow) {
  const review = reviewEntryTrace(meta.key, Number(row.id))
  if (review.code === 'no_match') {
    reviewMessage.value = `[no_match] ${review.message}`
    return
  }
  const entry = review.entry
  const source = entry?.legacy
  const issues = entry?.validation.issues.length ? entry.validation.issues.join(', ') : '无'
  reviewMessage.value = [
    `[ok] ${review.identity}`,
    source
      ? `旧格式来源 ${source.format}（模块 ${source.module}，指纹 ${source.fingerprint}）`
      : '运行期新增，无旧格式来源',
    `逐条校验 ${entry?.validation.status}，问题：${issues}`,
    `字段版本 ${review.fieldVersion.match ? '一致' : '不一致'}（${review.fieldVersion.stored ?? '—'}）`,
    review.quarantine.length
      ? `隔离记录 ${review.quarantine.length} 条：${review.quarantine
          .map((item) => item.reasonCode)
          .join(', ')}`
      : '无隔离记录',
  ].join('；')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '字段定义登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '元数据管理列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshMigration()
})
</script>
