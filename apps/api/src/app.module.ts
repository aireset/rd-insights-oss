import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.schema';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { HealthController } from './health/health.controller';
import { RdModule } from './rd/rd.module';
import { LeadsModule } from './leads/leads.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { UsersModule } from './users/users.module';
import { AiModule } from './ai/llm/ai.module';
import { ClassificationModule } from './ai/classification/classification.module';
import { TypedChatModule } from './ai/chat/typed-chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, ignoreEnvFile: process.env.NODE_ENV === 'test', envFilePath: ['../../.env', '.env'] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    AuthModule,
    RdModule,
    LeadsModule,
    DashboardModule,
    UsersModule,
    AiModule,
    ClassificationModule,
    TypedChatModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
