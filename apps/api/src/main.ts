import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { secretsKeyConfigured } from './common/crypto-secrets';

async function bootstrap(): Promise<void> {
  const tp = process.env.TRUST_PROXY;
  const trustProxy: boolean | string = tp && /^\d+$/.test(tp) ? tp : !!tp;
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy, bodyLimit: 4 * 1024 * 1024 }));
  const config = app.get(ConfigService<Env, true>);
  if (!secretsKeyConfigured()) new Logger('Seguranca').warn('SECRETS_KEY ausente — segredos do RD gravados em TEXTO PURO (só aceitável em dev).');

  const webDist = config.get('WEB_DIST_DIR', { infer: true });
  const servingSpa = !!(webDist && existsSync(webDist));
  await app.register(helmet, servingSpa ? { contentSecurityPolicy: false } : {});
  await app.register(cookie);
  app.enableCors({ origin: [config.get('CORS_ORIGIN', { infer: true })], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] });
  app.setGlobalPrefix('api');
  if (servingSpa) await app.register(fastifyStatic, { root: webDist!, wildcard: false });
  app.enableShutdownHooks();
  const port = config.get('PORT', { infer: true });
  await app.listen({ port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API em http://localhost:${port}/api`);
}
bootstrap().catch((err) => { console.error('Erro fatal no boot:', err); process.exit(1); });
