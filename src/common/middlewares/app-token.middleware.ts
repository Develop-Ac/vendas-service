// src/common/middlewares/app-token.middleware.ts
import { FastifyReply, FastifyRequest } from 'fastify';

const APP_TOKEN = process.env.APP_TOKEN || '';

/**
 * Validação do token da aplicação.
 *
 * Portado do antigo `AppTokenMiddleware` (NestMiddleware com tipos do Express) para um
 * hook do Fastify — um `NestMiddleware` no Fastify recebe os objetos crus do Node
 * (IncomingMessage/ServerResponse) via @fastify/middie, sem `req.query`, `req.body`
 * nem `res.status()`, então a forma correta aqui é um hook.
 *
 * A lógica de validação é idêntica à anterior. Assim como antes da migração, este hook
 * NÃO está registrado em lugar nenhum — para ativá-lo:
 *
 *   app.getHttpAdapter().getInstance().addHook('preHandler', appTokenHook);
 *
 * Use `preHandler` (e não `onRequest`) porque a checagem depende do body já parseado.
 */
export async function appTokenHook(req: FastifyRequest, reply: FastifyReply) {
  if (req.method === 'OPTIONS') return reply.code(204).send();

  // whitelist do Swagger
  const path = req.url.split('?')[0] || '';
  if (
    path.startsWith('/docs') ||     // UI e assets
    path.startsWith('/docs-json') ||// JSON
    path.startsWith('/health')      // healthcheck, se tiver
  ) {
    return;
  }

  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown> | undefined;

  const tokenFromBody = (body && (body.token as string)) || '';
  const tokenFromQuery = (query?.token as string) || '';
  const token = tokenFromBody || tokenFromQuery;

  if (!token) {
    return reply
      .code(401)
      .send({ error: 'TOKEN_MISSING', message: 'Token é obrigatório.' });
  }
  if (token !== APP_TOKEN) {
    return reply
      .code(403)
      .send({ error: 'TOKEN_INVALID', message: 'Token inválido.' });
  }

  if (body && 'token' in body) delete body.token;
}
