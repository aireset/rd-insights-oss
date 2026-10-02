import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { RdModule } from '../rd/rd.module';

@Module({ imports: [RdModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
