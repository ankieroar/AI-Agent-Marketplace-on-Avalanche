const order = /^orders\/0x[0-9a-f]{64}$/i;
const serviceAction = /^orders\/0x[0-9a-f]{64}\/(execute|retry|result|chat)$/i;
type Context = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: Context) {
  const route = (await context.params).path.join('/');
  const read = request.method === 'GET' && (route === 'agents' || order.test(route));
  const write = request.method === 'POST' &&
    (serviceAction.test(route) || route === 'cases/upload');
  if (!read && !write) return Response.json({error:'Unknown endpoint'}, {status:404});
  const headers = new Headers();
  for (const key of ['Content-Type','X-Wallet-Expires','X-Wallet-Signature']) {
    const value = request.headers.get(key);
    if (value) headers.set(key,value);
  }
  try {
    const response = await fetch('http://127.0.0.1:3001/api/'+route,{
      method:request.method,headers,body:write?await request.text():undefined,cache:'no-store',
      signal:AbortSignal.timeout(/\/(execute|retry)$/.test(route) ? 100_000 : 55_000),
    });
    return new Response(response.body,{status:response.status,headers:{
      'Content-Type':'application/json','Cache-Control':'no-store',
    }});
  } catch {
    return Response.json({error:'API local không phản hồi. Kiểm tra npm run dev:api.'},{status:503});
  }
}
export const GET=forward;
export const POST=forward;
