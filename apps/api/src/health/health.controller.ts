import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { RdJobsService } from '../rd/rd-jobs.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly jobs: RdJobsService) {}
  @Public()
  @Get()
  async get(@Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: boolean; db: 'up' | 'down'; redis: 'up' | 'down'; worker: 'running' | 'stopped' }> {
    const [database, queue] = await Promise.allSettled([this.prisma.$queryRaw`SELECT 1`, this.jobs.readiness()]);
    const db = database.status === 'fulfilled' ? 'up' : 'down';
    const redis = queue.status === 'fulfilled' ? queue.value.redis : 'down';
    const worker = queue.status === 'fulfilled' ? queue.value.worker : 'stopped';
    const ok = db === 'up' && redis === 'up' && worker === 'running';
    if (!ok) reply.status(503);
    return { ok, db, redis, worker };
  }
}
