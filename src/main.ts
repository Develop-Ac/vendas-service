// src/main.ts
// Precisa ser o primeiro import: carrega o .env em process.env antes que
// qualquer módulo seja avaliado (o @prisma/client não lê o .env em runtime —
// só a CLI do Prisma lê). Em produção as variáveis vêm do ambiente do
// container e o dotenv não sobrescreve o que já está definido.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

const BODY_LIMIT = 25 * 1024 * 1024; // 25mb (equivale ao limit do body-parser anterior)

function parseOrigins(env?: string): (string | RegExp)[] {
  if (!env) return [];
  return env
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      // Permite regex usando prefixo "regex:"
      if (s.startsWith('regex:')) {
        const pattern = s.slice(6);
        return new RegExp(pattern);
      }
      return s;
    });
}

function isAllowedOrigin(origin: string | undefined, allowed: (string | RegExp)[]) {
  if (!origin) return true; // requests server-to-server, curl, etc.
  if (allowed.length === 0) return true; // se não configurou nada, libera
  for (const rule of allowed) {
    if (rule instanceof RegExp && rule.test(origin)) return true;
    if (typeof rule === 'string' && rule === origin) return true;
  }
  return false;
}

async function bootstrap() {
  // ignoreTrailingSlash: "/orcamento" e "/orcamento/" são a mesma rota — sem
  // isso o Fastify responde 404 ("Cannot POST /orcamento/") a um cliente que
  // monte a URL com barra no fim.
  const adapter = new FastifyAdapter({ bodyLimit: BODY_LIMIT, ignoreTrailingSlash: true });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  // Se estiver atrás de proxy reverso (Nginx/Traefik) e usar cookies Secure, habilite
  // `trustProxy: true` nas opções do FastifyAdapter acima.

  await app.register(cookie);

  // bodyParser.json/urlencoded: o FastifyAdapter registra os parsers de application/json
  // e application/x-www-form-urlencoded automaticamente, ambos honrando o bodyLimit acima.

  // Substitui o MulterModule/memoryStorage: uploads multipart são lidos pelo
  // FastifyFileInterceptor (src/common/interceptors/fastify-file.interceptor.ts).
  await app.register(multipart, { limits: { fileSize: BODY_LIMIT } });

  await app.register(helmet, {
    contentSecurityPolicy: false,     // necessário para swagger-ui
    crossOriginEmbedderPolicy: false, // evita bloqueio de assets
  });

  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/docs')) return done();

    const authHeader = req.headers.authorization;

    const user = 'admin';
    const password = 'Ac@2025acesso';

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
      return void reply.code(401).send('Autenticação necessária');
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');

    const [inputUser, inputPassword] = credentials.split(':');

    if (inputUser !== user || inputPassword !== password) {
      reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
      return void reply.code(401).send('Usuário ou senha inválidos');
    }

    done();
  });

  const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN);
  // Ex.: CORS_ORIGIN="http://intranet.acacessorios.local,http://localhost:3000"
  // ou   CORS_ORIGIN="regex:^https?://(localhost:\d+|.*\.acacessorios\.local)$"

  app.enableCors({
    origin: (origin, callback) => {
      const ok = isAllowedOrigin(origin, allowedOrigins);
      callback(null, ok);
    },
    credentials: true, // necessário se usar cookies/autenticação
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'Cache-Control',
      'Pragma',
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400, // cache do preflight por 1 dia
  });

  // Garante Vary: Origin (útil se usar origin dinâmico/função)
  fastify.addHook('onSend', (_req: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err?: Error | null, payload?: unknown) => void) => {
    reply.header('Vary', 'Origin');
    done(null, payload);
  });

  // (opcional) prefixo global
  // app.setGlobalPrefix('api');

  // === Swagger only if enabled ===
  if (process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Intranet AC Acessórios - Service API')
      .setDescription(`
      API de serviços do sistema de intranet da AC Acessórios

      ## Módulos disponíveis:
      - **Login**: Autenticação de usuários
      - **Usuário**: Gerenciamento de usuários

      ## Autenticação:
      A API utiliza tokens de acesso que podem ser enviados via query parameter \`token\` ou header \`Authorization: Bearer <token>\`.
      `)
      .setVersion('2.0.0')
      .setContact('AC Acessórios - TI', 'https://acacessorios.com.br', 'ti@acacessorios.com.br')
      .setLicense('Proprietário', '')
      .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT para autenticação',
      },
      'jwt',
      )
      .addApiKey(
      {
        type: 'apiKey',
        name: 'token',
        in: 'query',
        description: 'TOKEN de acesso da aplicação enviado via query parameter',
      },
      'appToken',
      )
      .addServer(process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT || 8000}`, 'Servidor de Desenvolvimento')
      .addServer('http://vendas-service.acacessorios.local', 'Servidor de Produção')
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
      deepScanRoutes: true,
    });

    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        showRequestHeaders: true,
        tryItOutEnabled: true,
      },
      customSiteTitle: 'Intranet AC Acessórios — API Documentation',
      customfavIcon: '/favicon.ico',
      customJs: [
        'https://unpkg.com/swagger-ui-themes@3.0.1/themes/3.x/theme-material.css',
      ],
      customCssUrl: [
        'https://unpkg.com/swagger-ui-themes@3.0.1/themes/3.x/theme-material.css',
      ],
    });
    // UI: /docs • JSON: /docs-json
  }

  const port = parseInt(process.env.PORT || '8000', 10);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.SWAGGER_ENABLED === 'true') {
    console.log(`Swagger em http://localhost:${port}/docs`);
  }
}
bootstrap();
