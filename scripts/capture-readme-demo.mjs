// Recreate: npm exec --yes --package=playwright -- playwright install chromium
// Capture:  npm exec --yes --package=playwright -- node scripts/capture-readme-demo.mjs
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 22500;
const origin = `http://127.0.0.1:${port}`;
const output = join(root, 'docs/images/leads-demo.png');
const cli = await realpath(execFileSync('which', ['playwright'], { encoding: 'utf8' }).trim());
const { chromium } = createRequire(cli)('playwright');
const leads = [
  ['Marina Costa', 'marina.costa@example.com', 'Aurora Energia', 'Curitiba', 'PR', ['inbound', 'ebook-solar'], 'Lead', 'morno', ['Energia solar', 'Leads de setembro']],
  ['Rafael Almeida', 'rafael.almeida@example.com', 'Nuvem Clara Tecnologia', 'São Paulo', 'SP', ['demo-solicitada', 'enterprise'], 'Oportunidade', 'quente', ['SaaS B2B', 'Alta intenção']],
  ['Camila Nogueira', 'camila.nogueira@example.com', 'Verde Campo Alimentos', 'Londrina', 'PR', ['evento', 'newsletter'], 'Lead', 'frio', ['Agronegócio']],
  ['Bruno Martins', 'bruno.martins@example.com', 'Ponto Norte Logística', 'Joinville', 'SC', ['indicação', 'frete'], 'Cliente', 'quente', ['Logística', 'Expansão']],
  ['Isabela Rocha', 'isabela.rocha@example.com', 'Ateliê Horizonte', 'Florianópolis', 'SC', ['conteúdo', 'varejo'], 'Lead', 'morno', ['Varejo', 'Inbound']],
  ['Thiago Ferreira', 'thiago.ferreira@example.com', 'Prisma Saúde Digital', 'São Paulo', 'SP', ['webinar', 'healthtech'], 'Oportunidade', 'quente', ['Healthtech', 'Decisor']],
  ['Luiza Barros', 'luiza.barros@example.com', 'Casa Ipê Design', 'Maringá', 'PR', ['orgânico', 'design'], 'Lead', 'frio', ['Design', 'Newsletter']],
  ['Pedro Carvalho', 'pedro.carvalho@example.com', 'Rota Azul Turismo', 'Foz do Iguaçu', 'PR', ['campanha', 'turismo'], 'Cliente', 'morno', ['Turismo', 'Recorrente']],
].map(([name, email, company, city, state, tags, lifecycleStage, aiScore, segmentNames], i) => ({
  id: 'demo-' + (i + 1), rdUuid: 'demo-rd-' + (i + 1), name, email, phone: null, city, state, company,
  jobTitle: ['Gerente de Marketing', 'Diretor Comercial', 'Coordenadora de Growth', 'Sócio-diretor'][i % 4],
  tags, lifecycleStage, opportunity: lifecycleStage === 'Oportunidade', fit: 'alto', interest: 70 + i * 3,
  conversionsCount: 2 + i, firstConversionAt: `2026-09-${String(19 + i).padStart(2, '0')}T12:00:00.000Z`,
  lastConversionAt: `2026-10-0${1 + (i % 2)}T15:00:00.000Z`, rdCreatedAt: `2026-09-${String(19 + i).padStart(2, '0')}T12:00:00.000Z`,
  segments: segmentNames.map((name) => ({ id: `segment-${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name })), aiScore,
}));
const segments = [...new Map(leads.flatMap((l) => l.segments).map((s) => [s.id, s])).values()].map((s) => ({ ...s, standard: false, selected: true, available: true, coverage: 'complete' }));
const facets = {
  tags: [...new Set(leads.flatMap((l) => l.tags))].map((value) => ({ value, count: leads.filter((l) => l.tags.includes(value)).length })),
  lifecycleStages: [...new Set(leads.map((l) => l.lifecycleStage))].map((value) => ({ value, count: leads.filter((l) => l.lifecycleStage === value).length })),
  conversoes: [{ value: 'formulario-contato', count: 8 }, { value: 'ebook-download', count: 4 }],
};
const user = { id: 'demo-admin', name: 'Admin Demo', email: 'admin.demo@example.com', role: 'admin', accountId: 'demo-account', accountName: 'Conta Demonstração', isSuperAdmin: false };
let server;
const waitForServer = async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Vite não iniciou em 127.0.0.1:22500');
};
try {
  server = spawn('corepack', ['pnpm', '--filter', '@rd/web', 'dev', '--', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (url.pathname === '/api/auth/refresh') return route.fulfill({ json: { accessToken: 'demo-token' } });
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: user });
      if (url.pathname.startsWith('/api/leads/facets')) return route.fulfill({ json: facets });
      if (url.pathname === '/api/leads/saved-views') return route.fulfill({ json: [] });
      if (url.pathname === '/api/leads') return route.fulfill({ json: { items: leads, total: leads.length, page: 1, pageSize: 25 } });
      if (url.pathname === '/api/rd/connection') return route.fulfill({ json: { status: 'active', hasClientSecret: true, clientId: 'demo-client', credencialOrigem: 'painel', segmentationId: null, segmentationName: null, segmentations: segments, lastFullSyncAt: '2026-10-01T12:00:00.000Z', lastError: null } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: { code: 'DEMO_UNMOCKED', message: 'Endpoint fora do fixture de demonstração' } });
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/leads`, { waitUntil: 'networkidle' });
    await page.getByText('Marina Costa').waitFor();
    await page.evaluate(() => {
      const badge = document.createElement('div');
      badge.textContent = 'DEMONSTRAÇÃO · DADOS FICTÍCIOS';
      Object.assign(badge.style, { position: 'fixed', right: '18px', bottom: '16px', zIndex: '99999', padding: '8px 12px', borderRadius: '6px', background: '#172554', color: 'white', font: '600 12px system-ui', letterSpacing: '.04em', boxShadow: '0 2px 8px #0003' });
      document.body.append(badge);
    });
    await mkdir(dirname(output), { recursive: true });
    await page.screenshot({ path: output, fullPage: false });
    console.log(`Salvo: ${output}`);
  } finally { await browser.close(); }
} finally {
  if (server) { server.kill('SIGTERM'); }
}
