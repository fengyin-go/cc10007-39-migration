/**
 * 版本仓使用的确定性指纹与签名工具。
 *
 * 所有哈希都在浏览器本地计算，不依赖后端：
 * - 原对象指纹：对旧裸对象做规范化 JSON 后取 FNV-1a 64 位哈希；
 * - 模块签名：对模块元数据（字段、状态、动作、流转目标）取哈希；
 * - 字段定义版本：只对字段清单取哈希，回看时用来核对字段定义是否漂移。
 */

/** 键排序后的规范化 JSON：同一对象的不同键顺序会得到同一个指纹。 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  // undefined / function / symbol 在旧对象里不应出现，兜底成稳定字符串。
  return encoded === undefined ? `"<${typeof value}>"` : encoded
}

/** FNV-1a 64 位哈希，输出带算法前缀，便于以后更换算法时识别。 */
export function hashText(text: string): string {
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

/** 原对象指纹：旧条目迁移前后都可复算。 */
export function fingerprintOf(value: unknown): string {
  return hashText(canonicalJson(value))
}

/** 稳定身份：模块内以 id 求交，跨模块不会串号。 */
export function stableIdentity(moduleKey: string, id: number | string): string {
  return `${moduleKey}#${String(id)}`
}
