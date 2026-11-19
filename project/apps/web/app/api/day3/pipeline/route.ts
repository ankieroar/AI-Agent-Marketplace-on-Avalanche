export async function POST(request: Request) {
  try {
    const response = await fetch('http://127.0.0.1:3001/api/dispute-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await request.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(280_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'API phân tích chưa phản hồi. Kiểm tra backend và kết nối OpenRouter.' }, { status: 503 });
  }
}
