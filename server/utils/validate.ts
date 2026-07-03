import { createError } from 'h3'

/**
 * 校验 endpoint 是合法的 http(s) URL。
 * 抛出 h3 400 错误，便于在 API 层直接使用。
 */
export function assertEndpoint(endpoint: string): void {
  let url: URL
  try {
    url = new URL(endpoint)
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'endpoint 必须是合法的 http(s):// 地址' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createError({ statusCode: 400, statusMessage: 'endpoint 必须以 http:// 或 https:// 开头' })
  }
}

/** 断言字符串非空（trim 后） */
export function assertNonEmpty(value: string | undefined, field: string): void {
  if (!value || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${field}不能为空` })
  }
}
