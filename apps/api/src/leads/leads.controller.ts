import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { leadsQuerySchema, type LeadDetail, type LeadFacets, type LeadRow, type LeadsQuery, type Page } from '@rd/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly svc: LeadsService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query(new ZodValidationPipe(leadsQuerySchema)) q: LeadsQuery): Promise<Page<LeadRow>> { return this.svc.list(u.accountId, q); }
  @Get('facets') facets(@CurrentUser() u: AuthUser, @Query(new ZodValidationPipe(leadsQuerySchema)) q: LeadsQuery): Promise<LeadFacets> { return this.svc.facets(u.accountId, q); }
  @Get('export.csv')
  async exportCsv(@CurrentUser() u: AuthUser, @Query(new ZodValidationPipe(leadsQuerySchema)) q: LeadsQuery, @Res() reply: FastifyReply): Promise<void> {
    const csv = await this.svc.exportCsv(u.accountId, q);
    reply.header('Content-Disposition', 'attachment; filename="leads.csv"').type('text/csv; charset=utf-8').send(Readable.from(csv));
  }
  @Get(':id') detail(@CurrentUser() u: AuthUser, @Param('id') id: string): Promise<LeadDetail> { return this.svc.detail(u.accountId, id); }
}
