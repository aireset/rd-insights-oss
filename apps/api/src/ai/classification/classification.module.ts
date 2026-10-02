import { Module } from '@nestjs/common';
import { ClassificationService } from './classification.service';
import { ClassificationJobs } from './classification-jobs';
import { ClassificationController } from './classification.controller';

@Module({ controllers: [ClassificationController], providers: [ClassificationService, ClassificationJobs] })
export class ClassificationModule {}
