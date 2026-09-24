import { expect, type Page, type Route } from '@playwright/test'

/** 把一段文本包装成 OpenAI 兼容的 SSE 流 */
export function sseBody(text: string, chunkSize = 6): string {
  const parts: string[] = []
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += chunkSize) {
    const content = chars.slice(i, i + chunkSize).join('')
    parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
  }
  parts.push('data: [DONE]\n\n')
  return parts.join('')
}

export interface MockedRequest {
  url: string
  body: { messages?: { role: string; content: string }[]; stream?: boolean; model?: string }
  authorization: string | null
}

/**
 * 拦截所有 chat/completions 请求。reply 返回模型输出文本；
 * 流式请求回 SSE，非流式回一次性 JSON。返回捕获到的请求列表。
 */
export async function mockAI(
  page: Page,
  reply: (req: MockedRequest) => string
): Promise<MockedRequest[]> {
  const seen: MockedRequest[] = []
  await page.route('**/chat/completions', async (route: Route) => {
    const req = route.request()
    const body = JSON.parse(req.postData() || '{}')
    const captured: MockedRequest = {
      url: req.url(),
      body,
      authorization: (await req.allHeaders())['authorization'] ?? null,
    }
    seen.push(captured)
    const text = reply(captured)
    const headers = { 'access-control-allow-origin': '*' }
    if (body.stream) {
      await route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'text/event-stream' },
        body: sseBody(text),
      })
    } else {
      await route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ choices: [{ message: { content: text } }] }),
      })
    }
  })
  return seen
}

/** 等到第 n 个（从 0 起）请求到达：请求在点击 / 按键之后才异步发出，不能立即读取 */
export async function requestAt(seen: MockedRequest[], n = 0): Promise<MockedRequest> {
  await expect.poll(() => seen.length).toBeGreaterThan(n)
  return seen[n]
}

/** 进入应用并载入示例文稿 */
export async function openSample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByText('载入示例《没有雨的城市》').click()
  await page.locator('.block-flow .block').first().waitFor()
}
