export async function POST(request: Request) {
  try {
    const response = await fetch('http://127.0.0.1:3001/api/quote', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: await request.text(), cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    return new Response(response.body, {status: response.status,
      headers: {'Content-Type':'application/json','Cache-Control':'no-store'}});
  } catch {
    return Response.json({error:'Backend quote unavailable'}, {status:503});
  }
}
