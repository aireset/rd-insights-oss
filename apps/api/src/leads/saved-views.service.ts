import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SavedViewInput, SavedViewView } from '@rd/shared';
import { NotFoundError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string, userId: string): Promise<SavedViewView[]> {
    const views = await this.prisma.savedView.findMany({ where: { accountId, userId }, orderBy: { updatedAt: 'desc' } });
    return views.map((view) => this.toView(view));
  }

  async create(accountId: string, userId: string, input: SavedViewInput): Promise<SavedViewView> {
    const view = await this.prisma.savedView.create({ data: {
      accountId, userId, name: input.name, filters: input.filters as Prisma.InputJsonValue,
    } });
    return this.toView(view);
  }

  async update(accountId: string, userId: string, id: string, input: SavedViewInput): Promise<SavedViewView> {
    const where = { id, accountId, userId };
    const result = await this.prisma.savedView.updateMany({ where, data: {
      name: input.name, filters: input.filters as Prisma.InputJsonValue,
    } });
    if (!result.count) throw new NotFoundError('Visão salva não encontrada');
    const view = await this.prisma.savedView.findFirst({ where });
    if (!view) throw new NotFoundError('Visão salva não encontrada');
    return this.toView(view);
  }

  async remove(accountId: string, userId: string, id: string): Promise<void> {
    const result = await this.prisma.savedView.deleteMany({ where: { id, accountId, userId } });
    if (!result.count) throw new NotFoundError('Visão salva não encontrada');
  }

  private toView(view: { id: string; name: string; filters: Prisma.JsonValue; createdAt: Date; updatedAt: Date }): SavedViewView {
    return { id: view.id, name: view.name, filters: view.filters as Record<string, unknown>, createdAt: view.createdAt.toISOString(), updatedAt: view.updatedAt.toISOString() };
  }
}
