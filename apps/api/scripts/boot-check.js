#!/usr/bin/env node
// Compila o AppModule inteiro sobre o dist (fiação do Nest) sem conectar em nada.
const path = require('path');
const ENV_FAKE = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://boot:boot@127.0.0.1:1/boot', JWT_ACCESS_SECRET: 'boot-check-secret-com-mais-de-16-chars', SECRETS_KEY: 'boot' };
for (const [k, v] of Object.entries(ENV_FAKE)) if (process.env[k] === undefined) process.env[k] = v;
(async () => {
  const { Test } = require('@nestjs/testing');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const t0 = Date.now();
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ref.close();
  console.log(`boot-check OK em ${Date.now() - t0} ms`);
})().catch((e) => { console.error('boot-check FALHOU:', e && e.message ? e.message : e); process.exit(1); });
