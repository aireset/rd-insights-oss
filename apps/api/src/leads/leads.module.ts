import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { SavedViewsController } from './saved-views.controller';
import { SavedViewsService } from './saved-views.service';
@Module({ controllers: [LeadsController, SavedViewsController], providers: [LeadsService, SavedViewsService], exports: [LeadsService] })
export class LeadsModule {}
