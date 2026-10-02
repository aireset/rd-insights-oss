import assert from 'node:assert/strict';
import { renderMetric } from './daily-insights.service';

const metrics = { baseSize: 0, opportunities: 0, leadsCreated: { current7Days: 0, previous7Days: 0 }, conversions: { current7Days: 3, previous7Days: 0 }, topStage: null };
assert.equal(renderMetric('leads_created', metrics), 'Novos leads: 0 nos últimos 7 dias completos, sem variação frente aos 0 da semana anterior.');
assert.equal(renderMetric('conversions', metrics), 'Eventos de conversão: 3 nos últimos 7 dias completos, aumento de 3 frente aos 0 da semana anterior.');
assert.equal(renderMetric('top_stage', metrics), 'Não há estágio preenchido na base atual.');
