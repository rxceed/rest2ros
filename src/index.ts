import { Elysia, t } from 'elysia';
import { RosBridge, RosDisconnectedError, validateRosbridgeUrl } from './ros';

const dashboardUrl = new URL('./dashboard.html', import.meta.url);

export function createApp(bridge = new RosBridge()) {
  const wsCleanups = new Map<string, { offStatus: () => void; subs: Map<string, () => void> }>();

  return new Elysia()
    // ponytail: wildcard CORS (*); switch to an origin allowlist + Vary: Origin if exposed beyond a trusted LAN or if credentials are needed.
    .onRequest(({ request, set }) => {
      set.headers['access-control-allow-origin'] = '*';
      if (request.method === 'OPTIONS') {
        set.headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
        set.headers['access-control-allow-headers'] =
          request.headers.get('access-control-request-headers') || 'Content-Type, Authorization';
        set.headers['access-control-max-age'] = '86400';
        set.headers['vary'] = 'Access-Control-Request-Headers';
        set.status = 204;
        return new Response(null, { status: 204 });
      }
    })
    .onError(({ error, set }) => {
      if (error instanceof RosDisconnectedError) {
        set.status = 503;
        return { error: error.message };
      }
    })
    .get('/', () => new Response(Bun.file(dashboardUrl), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))
    .get('/api/status', () => bridge.getStatus())
    .get('/api/config', () => ({ url: bridge.getStatus().url }))
    .post(
      '/api/config',
      ({ body, set }) => {
        try {
          validateRosbridgeUrl(body.url);
        } catch (err) {
          set.status = 400;
          return { error: err instanceof Error ? err.message : 'Invalid rosbridge URL' };
        }
        return bridge.connect(body.url);
      },
      { body: t.Object({ url: t.String({ minLength: 1 }) }) },
    )
    .post('/api/reconnect', () => bridge.connect())
    .get('/api/topics', async ({ set }) => {
      try {
        return { topics: await bridge.getTopics() };
      } catch (err) {
        if (err instanceof RosDisconnectedError) throw err;
        set.status = 502;
        return { error: err instanceof Error ? err.message : 'Failed to fetch topics' };
      }
    })
    .post(
      '/api/topics/publish',
      ({ body }) => {
        bridge.publish(body.topic, body.type, body.payload);
        return { ok: true, topic: body.topic, type: body.type };
      },
      {
        body: t.Object({
          topic: t.String({ minLength: 1 }),
          type: t.String({ minLength: 1 }),
          payload: t.Record(t.String(), t.Unknown()),
        }),
      },
    )
    .get('/api/services', async ({ set }) => {
      try {
        return { services: await bridge.getServices() };
      } catch (err) {
        if (err instanceof RosDisconnectedError) throw err;
        set.status = 502;
        return { error: err instanceof Error ? err.message : 'Failed to fetch services' };
      }
    })
    .post(
      '/api/services/call',
      async ({ body, set }) => {
        try {
          const response = await bridge.callService(body.service, body.type, body.request ?? {});
          return { ok: true, service: body.service, response };
        } catch (err) {
          if (err instanceof RosDisconnectedError) throw err;
          set.status = 502;
          return { error: err instanceof Error ? err.message : 'Service call failed' };
        }
      },
      {
        body: t.Object({
          service: t.String({ minLength: 1 }),
          type: t.String({ minLength: 1 }),
          request: t.Optional(t.Record(t.String(), t.Unknown())),
        }),
      },
    )
    .ws('/ws', {
      body: t.Union([
        t.Object({
          action: t.Literal('subscribe'),
          topic: t.String({ minLength: 1 }),
          type: t.Optional(t.String()),
        }),
        t.Object({
          action: t.Literal('unsubscribe'),
          topic: t.String({ minLength: 1 }),
        }),
      ]),
      open(ws) {
        const subs = new Map<string, () => void>();
        const offStatus = bridge.onStatusChange((status) => {
          ws.send({ type: 'status', data: status });
        });
        wsCleanups.set(ws.id, { offStatus, subs });
        ws.send({ type: 'status', data: bridge.getStatus() });
      },
      message(ws, msg) {
        const state = wsCleanups.get(ws.id);
        if (!state) return;

        if (msg.action === 'subscribe') {
          state.subs.get(msg.topic)?.();
          const unsub = bridge.subscribe(msg.topic, msg.type ?? '', (data) => {
            ws.send({ type: 'message', topic: msg.topic, data, ts: Date.now() });
          });
          state.subs.set(msg.topic, unsub);
        } else {
          state.subs.get(msg.topic)?.();
          state.subs.delete(msg.topic);
        }
      },
      close(ws) {
        const state = wsCleanups.get(ws.id);
        if (!state) return;
        state.offStatus();
        for (const unsub of state.subs.values()) unsub();
        wsCleanups.delete(ws.id);
      },
    });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const bridge = new RosBridge();
  const app = createApp(bridge).listen(port);
  console.log(`rest2ros listening on http://localhost:${app.server?.port} (rosbridge: ${bridge.getStatus().url})`);
}
